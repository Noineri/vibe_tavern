/**
 * The realtime experience LOOP HOST (REALTIME_EXPERIENCE_MODE_PLAN, RM-4).
 *
 * Frame-side fixed-timestep game loop that drives the RM-3 kernel port inside
 * the sandboxed experience iframe. Pure TypeScript with INJECTABLE drivers
 * (rAF + clock) and callbacks — unit-testable in bun:test with fake time, and
 * bundled verbatim into the frame runtime IIFE (see
 * experience-frame-runtime.entry.ts) where the drivers are the frame's real
 * `requestAnimationFrame`/`performance.now`.
 *
 * Loop contract (the plan's wave-2 wording, made precise):
 *   - Fixed timestep: an accumulator over the frame clock drains `tick()`
 *     while `acc >= tickMs`; each tick advances EXACTLY `tickMs` of game time.
 *   - tick order (pinned by tests, mirrored by the RM-8 server replay):
 *       1. `update(context, dt = tickMs)` — only when the package defines it;
 *       2. legality-checked `reduce` for queued human inputs (bounded);
 *       3. `choose`-driven `reduce` for script seats (bounded: one move per
 *          seat per tick).
 *   - Deterministic replay or no commit: `update` and `reduce` draw from ONE
 *     round cursor (`createDeterministicRandom(seed)`, consumed in call
 *     order); `choose`/legality draws come from the EPHEMERAL `chance` surface
 *     (or nothing at all), never the round cursor. The round log — the ordered
 *     event list this host emits — is the ONLY thing RM-8 needs to reproduce
 *     the final state bit-identically: same seed + same log ⇒ same state.
 *
 * The log batches tick counts (`ticks {count}`) instead of one event per tick:
 * a 60fps round must not produce an 18k-event log. A batch flushes before
 * every mutation event (input / script_move / round_finished) so the log
 * interleaves time and moves in application order, and periodically so a
 * long quiet stretch still commits bounded batches.
 *
 * Author-declared transition `events` are deliberately DROPPED in realtime
 * mode: they are per-transition feedback the author can surface through
 * `project()` themselves, and logging them at tick rate would explode the
 * bounded log. The round log carries only the replay vocabulary.
 *
 * Bounds (host-side discipline — the kernel validates, the loop enforces
 * pacing): input queue depth, inputs applied per tick, catch-up ticks per
 * frame (tab-switch clamp), total round ticks (the frame-side watchdog — a
 * browser cannot interrupt a hung tick, but it CAN refuse tick #100001).
 */
import {
  discoverExperienceDefinition,
  runActions,
  runChoose,
  runProject,
  runReduce,
  runUpdate,
  validateSubmittedAction,
  type ExperienceActionDescriptor,
  type ExperienceCapabilityContext,
  type ExperienceDefinition,
  type ExperienceViewer,
} from "./experience-kernel-frame.js";
import { createDeterministicRandom, createEphemeralRandom } from "@vibe-tavern/domain";

/** Bounded input queue — an enqueued action beyond this is dropped (newest loses). */
export const EXPERIENCE_LOOP_MAX_INPUT_QUEUE = 8;
/** Bounded inputs applied per tick — protects the tick time budget. */
export const EXPERIENCE_LOOP_MAX_INPUTS_PER_TICK = 4;
/**
 * Tab-switch clamp: at most this many catch-up ticks per animation frame. A
 * larger accumulated deficit is DISCARDED (the accumulator resets into the
 * current tick window) — wall-clock time is best-effort, the log is truth.
 */
export const EXPERIENCE_LOOP_MAX_CATCHUP_TICKS_PER_FRAME = 5;
/**
 * Frame-side round watchdog: a round exceeding this many total ticks dies
 * (fatal error, NO finish, nothing committed). At 60fps this is ~28 minutes;
 * hosts may lower it via config.
 */
export const EXPERIENCE_LOOP_MAX_ROUND_TICKS = 100_000;
/** Batched-ticks flush threshold — keeps a quiet round's batches bounded too. */
export const EXPERIENCE_LOOP_MAX_BATCHED_TICKS = 1_000;
/** Frame-delta clamp (ms) feeding the accumulator — bounds the catch-up spiral. */
export const EXPERIENCE_LOOP_MAX_FRAME_DELTA_MS = 250;

/** A raw visual-submitted intention (RM-5's `actLocal` payload). */
export interface ExperienceLoopInput {
  readonly type: string;
  readonly participantId?: string;
  readonly payload?: unknown;
}

/**
 * The round log vocabulary (the plan's wave-3 event list + the `ticks` batch).
 * `model_request`/`model_result` are carried by the union so later waves log
 * them verbatim; the RM-4 loop itself never emits them.
 */
export type ExperienceLoopEvent =
  | { readonly kind: "round_started"; readonly seed: number; readonly settings: unknown }
  | { readonly kind: "ticks"; readonly count: number }
  | { readonly kind: "input"; readonly action: ExperienceLoopLoggedAction }
  | { readonly kind: "script_move"; readonly participantId: string; readonly action: ExperienceLoopLoggedAction }
  | {
      readonly kind: "model_request";
      readonly seatId: string;
      readonly prompt: unknown;
    }
  | { readonly kind: "model_result"; readonly seatId: string; readonly result: unknown }
  | { readonly kind: "round_finished"; readonly status: "completed" };

/**
 * A reduce application recorded in the log. The kernel's `experienceActionSchema`
 * requires the idempotency/CAS pair, so the loop synthesizes inert values
 * (`requestId` is unique per application purely for diagnostics;
 * `expectedRevision` is a frame-local monotone counter) — replay re-applies
 * reduce VERBATIM from the log, and neither field influences state.
 */
export interface ExperienceLoopLoggedAction {
  readonly type: string;
  readonly participantId?: string;
  readonly payload?: unknown;
  readonly requestId: string;
  readonly expectedRevision: number;
}

/** Loop configuration — the realtime halves of what the host embeds in the doc. */
export interface ExperienceLoopConfig {
  /** The author's rules source (executed via the port, inside the frame). */
  readonly rulesSource: string;
  /** Fixed timestep in ms (the manifest `tickMs`; 16..1000 per contracts). */
  readonly tickMs: number;
  /** Starting state (the authoritative create output; replay re-runs create itself). */
  readonly initialState: unknown;
  /** Settings echoed into `round_started` (replay re-derives create from the session). */
  readonly initialSettings?: unknown;
  /** Deterministic round cursor seed — the replay lifeline. */
  readonly seed: number;
  /** The human seat's viewer (input legality + projection). */
  readonly viewer: ExperienceViewer;
  /** Script seats driven by `choose` (one move attempt per seat per tick). */
  readonly scriptSeats: readonly ExperienceViewer[];
  /** Participants surface granted when the package declares the capability. */
  readonly participants?: readonly {
    readonly id: string;
    readonly label: string;
    readonly controller: "human" | "script" | "model";
  }[];
  /** Watchdog override (total ticks); defaults to EXPERIENCE_LOOP_MAX_ROUND_TICKS. */
  readonly maxRoundTicks?: number;
}

export interface ExperienceLoopCallbacks {
  /** Every round-log event, in application order (the RM-8 replay input). */
  readonly onEvent: (event: ExperienceLoopEvent) => void;
  /** Projected view for the human seat, once per animation frame after ticks. */
  readonly onView: (view: unknown) => void;
  /** Non-fatal diagnostics: dropped inputs / illegal script moves. */
  readonly onDrop: (reason: string) => void;
  /**
   * Fatal: the round dies uncommitted (kernel error, watchdog, broken
   * actions/project). No `onFinish` follows a fatal error.
   */
  readonly onError: (error: { readonly kind: string; readonly message: string }) => void;
  /** Exactly once, when a transition completes the round: the commit payload. */
  readonly onFinish: (result: ExperienceLoopFinish) => void;
}

export interface ExperienceLoopFinish {
  readonly status: "completed";
  readonly finalState: unknown;
  readonly log: readonly ExperienceLoopEvent[];
}

/** Injectable frame drivers (browser: rAF + performance.now; tests: fakes). */
export interface ExperienceLoopDrivers {
  readonly requestFrame: (cb: (now: number) => void) => void;
  readonly now: () => number;
}

export interface ExperienceLoopHandle {
  /** Queue a human intention for the next tick (bounded; newest dropped when full). */
  readonly enqueueInput: (input: ExperienceLoopInput) => void;
  /** Current authoritative state (diagnostics / host panels). */
  readonly getState: () => unknown;
  /** Stop without finishing (host teardown — a stopped round is lost, by design). */
  readonly stop: () => void;
}

/**
 * Start the loop host. Discovery failures are fatal and reported synchronously
 * through `onError` (the returned handle is inert). Never throws: every author
 * failure surfaces through the callbacks so the host can render it.
 */
export function startExperienceLoopHost(
  config: ExperienceLoopConfig,
  callbacks: ExperienceLoopCallbacks,
  drivers: ExperienceLoopDrivers,
): ExperienceLoopHandle {
  const maxRoundTicks = config.maxRoundTicks ?? EXPERIENCE_LOOP_MAX_ROUND_TICKS;

  // ── round state ───────────────────────────────────────────────────────────
  const cursor = createDeterministicRandom(config.seed);
  const chance = createEphemeralRandom();
  const inputQueue: ExperienceLoopInput[] = [];
  const log: ExperienceLoopEvent[] = [];
  let state: unknown = config.initialState;
  let revision = 0;
  let tickNo = 0;
  let pendingTicks = 0;
  let requestSeq = 0;
  let stopped = false;
  let finished = false;

  // ── discovery (once; failure is fatal) ────────────────────────────────────
  const discovery = discoverExperienceDefinition(config.rulesSource);
  if (!discovery.ok) {
    callbacks.onError({ kind: discovery.kind, message: discovery.message });
    return deadHandle();
  }
  const definition: ExperienceDefinition = discovery.definition;

  // ── capability surfaces ───────────────────────────────────────────────────
  // update/reduce share the ROUND CURSOR (consumed in call order — the replay
  // lifeline). Legality (`actions`) and `choose` never touch it: actions is
  // called with participants only (legality must be a pure function of state —
  // this is what lets the RM-8 replay skip actions() entirely), choose gets
  // the ephemeral chance surface only.
  const tickCaps = (): ExperienceCapabilityContext =>
    config.participants ? { random: cursor, participants: [...config.participants] } : { random: cursor };
  const legalityCaps = (): ExperienceCapabilityContext =>
    config.participants ? { participants: [...config.participants] } : {};
  const chooseCaps = (): ExperienceCapabilityContext =>
    config.participants ? { chance, participants: [...config.participants] } : { chance };

  // ── log helpers ───────────────────────────────────────────────────────────
  function flushTicks(): void {
    if (pendingTicks > 0) {
      log.push({ kind: "ticks", count: pendingTicks });
      callbacks.onEvent({ kind: "ticks", count: pendingTicks });
      pendingTicks = 0;
    }
  }

  function emit(event: ExperienceLoopEvent): void {
    log.push(event);
    callbacks.onEvent(event);
  }

  // ── fatal / finish ────────────────────────────────────────────────────────
  function fatal(kind: string, message: string): void {
    if (stopped || finished) return;
    stopped = true;
    callbacks.onError({ kind, message });
  }

  function finishRound(): void {
    if (stopped || finished) return;
    finished = true;
    stopped = true;
    flushTicks();
    emit({ kind: "round_finished", status: "completed" });
    callbacks.onFinish({ status: "completed", finalState: state, log });
  }

  // ── reduce application (input + script_move share the shape) ─────────────
  function applyAction(
    action: ExperienceLoopLoggedAction,
    event:
      | { kind: "input"; action: ExperienceLoopLoggedAction }
      | { kind: "script_move"; participantId: string; action: ExperienceLoopLoggedAction },
  ): boolean {
    const transition = runReduce(config.rulesSource, state, action, tickCaps());
    if (!transition.ok) {
      fatal(transition.kind, transition.message);
      return false;
    }
    state = transition.value.state;
    revision += 1;
    flushTicks();
    emit(event);
    if (transition.value.status === "completed") {
      finishRound();
      return false;
    }
    return true;
  }

  /** Full action synthesis: the kernel schema demands requestId/expectedRevision. */
  function synthAction(input: ExperienceLoopInput): ExperienceLoopLoggedAction {
    requestSeq += 1;
    return {
      type: input.type,
      ...(input.participantId !== undefined ? { participantId: input.participantId } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      requestId: `loop-${tickNo}-${requestSeq}`,
      expectedRevision: revision,
    };
  }

  // ── the tick ──────────────────────────────────────────────────────────────
  function tick(): void {
    tickNo += 1;
    if (tickNo > maxRoundTicks) {
      fatal("watchdog", `round exceeded ${String(maxRoundTicks)} ticks`);
      return;
    }

    // 1. time advance
    if (definition.hasUpdate) {
      const transition = runUpdate(config.rulesSource, state, config.tickMs, tickCaps());
      if (!transition.ok) {
        fatal(transition.kind, transition.message);
        return;
      }
      state = transition.value.state;
      revision += 1;
      pendingTicks += 1;
      if (pendingTicks >= EXPERIENCE_LOOP_MAX_BATCHED_TICKS) flushTicks();
      if (transition.value.status === "completed") {
        finishRound();
        return;
      }
    }

    // 2. queued human inputs (bounded)
    let applied = 0;
    while (inputQueue.length > 0 && applied < EXPERIENCE_LOOP_MAX_INPUTS_PER_TICK && !stopped && !finished) {
      const input = inputQueue.shift();
      if (input === undefined) break;
      const legal = runActions(config.rulesSource, state, config.viewer, legalityCaps());
      if (!legal.ok) {
        fatal(legal.kind, legal.message);
        return;
      }
      const action = synthAction(input);
      const check = validateSubmittedAction(action, legal.value);
      if (!check.ok) {
        callbacks.onDrop(`input "${input.type}" dropped: ${check.message}`);
        continue;
      }
      if (!applyAction(action, { kind: "input", action })) return;
      applied += 1;
    }

    // 3. script seats (bounded: one choose per seat per tick)
    for (const seat of config.scriptSeats) {
      if (stopped || finished) return;
      const legal = runActions(config.rulesSource, state, seat, legalityCaps());
      if (!legal.ok) {
        fatal(legal.kind, legal.message);
        return;
      }
      const chosen = runChoose(config.rulesSource, state, seat, legal.value, chooseCaps());
      if (!chosen.ok) {
        if (chosen.kind === "illegal_action") {
          // A seat ATTEMPTING an illegal move is a normal gameplay outcome
          // (choose may aim outside the legal set): drop the move, keep the
          // round. Anything else (author crash, async return…) is fatal.
          callbacks.onDrop(`script seat ${seat.participantId ?? "script"} move rejected: ${chosen.message}`);
          continue;
        }
        fatal(chosen.kind, chosen.message);
        return;
      }
      const intent = chosen.value;
      const participantId = seat.participantId ?? intent.participantId ?? "script";
      const action = synthAction({
        type: intent.type,
        participantId,
        ...(intent.payload !== undefined ? { payload: intent.payload } : {}),
      });
      // runChoose already normalized the intent against the legal set; the
      // reduce-level check would be redundant, but validateSubmittedAction is
      // cheap and pins the same contract the human path uses.
      const check = validateSubmittedAction(action, legal.value);
      if (!check.ok) {
        callbacks.onDrop(`script move "${intent.type}" dropped: ${check.message}`);
        continue;
      }
      if (!applyAction(action, { kind: "script_move", participantId, action })) return;
    }
  }

  // ── the animation frame (accumulator + clamp + render) ────────────────────
  let lastFrame = drivers.now();
  let accumulator = 0;

  function frame(now: number): void {
    if (stopped) return;
    let delta = now - lastFrame;
    lastFrame = now;
    if (!Number.isFinite(delta) || delta < 0) delta = 0;
    if (delta > EXPERIENCE_LOOP_MAX_FRAME_DELTA_MS) delta = EXPERIENCE_LOOP_MAX_FRAME_DELTA_MS;
    accumulator += delta;

    let drained = 0;
    while (
      accumulator >= config.tickMs &&
      drained < EXPERIENCE_LOOP_MAX_CATCHUP_TICKS_PER_FRAME &&
      !stopped &&
      !finished
    ) {
      accumulator -= config.tickMs;
      drained += 1;
      tick();
    }
    // A surviving deficit is DISCARDED (tab-switch clamp): wall-clock is
    // best-effort; the log's tick counts are the replay truth.
    if (accumulator >= config.tickMs) accumulator = accumulator % config.tickMs;
    if (stopped || finished) return;

    const view = runProject(config.rulesSource, state, config.viewer, legalityCaps());
    if (!view.ok) {
      fatal(view.kind, view.message);
      return;
    }
    callbacks.onView(view.value);
    drivers.requestFrame(frame);
  }

  // ── boot ──────────────────────────────────────────────────────────────────
  emit({ kind: "round_started", seed: config.seed, settings: config.initialSettings ?? null });
  drivers.requestFrame(frame);

  function deadHandle(): ExperienceLoopHandle {
    return {
      enqueueInput: () => undefined,
      getState: () => config.initialState,
      stop: () => undefined,
    };
  }

  return {
    enqueueInput: (input) => {
      if (stopped || finished) return;
      if (inputQueue.length >= EXPERIENCE_LOOP_MAX_INPUT_QUEUE) {
        callbacks.onDrop(`input "${input.type}" dropped: queue full`);
        return;
      }
      inputQueue.push(input);
    },
    getState: () => state,
    stop: () => {
      // Teardown, not a finish: a stopped round is LOST by design (the plan's
      // disconnect rule) — no round_finished event, no commit payload.
      stopped = true;
    },
  };
}

// Re-exported for the runtime entry's API surface (single import point).
export type { ExperienceActionDescriptor } from "./experience-kernel-frame.js";
