/**
 * Frame runtime artifact tests (REALTIME_EXPERIENCE_MODE_PLAN, RM-4).
 *
 * Two guards around the committed IIFE
 * (`src/generated/experience-frame-runtime.source.ts`):
 *
 * 1. FRESHNESS — re-run the exact generator bundle (same entry, same options)
 *    and byte-compare. The artifact must never drift from the source modules:
 *    its bytes ARE the frame-side kernel the RM-8 replay trusts. A mismatch
 *    fails with the regeneration instruction (run it after touching the
 *    entry's import graph or after a Bun upgrade shifts the minifier).
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
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import { EXPERIENCE_FRAME_RUNTIME_SOURCE } from "../generated/experience-frame-runtime.source.js";
import type { ExperienceFrameRuntimeApi } from "./experience-frame-runtime.entry.js";

useDomEnv();

// ─── freshness ──────────────────────────────────────────────────────────────

describe("frame runtime artifact — freshness", () => {
  test("the committed artifact byte-matches a fresh generator run", async () => {
    const webDir = join(import.meta.dir, "..", "..");
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "experience-frame-runtime.entry.ts")],
      target: "browser",
      format: "iife",
      minify: true,
      tsconfig: join(webDir, "tsconfig.json"),
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      return;
    }
    const fresh = await result.outputs[0].text();
    if (fresh !== EXPERIENCE_FRAME_RUNTIME_SOURCE) {
      throw new Error(
        "experience-frame-runtime.source.ts is STALE: the committed IIFE does not match a fresh build of experience-frame-runtime.entry.ts. " +
          "Regenerate with: bun run gen:experience-frame-runtime",
      );
    }
  }, 60_000);
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
  actions() { return [{ type: "drain" }]; },
  reduce(context, action) {
    if (action.type === "drain") return { state: { ...context.state, remaining: 0 }, status: "completed", events: [] };
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
      new CustomEvent("vt-loop:input", { detail: { type: "drain", participantId: "p1" } }),
    );
    t += 50;
    frame.cb?.(t); // tick: update (950→? ordering: update first, then the queued drain)
    const finish = seen.find((s) => s.type === "vt-loop:finish");
    expect(finish).toBeTruthy();
    const detail = finish?.detail as { status: string; finalState: unknown; log: Array<{ kind: string }> };
    expect(detail.status).toBe("completed");
    expect(detail.finalState).toEqual({ remaining: 0, total: 1000 });
    expect(detail.log.map((e) => e.kind)).toEqual(["round_started", "ticks", "input", "round_finished"]);

    // Boot is idempotent (a double boot line must not start a second loop).
    api.bootFromDocument({ drivers, config: { rulesSource: TICKER_SCRIPT, tickMs: 50, initialState: { remaining: 5, total: 5 }, seed: 1, viewer: { kind: "human", participantId: "p1" }, scriptSeats: [] } });
    const eventCount = seen.length;
    t += 50;
    frame.cb?.(t);
    expect(seen.length).toBe(eventCount); // no second loop emitted anything
  });
});
