/**
 * Frame runtime artifact tests (REALTIME_EXPERIENCE_MODE_PLAN, RM-4).
 *
 * Two guards around the committed IIFE
 * (`src/generated/experience-frame-runtime.source.ts`):
 *
 * 1. FRESHNESS — re-run the GENERATOR ITSELF as a subprocess in `--check`
 *    mode (build in memory, byte-compare, no write) and assert exit 0. The
 *    artifact must never drift from the source modules: its bytes ARE the
 *    frame-side kernel the RM-8 replay trusts. Spawning the generator (rather
 *    than calling Bun.build in-test) is load-bearing twice over: (a) the
 *    freshness check can never drift from the generator's build options —
 *    there is exactly ONE copy of the bundle config; (b) the generator
 *    subprocess runs under the RUNTIME module resolver, which handles the
 *    workspace-symlink node_modules layout of fresh CI installs — the
 *    Bun.build bundler dereferences the symlink and resolves bare imports
 *    from the real package path, where it cannot find `zod`/
 *    `@vibe-tavern/domain` (oven-sh/bun#31957); that made the in-test variant
 *    fail deterministically on Linux CI while passing on Windows.
 *
 * 2. SMOKE — eval the artifact the way the frame document does (plain script
 *    bytes, no modules) and boot a real round from a config override with
 *    fake drivers, driving events through the CustomEvent surface the SDK
 *    (RM-5) will wrap: the published `__vtFrameRuntime` API exists, the loop
 *    runs, `vt-loop:*` events arrive, and `vt-loop:input` feeds the queue.
 *
 * This file needs a DOM (CustomEvent/listeners) — it registers useDomEnv and
 * therefore runs in its own per-file process (apps/web test runner).
 */
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import { EXPERIENCE_FRAME_RUNTIME_SOURCE } from "../generated/experience-frame-runtime.source.js";
import type { ExperienceFrameRuntimeApi } from "./experience-frame-runtime.entry.js";

useDomEnv();

// ─── freshness ──────────────────────────────────────────────────────────────

describe("frame runtime artifact — freshness", () => {
  test("the committed artifact byte-matches a fresh generator run", async () => {
    // The generator lives at the repo root's scripts/ dir; the test file is at
    // apps/web/src/lib/, so the repo root is four levels up from here.
    const root = resolve(import.meta.dir, "..", "..", "..", "..");
    const child = Bun.spawn(
      [process.execPath, join(root, "scripts", "gen-experience-frame-runtime.ts"), "--check"],
      { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, FORCE_COLOR: "0", NO_COLOR: "1" } },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(`generator --check failed (exit ${exitCode}):\n${stdout}${stderr}`);
    }
    // The subprocess is the byte gate; this assertion documents that the
    // committed constant the smoke test evals is the very artifact checked.
    expect(EXPERIENCE_FRAME_RUNTIME_SOURCE.length).toBeGreaterThan(0);
  }, 120_000);
});

// ─── smoke: eval + boot ────────────────────────────────────────────────────

const TICKER_SCRIPT = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "ticker", name: "Ticker", mode: "realtime", tickMs: 50 },
  capabilities: [],
  create(context, settings) {
    const total = (settings && typeof settings.total === "number") ? settings.total : 1000;
    return { remaining: total, total };
  },
  project(context) { return { remaining: context.state.remaining }; },
  actions() { return [{ type: "drain" }, { type: "poke" }]; },
  reduce(context, action) {
    if (action.type === "drain") return { state: { ...context.state, remaining: 0 }, status: "completed", events: [] };
    if (action.type === "poke") return { state: { ...context.state, pokes: (context.state.pokes || 0) + 1 }, status: "active", events: [] };
    return { state: context.state, status: "active", events: [] };
  },
  update(context, dt) {
    const remaining = context.state.remaining - dt;
    return { state: { ...context.state, remaining: Math.max(0, remaining) }, status: remaining <= 0 ? "completed" : "active", events: [] };
  },
});
`;

describe("frame runtime artifact — eval smoke", () => {
  test("publishes __vtFrameRuntime and boots a round over the CustomEvent surface", () => {
    // Execute the artifact exactly like the frame document: plain script bytes.
    // new Function keeps the eval out of module scope; the IIFE assigns the
    // global, which we read back through the typed twin.
    new Function(EXPERIENCE_FRAME_RUNTIME_SOURCE)();
    const g = globalThis as unknown as { __vtFrameRuntime?: ExperienceFrameRuntimeApi };
    expect(g.__vtFrameRuntime).toBeTruthy();
    const api = g.__vtFrameRuntime;
    if (api === undefined) return;
    expect(api.version).toBe(1);
    expect(typeof api.bootFromDocument).toBe("function");
    // The kernel surface is live inside the bundle too (spot check).
    const discovery = api.discoverExperienceDefinition(TICKER_SCRIPT);
    expect(discovery.ok).toBe(true);
    if (discovery.ok) expect(discovery.definition.hasUpdate).toBe(true);

    // Fake clock drivers; collect the CustomEvent traffic the SDK will see.
    let t = 0;
    // Holder object: a plain `let` assigned only inside the requestFrame
    // closure narrows to null at the call sites under TS control-flow analysis.
    const frame: { cb: ((now: number) => void) | null } = { cb: null };
    const drivers = {
      requestFrame: (cb: (now: number) => void) => {
        frame.cb = cb;
      },
      now: () => t,
    };
    const seen: Array<{ type: string; detail: unknown }> = [];
    const onEvent = (e: Event): void => {
      seen.push({ type: e.type, detail: (e as CustomEvent).detail });
    };
    window.addEventListener("vt-loop:event", onEvent);
    window.addEventListener("vt-loop:view", onEvent);
    window.addEventListener("vt-loop:finish", onEvent);
    window.addEventListener("vt-loop:drop", onEvent);

    api.bootFromDocument({
      drivers,
      config: {
        rulesSource: TICKER_SCRIPT,
        tickMs: 50,
        initialState: { remaining: 1000, total: 1000 },
        seed: 42,
        viewer: { kind: "human", participantId: "p1" },
        scriptSeats: [],
      },
    });

    expect(seen[0]?.type).toBe("vt-loop:event");
    expect(seen[0]?.detail).toEqual({ kind: "round_started", seed: 42, settings: null });

    // Drive two frames of 50ms: two ticks, a view per frame.
    t += 50;
    frame.cb?.(t);
    t += 50;
    frame.cb?.(t);
    expect(seen.filter((s) => s.type === "vt-loop:view").length).toBe(2);
    const lastView = seen.filter((s) => s.type === "vt-loop:view").at(-1)?.detail;
    expect(lastView).toEqual({ remaining: 900 });

    // The input channel enqueues through the same surface (RM-5's actLocal).
    window.dispatchEvent(
      new CustomEvent("vt-loop:input", { detail: { type: "poke", participantId: "p1" } }),
    );
    t += 50;
    frame.cb?.(t); // tick: update, then the queued poke (non-completing)
    const lastView2 = seen.filter((s) => s.type === "vt-loop:view").at(-1)?.detail;
    expect((lastView2 as { remaining: number }).remaining).toBe(850);
    const inputEvent = seen
      .filter((s) => s.type === "vt-loop:event")
      .map((s) => s.detail as { kind: string })
      .find((e) => e.kind === "input");
    expect(inputEvent).toBeTruthy();

    // The model channel round-trips through the loop log (RM-5). "m9" is not
    // a declared model seat → the request is rejected at the door.
    window.dispatchEvent(
      new CustomEvent("vt-loop:model-request", { detail: { seatId: "m9", prompt: { q: "hi" }, requestId: "rq-1" } }),
    );
    t += 50;
    frame.cb?.(t);
    const logKinds = seen
      .filter((s) => s.type === "vt-loop:event")
      .map((s) => s.detail as { kind: string })
      .map((e) => e.kind);
    expect(logKinds).not.toContain("model_request");
    expect(seen.some((s) => s.type === "vt-loop:drop")).toBe(true);

    // The visual-driven finish: finish-request carries score/summary onto the
    // finish payload and ends the round at a tick boundary.
    window.dispatchEvent(
      new CustomEvent("vt-loop:finish-request", {
        detail: { status: "completed", score: 1500, summary: "done early" },
      }),
    );
    const finish = seen.find((s) => s.type === "vt-loop:finish");
    expect(finish).toBeTruthy();
    const detail = finish?.detail as {
      status: string;
      finalState: { remaining: number; pokes?: number };
      score?: number;
      summary?: string;
      log: Array<{ kind: string; status?: string }>;
    };
    expect(detail.status).toBe("completed");
    expect(detail.score).toBe(1500);
    expect(detail.summary).toBe("done early");
    expect(detail.finalState.remaining).toBe(800); // stopped at the boundary, not drained
    expect(detail.log.map((e) => e.kind)).toEqual([
      "round_started",
      "ticks",
      "input",
      "ticks",
      "round_finished",
    ]);
    expect(detail.log.at(-1)?.status).toBe("completed");

    // Boot is idempotent (a double boot line must not start a second loop).
    api.bootFromDocument({ drivers, config: { rulesSource: TICKER_SCRIPT, tickMs: 50, initialState: { remaining: 5, total: 5 }, seed: 1, viewer: { kind: "human", participantId: "p1" }, scriptSeats: [] } });
    const eventCount = seen.length;
    t += 50;
    frame.cb?.(t);
    expect(seen.length).toBe(eventCount); // no second loop emitted anything
  });
});

// ─── default-drivers boot (RM-12c regression) ──────────────────────────────
// The eval-smoke tests above always inject fake drivers, so the DEFAULT
// driver branch of bootFromDocument (the only branch the real frame document
// executes) had zero coverage — and it shipped a detached native rAF that
// Chromium rejects with "Illegal invocation" on the very first frame request
// (happy-dom tolerates the lost receiver, which is exactly why the gap was
// invisible). These tests boot the committed artifact with NO driver
// overrides, against a Chrome-like rAF stub that validates its receiver.
describe("frame runtime artifact — default-drivers boot", () => {
  type FrameGlobal = {
    __vtFrameRuntime?: ExperienceFrameRuntimeApi;
    __vtLoopBooted?: boolean;
    __vtLoopHandle?: { stop(): void };
    requestAnimationFrame?: (cb: (now: number) => void) => void;
  };
  const fg = globalThis as unknown as FrameGlobal;

  /** Eval the artifact if a filtered run skipped the smoke block above. */
  function ensureRuntime(): ExperienceFrameRuntimeApi {
    if (fg.__vtFrameRuntime === undefined) new Function(EXPERIENCE_FRAME_RUNTIME_SOURCE)();
    const api = fg.__vtFrameRuntime;
    if (api === undefined) throw new Error("artifact eval did not publish __vtFrameRuntime");
    return api;
  }

  /** Drop any loop + config tag left by earlier tests in this process. */
  function resetBootState(): void {
    fg.__vtLoopHandle?.stop();
    fg.__vtLoopBooted = false;
    fg.__vtLoopHandle = undefined;
    document.getElementById("__vt_round_config")?.remove();
  }

  function installConfigTag(): void {
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.id = "__vt_round_config";
    tag.textContent = JSON.stringify({
      rulesSource: TICKER_SCRIPT,
      tickMs: 50,
      initialState: { remaining: 1000, total: 1000 },
      seed: 7,
      viewer: { kind: "human", participantId: "p1" },
      scriptSeats: [],
    });
    document.head.append(tag);
  }

  test("missing config tag dispatches vt-loop:error and leaves boot retryable", () => {
    resetBootState();
    const api = ensureRuntime();
    const errors: Array<{ kind: string; message: string }> = [];
    const started: unknown[] = [];
    const onError = (e: Event): void => {
      errors.push((e as CustomEvent).detail as { kind: string; message: string });
    };
    const onEvent = (e: Event): void => {
      const d = (e as CustomEvent).detail as { kind?: string } | null;
      if (d !== null && typeof d === "object" && d.kind === "round_started") started.push(d);
    };
    window.addEventListener("vt-loop:error", onError);
    window.addEventListener("vt-loop:event", onEvent);

    api.bootFromDocument(); // no opts, no #__vt_round_config in the document
    expect(errors).toEqual([
      { kind: "boot_failed", message: expect.stringContaining("__vt_round_config") },
    ]);
    expect(fg.__vtLoopBooted).toBeFalsy(); // a fixed host can retry the boot

    // The retry: install the config tag the real frame document ships and
    // boot again — this time round_started must arrive.
    installConfigTag();
    api.bootFromDocument();
    expect(errors).toHaveLength(1); // no new error
    expect(started).toHaveLength(1);
    expect(fg.__vtLoopBooted).toBe(true);

    window.removeEventListener("vt-loop:error", onError);
    window.removeEventListener("vt-loop:event", onEvent);
    resetBootState();
  });

  test("default drivers bind native rAF to the window — no Illegal invocation", () => {
    resetBootState();
    const api = ensureRuntime();
    installConfigTag();

    // Chrome-like rAF: the native is receiver-sensitive — a detached call
    // (this === undefined in strict mode) is what Chromium rejects. Record
    // every receiver so the regression pins WHAT the loop actually calls.
    const receivers: unknown[] = [];
    const driven: Array<(now: number) => void> = [];
    const chromeLike = function (this: unknown, cb: (now: number) => void): void {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      receivers.push(this);
      driven.push(cb);
    };
    const original = fg.requestAnimationFrame;
    fg.requestAnimationFrame = chromeLike;

    const views: Array<{ remaining: number }> = [];
    const errors: Array<{ kind: string; message: string }> = [];
    const onView = (e: Event): void => {
      views.push((e as CustomEvent).detail as { remaining: number });
    };
    const onError = (e: Event): void => {
      errors.push((e as CustomEvent).detail as { kind: string; message: string });
    };
    window.addEventListener("vt-loop:view", onView);
    window.addEventListener("vt-loop:error", onError);

    try {
      api.bootFromDocument(); // NO opts: default drivers + tag-parsed config
      expect(receivers).toHaveLength(1); // the loop's synchronous first request
      expect(receivers[0]).toBe(globalThis); // receiver preserved, not detached
      expect(driven.length).toBe(1);

      // Frame 1 at a far-future rAF timestamp: delta clamps to 250ms
      // (EXPERIENCE_LOOP_MAX_FRAME_DELTA_MS) → 5 catchup ticks of 50ms.
      driven[0]?.(1_000_000_000);
      expect(views.at(-1)).toEqual({ remaining: 750 });
      expect(receivers).toHaveLength(2); // frame re-requested, still bound

      // Frame 2 exactly 50ms later: one tick.
      driven[1]?.(1_000_000_050);
      expect(views.at(-1)).toEqual({ remaining: 700 });

      expect(errors).toEqual([]); // pre-fix symptom: boot_failed "Illegal invocation"
      expect(fg.__vtLoopBooted).toBe(true);
    } finally {
      fg.requestAnimationFrame = original;
      window.removeEventListener("vt-loop:view", onView);
      window.removeEventListener("vt-loop:error", onError);
      resetBootState();
    }
  });
});
