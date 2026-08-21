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
 * The MODEL SEAT channel (RM-5): `requestModel` logs `model_request` for a
 * DECLARED model seat (the SDK auto-forwards it to the host seam); the async
 * reply returns through `applyModelResult`, which logs the reply VERBATIM as
 * `model_result` (data — a replay never re-generates it) and, when the reply
 * is a legal action intent for the seat, reduces it exactly like a script
 * move. The replay re-derives the same apply-or-drop outcome from the logged
 * result because legality is a pure function of state.
 *
 * VISUAL-DRIVEN FINISH (RM-5): `finishNow` ends the round from the surface
 * (player "done"/"give up") at a tick boundary — the log flushes, the claim
 * (`completed` by default, `interrupted` for a player abandon) is recorded on
 * `round_finished`, and optional score/summary ride the finish payload into
 * the commit (they are commit metadata, NOT log events — replay never needs
 * them).
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
import {
	createDeterministicRandom,
	createEphemeralRandom,
	EXPERIENCE_LOOP_MAX_BATCHED_TICKS,
	EXPERIENCE_LOOP_MAX_ROUND_TICKS,
} from "@vibe-tavern/domain";

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
 * hosts may lower it via config. Lives in @vibe-tavern/domain — the RM-8
 * commit replay enforces the SAME ceiling server-side (one source of truth;
 * a divergent copy would 422 honest rounds).
 */
export { EXPERIENCE_LOOP_MAX_ROUND_TICKS };
/** Batched-ticks flush threshold — keeps a quiet round's batches bounded too.
 *  Shared with the server-side commit replay (same provenance as above). */
export { EXPERIENCE_LOOP_MAX_BATCHED_TICKS };
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
 * `model_request`/`model_result` carry the async model seam verbatim: the
 * request is what the seat asked, the result is DATA (a replay never
 * re-generates it — RM-8 re-derives the apply-or-drop outcome); `requestId`
 * is wire correlation only, inert for replay.
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
      readonly requestId?: string;
    }
  | { readonly kind: "model_result"; readonly seatId: string; readonly result: unknown; readonly requestId?: string }
  | { readonly kind: "round_finished"; readonly status: "completed" | "interrupted" };

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
  /** Model seats answered through the async host seam (RM-5). */
  readonly modelSeats?: readonly ExperienceViewer[];
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
  /** Exactly once, when the round ends: the commit payload. The status is the
   * game-driven `"completed"` or the visual-driven claim (`finishNow`, RM-5);
   * score/summary are commit metadata riding the finish, never log events. */
  readonly onFinish: (result: ExperienceLoopFinish) => void;
}

export interface ExperienceLoopFinish {
  readonly status: "completed" | "interrupted";
  readonly finalState: unknown;
  readonly log: readonly ExperienceLoopEvent[];
  readonly score?: unknown;
  readonly summary?: unknown;
}

/** The visual-driven finish claim (`experience.finishRound`, RM-5). */
export interface ExperienceLoopFinishClaim {
  readonly status?: "completed" | "interrupted";
  readonly score?: unknown;
  readonly summary?: unknown;
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
  /** Log a `model_request` for a DECLARED model seat (false = dropped). RM-5. */
  readonly requestModel: (seatId: string, prompt: unknown, requestId?: string) => boolean;
  /** Record a model reply verbatim; reduce it when it is a legal seat action. */
  readonly applyModelResult: (seatId: string, result: unknown, requestId?: string) => boolean;
  /** End the round from the surface at a tick boundary (false = already over). */
  readonly finishNow: (claim?: ExperienceLoopFinishClaim) => boolean;
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

  function finishRound(status: "completed" | "interrupted", extras?: ExperienceLoopFinishClaim): void {
    if (stopped || finished) return;
    finished = true;
    stopped = true;
    flushTicks();
    emit({ kind: "round_finished", status });
    callbacks.onFinish({
      status,
      finalState: state,
      log,
      ...(extras?.score !== undefined ? { score: extras.score } : {}),
      ...(extras?.summary !== undefined ? { summary: extras.summary } : {}),
    });
  }

  // ── reduce application (input + script_move share the shape) ─────────────
  /** Run one reduce; state/revision mutate, NOTHING is logged. */
  function runTransition(action: ExperienceLoopLoggedAction): "applied" | "completed" | "fatal" {
    const transition = runReduce(config.rulesSource, state, action, tickCaps());
    if (!transition.ok) {
      fatal(transition.kind, transition.message);
      return "fatal";
    }
    state = transition.value.state;
    revision += 1;
    return transition.value.status === "completed" ? "completed" : "applied";
  }

  function applyLoggedAction(
    action: ExperienceLoopLoggedAction,
    event:
      | { kind: "input"; action: ExperienceLoopLoggedAction }
      | { kind: "script_move"; participantId: string; action: ExperienceLoopLoggedAction },
  ): boolean {
    const outcome = runTransition(action);
    if (outcome === "fatal") return false;
    flushTicks();
    emit(event);
    if (outcome === "completed") {
      finishRound("completed");
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
        finishRound("completed");
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
      if (!applyLoggedAction(action, { kind: "input", action })) return;
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
      if (!applyLoggedAction(action, { kind: "script_move", participantId, action })) return;
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
      requestModel: () => false,
      applyModelResult: () => false,
      finishNow: () => false,
    };
  }

  /** A declared model seat lookup — undeclared seats are rejected at the door. */
  function findModelSeat(seatId: string): ExperienceViewer | undefined {
    return config.modelSeats?.find((seat) => seat.participantId === seatId);
  }

  /** A model reply is an action intent when it is `{ type: string, … }`. */
  function asIntent(result: unknown): { type: string; payload?: unknown } | null {
    if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
    const type = (result as { type?: unknown }).type;
    if (typeof type !== "string") return null;
    const payload = (result as { payload?: unknown }).payload;
    return { type, ...(payload !== undefined ? { payload } : {}) };
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
    requestModel: (seatId, prompt, requestId) => {
      if (stopped || finished) return false;
      if (findModelSeat(seatId) === undefined) {
        callbacks.onDrop(`model request for unknown seat "${seatId}" dropped`);
        return false;
      }
      flushTicks();
      emit({
        kind: "model_request",
        seatId,
        prompt,
        ...(requestId !== undefined ? { requestId } : {}),
      });
      return true;
    },
    applyModelResult: (seatId, result, requestId) => {
      if (stopped || finished) return false; // late reply after the round ended — noise
      const seat = findModelSeat(seatId);
      if (seat === undefined) {
        callbacks.onDrop(`model result for unknown seat "${seatId}" dropped`);
        return false;
      }
      // Verbatim first (wire truth): the replay reads the logged result and
      // re-derives the same apply-or-drop outcome below.
      flushTicks();
      emit({
        kind: "model_result",
        seatId,
        result,
        ...(requestId !== undefined ? { requestId } : {}),
      });
      const intent = asIntent(result);
      if (intent === null) {
        callbacks.onDrop(`model result for seat "${seatId}" is not an action — recorded, not applied`);
        return true;
      }
      const legal = runActions(config.rulesSource, state, seat, legalityCaps());
      if (!legal.ok) {
        fatal(legal.kind, legal.message);
        return true;
      }
      const action = synthAction({
        type: intent.type,
        participantId: seatId,
        ...(intent.payload !== undefined ? { payload: intent.payload } : {}),
      });
      const check = validateSubmittedAction(action, legal.value);
      if (!check.ok) {
        callbacks.onDrop(`model move "${intent.type}" dropped: ${check.message}`);
        return true;
      }
      const outcome = runTransition(action);
      if (outcome === "fatal") return true;
      if (outcome === "completed") finishRound("completed");
      return true;
    },
    finishNow: (claim) => {
      if (stopped || finished) return false;
      const status = claim?.status === "interrupted" ? "interrupted" : "completed";
      finishRound(status, claim);
      return true;
    },
  };
}

// Re-exported for the runtime entry's API surface (single import point).
export type { ExperienceActionDescriptor } from "./experience-kernel-frame.js";
