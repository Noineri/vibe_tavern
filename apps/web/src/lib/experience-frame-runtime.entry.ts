/**
 * IIFE ENTRY for the realtime frame runtime bundle (REALTIME_EXPERIENCE_MODE_PLAN, RM-4).
 *
 * This module is the single entry `scripts/gen-experience-frame-runtime.ts`
 * bundles (Bun.build, format iife, target browser, minified) into
 * `apps/web/src/generated/experience-frame-runtime.source.ts` — a committed,
 * test-guarded string module that ExperienceFrame embeds into the REALTIME
 * frame document (the turn-based document embeds nothing of this). Inside the
 * frame it publishes `globalThis.__vtFrameRuntime` with:
 *
 *   - the full RM-3 kernel-port surface (discover/runCreate/runProject/
 *     runActions/runReduce/runUpdate/runChoose/runFlavor/validateSubmittedAction
 *     + the PRNG factories) — same code the bun:test suites pin, no
 *     frame-side twin;
 *   - `startExperienceLoopHost` — the fixed-timestep loop;
 *   - `bootFromDocument(opts?)` — the frame-side assembly: reads the
 *     `#__vt_round_config` JSON tag, starts the loop with the frame's real
 *     rAF/performance drivers, and bridges both directions over window
 *     CustomEvents, which the SDK (RM-5) wraps into `actLocal`/`onTick`/
 *     `finishRound`:
 *       dispatch: vt-loop:view | vt-loop:event | vt-loop:drop | vt-loop:error | vt-loop:finish
 *       listen:   vt-loop:input {type, participantId?, payload?} | vt-loop:stop | vt-loop:state |
 *                 vt-loop:model-request {seatId, prompt, requestId?} |
 *                 vt-loop:model-result {seatId, result, requestId?} |
 *                 vt-loop:finish-request {status?, score?, summary?}
 *
 * Determinism note: everything replay-relevant (rules execution, the round
 * cursor, the log) lives in this bundle; the host document only supplies DATA
 * (rules source, seed, config JSON), so the bytes of this artifact are part of
 * the platform contract — the freshness test regenerates and byte-compares it.
 */
import { createDeterministicRandom, createEphemeralRandom } from "@vibe-tavern/domain";
import {
  discoverExperienceDefinition,
  runActions,
  runChoose,
  runCreate,
  runFlavor,
  runProject,
  runReduce,
  runUpdate,
  validateSubmittedAction,
} from "./experience-kernel-frame.js";
import {
  startExperienceLoopHost,
  type ExperienceLoopConfig,
  type ExperienceLoopDrivers,
  type ExperienceLoopEvent,
} from "./experience-loop-host.js";

/** The frame-side contract this entry publishes (typed twin of the IIFE global). */
export interface ExperienceFrameRuntimeApi {
  readonly version: 1;
  readonly discoverExperienceDefinition: typeof discoverExperienceDefinition;
  readonly runCreate: typeof runCreate;
  readonly runProject: typeof runProject;
  readonly runActions: typeof runActions;
  readonly runReduce: typeof runReduce;
  readonly runUpdate: typeof runUpdate;
  readonly runChoose: typeof runChoose;
  readonly runFlavor: typeof runFlavor;
  readonly validateSubmittedAction: typeof validateSubmittedAction;
  readonly createDeterministicRandom: typeof createDeterministicRandom;
  readonly createEphemeralRandom: typeof createEphemeralRandom;
  readonly startExperienceLoopHost: typeof startExperienceLoopHost;
  /** Read `#__vt_round_config` and run the loop. Idempotent on success; a
   *  failed boot dispatches `vt-loop:error {kind:"boot_failed"}` and leaves
   *  itself re-bootable. */
  readonly bootFromDocument: (opts?: BootOptions) => void;
}

export interface BootOptions {
  /** Driver overrides (tests drive fake time); default: rAF + performance.now. */
  readonly drivers?: ExperienceLoopDrivers;
  /** Config override (tests); default: parsed from the `#__vt_round_config` tag. */
  readonly config?: ExperienceLoopConfig;
}

function bootFromDocument(opts: BootOptions = {}): void {
  const win = globalThis as unknown as {
    __vtLoopBooted?: boolean;
    __vtLoopHandle?: {
      enqueueInput(i: { type: string }): void;
      stop(): void;
      getState(): unknown;
      requestModel(seatId: string, prompt: unknown, requestId?: string): boolean;
      applyModelResult(seatId: string, result: unknown, requestId?: string): boolean;
      finishNow(claim?: { status?: "completed" | "interrupted"; score?: unknown; summary?: unknown }): boolean;
    };
    dispatchEvent?: (e: unknown) => boolean;
    addEventListener?: (type: string, cb: (e: { detail: unknown }) => void) => void;
    requestAnimationFrame?: (cb: (now: number) => void) => void;
    performance?: { now(): number };
    document?: { getElementById(id: string): { textContent: string | null } | null };
  };
  if (win.__vtLoopBooted) return;

  const dispatch = (type: string, detail: unknown): void => {
    // CustomEvent is constructed defensively: the eval-harness test may boot
    // without a full DOM (a missing constructor drops the event instead of
    // killing the loop).
    const ctor = (globalThis as unknown as { CustomEvent?: new (t: string, d: { detail: unknown }) => unknown })
      .CustomEvent;
    if (ctor && typeof win.dispatchEvent === "function") {
      win.dispatchEvent(new ctor(type, { detail }));
    }
  };

  // Boot is all-or-nothing: a failure (missing config tag, unavailable rAF,
  // malformed config JSON) dispatches vt-loop:error {kind:"boot_failed"} so
  // the SDK can surface it in the visual instead of a silently dead frame,
  // and leaves the boot flag DOWN so a fixed host document can retry booting.
  let handle: ReturnType<typeof startExperienceLoopHost>;
  try {
    const config: ExperienceLoopConfig =
      opts.config ??
      (() => {
        const tag = win.document?.getElementById("__vt_round_config");
        if (!tag || tag.textContent === null) {
          throw new Error("realtime frame runtime: #__vt_round_config not found");
        }
        return JSON.parse(tag.textContent) as ExperienceLoopConfig;
      })();

    const drivers: ExperienceLoopDrivers =
      opts.drivers ??
      (() => {
        const raf = win.requestAnimationFrame;
        const perf = win.performance;
        if (typeof raf !== "function" || !perf || typeof perf.now !== "function") {
          throw new Error("realtime frame runtime: rAF/performance unavailable");
        }
        // The bare native rAF is receiver-sensitive: destructured off the
        // window and invoked as a plain driver value, Chromium throws
        // "Illegal invocation" on the very first frame request (happy-dom's
        // rAF tolerates it, which is why fake-driver tests never saw this).
        // Wrap it so the window receiver is restored on every call.
        return {
          requestFrame: (cb: (now: number) => void) => raf.call(win, cb),
          now: () => perf.now(),
        };
      })();

    handle = startExperienceLoopHost(
      config,
      {
        onEvent: (event: ExperienceLoopEvent) => dispatch("vt-loop:event", event),
        onView: (view: unknown) => dispatch("vt-loop:view", view),
        onDrop: (reason: string) => dispatch("vt-loop:drop", reason),
        onError: (error: { kind: string; message: string }) => dispatch("vt-loop:error", error),
        onFinish: (result: unknown) => dispatch("vt-loop:finish", result),
      },
      drivers,
    );
  } catch (err) {
    dispatch("vt-loop:error", {
      kind: "boot_failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  win.__vtLoopBooted = true;
  win.__vtLoopHandle = handle;

  if (typeof win.addEventListener === "function") {
    win.addEventListener("vt-loop:input", (e) => {
      const input = e.detail as { type?: unknown } | null;
      if (input !== null && typeof input === "object" && typeof input.type === "string") {
        handle.enqueueInput(input as { type: string });
      }
    });
    win.addEventListener("vt-loop:stop", () => handle.stop());
    win.addEventListener("vt-loop:model-request", (e) => {
      const d = e.detail as { seatId?: unknown; prompt?: unknown; requestId?: unknown } | null;
      if (d !== null && typeof d === "object" && typeof d.seatId === "string") {
        handle.requestModel(
          d.seatId,
          d.prompt,
          typeof d.requestId === "string" ? d.requestId : undefined,
        );
      }
    });
    win.addEventListener("vt-loop:model-result", (e) => {
      const d = e.detail as { seatId?: unknown; result?: unknown; requestId?: unknown } | null;
      if (d !== null && typeof d === "object" && typeof d.seatId === "string") {
        handle.applyModelResult(
          d.seatId,
          d.result,
          typeof d.requestId === "string" ? d.requestId : undefined,
        );
      }
    });
    win.addEventListener("vt-loop:finish-request", (e) => {
      const d = e.detail as
        | { status?: unknown; score?: unknown; summary?: unknown }
        | null;
      if (d === null || typeof d !== "object") {
        handle.finishNow();
        return;
      }
      handle.finishNow({
        ...(d.status === "interrupted" || d.status === "completed" ? { status: d.status } : {}),
        ...(d.score !== undefined ? { score: d.score } : {}),
        ...(d.summary !== undefined ? { summary: d.summary } : {}),
      });
    });
    win.addEventListener("vt-loop:state", (e) => {
      const detail = e.detail as { onState?: (s: unknown) => void } | null;
      if (detail !== null && typeof detail === "object" && typeof detail.onState === "function") {
        detail.onState(handle.getState());
      }
    });
  }
}

const api: ExperienceFrameRuntimeApi = {
  version: 1,
  discoverExperienceDefinition,
  runCreate,
  runProject,
  runActions,
  runReduce,
  runUpdate,
  runChoose,
  runFlavor,
  validateSubmittedAction,
  createDeterministicRandom,
  createEphemeralRandom,
  startExperienceLoopHost,
  bootFromDocument,
};

(globalThis as unknown as { __vtFrameRuntime?: ExperienceFrameRuntimeApi }).__vtFrameRuntime = api;
