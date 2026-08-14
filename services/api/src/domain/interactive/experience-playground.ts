/**
 * In-memory playground Interactive-experience session driver
 * (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 8 / IR-84A).
 *
 * Lets an author drive UNSAVED-or-saved rules through the REAL kernel
 * create→project→actions→reduce path as an interactive play loop, advancing
 * human AND script-controlled seats turn by turn, with ZERO durable writes and
 * deterministic outcomes. This is the runtime the IR-84B ExperiencePlayground
 * surface calls.
 *
 * It is DISTINCT from the IR-81B stateless tester (experience-tester.ts): the
 * tester is a single-shot diagnostic (discover + replay a FIXED action list +
 * bounded simulate returning a full trace); this driver is the interactive
 * turn-by-turn play primitive (start → advance → advance ...) with script seats
 * advancing synchronously between human turns. Do NOT rebuild the tester — the
 * driver reuses the tester's result/error/stop-reason types directly.
 *
 * Two operations over an ephemeral in-memory session (option (a) — the "session
 * driver" the plan names): {@link startExperiencePlayground} creates the session
 * and holds it in a process-local Map keyed by an opaque playground session id;
 * {@link advanceExperiencePlayground} looks up the session, applies ONE human
 * action via the real reduce, then advances script-controlled seats
 * synchronously via the real `choose` until the next human/model/idle boundary.
 * The caller holds the id across turns. Nothing is persisted to the DB — the
 * Map is NOT ExperienceStore; it is an ephemeral play scratch space with no
 * automatic eviction (sessions live for the process lifetime; the IR-84B
 * surface owns reset/close).
 *
 * Model seats are OPTIONAL/STUBBED: when the boundary is `awaiting_model`, the
 * driver reports it and stops — it NEVER invokes a provider/model or the AI
 * SDK. There is no provider/ai-sdk import in this module.
 *
 * Determinism: one {@link DeterministicRandom} stream is created from the
 * caller-supplied seed at start and advanced across create + every reduce (the
 * same single-stream model the IR-81B tester uses), so the same seed + action
 * sequence reproduces identical draws. The stream object is held on the
 * ephemeral session across turns, so the cursor advances naturally between
 * human turns — replaying start + advance(S) with a fixed seed reproduces the
 * same authoritative state as a single `runExperienceTest(seed, S)`. The
 * optional `choose`/`chance` draws are EPHEMERAL (Math.random, non-recorded), so
 * script-chosen MOVES may vary across separate start() calls; deterministic
 * rules whose `choose` ignores `chance` (e.g. `legal[0]`) are fully reproducible.
 *
 * Effects are CAPTURED and REPORTED only — never executed (same posture as the
 * tester). Capability grants are chosen by the caller from the package's
 * declared capabilities (granted ⊆ declared is enforced, mirroring the resource
 * service's gate).
 *
 * Trust posture: an ephemeral play surface for unsaved-or-saved rules.
 * Authoritative only over its own in-memory state. Imports ONLY the kernel,
 * sandbox, shared helpers, domain, and contracts — never ExperienceService/
 * ExperienceStore/chat-store/message-store/DB/persistence/binding.
 */

import {
  createDeterministicRandom,
  createEphemeralRandom,
  discoverExperienceDefinition,
  runActions,
  runChoose,
  runCreate,
  runFlavor,
  runProject,
  runReduce,
  validateSubmittedAction,
  type ExperienceDefinition,
} from "./experience-kernel.js";
import type { DeterministicRandom } from "./experience-kernel.js";
import type { ExperienceConsoleEntry } from "./experience-sandbox.js";
import {
  buildCapabilityContext,
  undeclaredGrantedCapabilities,
} from "./experience-shared.js";
import type {
  ExperienceTestError,
  ExperienceTestProjection,
  ExperienceTestStopReason,
} from "./experience-tester.js";
import {
  EXPERIENCE_CONTROLLER,
  EXPERIENCE_EFFECT_KIND,
  EXPERIENCE_SESSION_STATUS,
  EXPERIENCE_VIEWER_KIND,
  type ExperienceAction,
  type ExperienceActionDescriptor,
  type ExperienceCapability,
  type ExperienceEffectRequest,
  type ExperienceEvent,
  type ExperienceParticipant,
  type ExperienceSessionStatus,
  type ExperienceViewer,
} from "@vibe-tavern/domain";

// ─── Tunables ────────────────────────────────────────────────────────────────

const DEFAULT_SCRIPT_NAME = "experience-playground";
/** Default deterministic-random seed string for a playground session. */
const DEFAULT_SEED = "vt-experience-playground";
/**
 * Default iteration bound for the script-seat advancement loop (mirrors the
 * persistent service's MAX_SCRIPT_TURNS and the tester's DEFAULT_MAX_ITERATIONS;
 * kept distinct so the playground bound is visible and tunable independently).
 */
const DEFAULT_MAX_ITERATIONS = 200;

/**
 * Iteration bound for the model-turn drain loop (fix step 10). Mirrors
 * `DEFAULT_MAX_ITERATIONS` for script seats; kept distinct so the model-drain
 * bound is visible and tunable independently. A transition emitting more model
 * effects than this (pathological self-sustaining chains) stops draining and
 * leaves the remainder pending.
 */
const MODEL_DRAIN_MAX_ITERATIONS = 50;

// ─── Ephemeral model continuation seam (IR-90E) ─────────────────────────────
//
// At an `awaiting_model` boundary the driver can optionally execute the pending
// model effect through a REAL non-streaming provider executor injected via this
// seam — ZERO store writes (provider resolution is read-only). The driver module
// still imports only kernel/sandbox/shared/domain/contracts; the seam implementation
// (provider profile resolution + prompt building + executor call) lives in a
// separate module (`experience-playground-model.ts`) that CAN import provider /
// prompt-pipeline code.

/** Input the driver hands to the model seam at an `awaiting_model` boundary. */
export interface PlaygroundModelResolveInput {
  /** The model seat's pinned provider profile id. */
  readonly providerProfileId: string;
  /** The model seat's pinned model id. */
  readonly modelId: string;
  /** The raw effect request from the reduce transition (domain `unknown`). */
  readonly request: unknown;
  /** The model seat's projected view (the private view only it sees). */
  readonly projectedView: unknown;
  /** The legal actions for the model seat's viewer. */
  readonly legalActions: readonly ExperienceActionDescriptor[];
}

/** The seam's validated result — mirrors the durable service's
 *  ModelEffectResultPayload. Text mode carries the generated text; action mode
 *  carries a validated legal-action id + optional args. */
export type PlaygroundModelResolveResult =
  | { readonly ok: true; readonly mode: "text"; readonly text: string }
  | { readonly ok: true; readonly mode: "action"; readonly actionId: string; readonly args?: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The abstract model continuation seam the driver calls at `awaiting_model`. */
export interface PlaygroundModelDeps {
  /** Resolve one ephemeral model continuation for a model-controlled seat.
   *  Resolves the pinned provider/model (read-only — no store writes), builds
   *  a minimal prompt (host protocol + package instruction + the seat's
   *  projected private view), calls the REAL non-streaming executor, and
   *  returns the validated result text. */
  resolveModelReply(input: PlaygroundModelResolveInput): Promise<PlaygroundModelResolveResult>;
}

/**
 * Async flavor chatter seam (item 4 / AC-2b): a STRUCTURAL subset of the host's
 * {@link ExperienceChatterService} so the playground can normalize a
 * chatter-marked flavor WITHOUT importing the host service (this module's
 * dependency graph stays kernel/sandbox/shared/domain/contracts only). The
 * adapter injects the real service (or a deterministic test stub).
 *
 * `resolveChatterFlavor` is synchronous: a chatter-marked flavor returns a
 * `pending` view immediately and fires the model call fire-and-forget; static
 * flavor passes through unchanged. One attempt per (session, viewer,
 * revision, request-hash).
 */
export interface PlaygroundChatter {
  resolveChatterFlavor(
    sessionId: string,
    viewer: { kind: string; participantId?: string },
    revision: number,
    flavorOutput: unknown,
    participants: readonly ExperienceParticipant[],
  ): unknown;
}

// ─── Inputs / outputs ────────────────────────────────────────────────────────

export interface ExperiencePlaygroundStartInput {
  readonly rulesCode: string;
  readonly scriptName?: string;
  /** Game-specific setup passed to `create`; defaults to `{}` when omitted. */
  readonly settings?: unknown;
  readonly participants: readonly ExperienceParticipant[];
  readonly capabilityGrants: readonly ExperienceCapability[];
  readonly seed?: string;
  /** The seat the author drives. When omitted, the projection viewer is the
   *  first human seat (or the observer view when the roster has none). */
  readonly humanSeatId?: string;
}

export interface ExperiencePlaygroundAdvanceInput {
  /** The opaque playground session id returned by {@link startExperiencePlayground}. */
  readonly playgroundSessionId: string;
  /** The ONE human action to apply this turn (requestId + expectedRevision CAS). */
  readonly humanAction: ExperienceAction;
}

/** The turn envelope returned by start (full) and advance (definition omitted). */
export interface ExperiencePlaygroundData {
  /** The opaque playground session id the caller holds across turns. */
  readonly playgroundSessionId: string;
  /** The validated definition. Present on start; OMITTED on advance. */
  readonly definition?: ExperienceDefinition;
  /** Authoritative state immediately after `create` (revision 0). */
  readonly initialState: unknown;
  /** Authoritative state after this turn's reduce + script-seat advancement. */
  readonly state: unknown;
  /** Projected view + legal actions for the human seat at the current state. */
  readonly projection: ExperienceTestProjection;
  /**
   * Public events: on start, all events emitted so far (create + leading script
   * seats); on advance, the events emitted THIS turn (the human reduce + script
   * seats advanced this turn).
   */
  readonly events: ExperienceEvent[];
  /** Effects requested (reported, never executed): accumulated on start, this
   *  turn's delta on advance. */
  readonly effects: ExperienceEffectRequest[];
  /** VM console captured so far (start) / this turn (advance). */
  readonly console: ExperienceConsoleEntry[];
  /** Host-managed monotonic revision (0 after create; +1 per applied reduce). */
  readonly revision: number;
  readonly status: ExperienceSessionStatus;
  /** Whose turn it is after this turn's advancement (the boundary stop-reason). */
  readonly stopReason: ExperienceTestStopReason;
}

export type ExperiencePlaygroundStartResult =
  | { readonly ok: true; readonly data: ExperiencePlaygroundData }
  | { readonly ok: false; readonly error: ExperienceTestError };

export type ExperiencePlaygroundAdvanceResult =
  | { readonly ok: true; readonly data: ExperiencePlaygroundData }
  | { readonly ok: false; readonly error: ExperienceTestError };

// ─── Ephemeral in-memory session ─────────────────────────────────────────────

/**
 * One interactive play loop held in process memory. Carries the single
 * deterministic-random stream (created once from the seed at start and advanced
 * across create + every reduce) so the cursor survives across human turns — the
 * stateful core that distinguishes the driver from the stateless tester. The
 * accumulated buffers let start return the running totals; advance returns
 * per-turn deltas sliced from them.
 */
interface EphemeralPlaygroundSession {
  readonly playgroundSessionId: string;
  readonly code: string;
  readonly scriptName: string;
  readonly definition: ExperienceDefinition;
  readonly grants: readonly ExperienceCapability[];
  readonly participants: readonly ExperienceParticipant[];
  readonly projectionViewer: ExperienceViewer;
  /** Async flavor chatter resolver (item 4 / AC-2b): undefined = static flavor
   *  passes through unchanged (the pre-AC-2b behavior). Injected by the adapter
   *  at start; never a store write. */
  readonly chatter?: PlaygroundChatter;
  /** Authoritative state immediately after `create` (revision 0). */
  initialState: unknown;
  state: unknown;
  revision: number;
  status: ExperienceSessionStatus;
  /** The single deterministic stream (create + every human/script reduce). */
  rng: DeterministicRandom;
  /** Accumulated across discovery + create + every reduce + choose. */
  consoleBuf: ExperienceConsoleEntry[];
  events: ExperienceEvent[];
  effects: ExperienceEffectRequest[];
  /** Effect slots already executed by the model-turn drain (indexes into
   *  `effects`; the array is append-only so indexes stay stable). */
  consumedEffectSlots: Set<number>;
  /** requestId → the applied step's events/effects (idempotency replay). */
  applied: Map<string, { events: ExperienceEvent[]; effects: ExperienceEffectRequest[] }>;
  /** The boundary stop-reason after the last turn (returned on a replay). */
  stopReason: ExperienceTestStopReason;
}

/**
 * Process-local ephemeral session registry. This is NOT ExperienceStore — it is
 * an in-memory play scratch space with no automatic eviction. Sessions live for
 * the process lifetime; the IR-84B surface owns reset/close. A no-write test
 * confirms this map holds only plain JS objects and never reaches a store.
 */
const playgroundSessions = new Map<string, EphemeralPlaygroundSession>();

// ─── Small local helpers ─────────────────────────────────────────────────────
//
// These mirror helpers that live privately on the IR-81B tester module
// (hashSeedString / viewerKindForController / resolveProjectionViewer /
// resolveViewerForAction / testError / fromKernel / projectForResponse). They
// are reimplemented locally — against domain constants and the kernel's own
// deterministic-random construction — for the SAME structural reason the tester
// reimplements them from the persistent service: this driver's dependency graph
// is kernel + shared + domain + contracts ONLY (it never imports the persistent
// service module, honoring "never call ExperienceService for sequencing"). The
// tester and driver share the SAME algorithm (single source of truth for the RNG
// stream is the kernel's createDeterministicRandom, used below).

/** FNV-1a 32-bit hash of a seed string (mirrors experience-service.seedToNumeric). */
function hashSeedString(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function viewerKindForController(controller: string): ExperienceViewer["kind"] {
  if (controller === EXPERIENCE_CONTROLLER.human) return EXPERIENCE_VIEWER_KIND.human;
  if (controller === EXPERIENCE_CONTROLLER.script) return EXPERIENCE_VIEWER_KIND.script;
  if (controller === EXPERIENCE_CONTROLLER.model) return EXPERIENCE_VIEWER_KIND.model;
  return EXPERIENCE_VIEWER_KIND.observer;
}

/** The viewer the projection is computed for: the chosen human seat, the first
 *  human seat, or the observer view when the roster has no human-controlled seat. */
function resolveProjectionViewer(
  participants: readonly ExperienceParticipant[],
  humanSeatId?: string,
): ExperienceViewer {
  if (humanSeatId !== undefined) {
    return { kind: EXPERIENCE_VIEWER_KIND.human, participantId: humanSeatId };
  }
  const human = participants.find((p) => p.controller === EXPERIENCE_CONTROLLER.human);
  return human !== undefined
    ? { kind: EXPERIENCE_VIEWER_KIND.human, participantId: human.id }
    : { kind: EXPERIENCE_VIEWER_KIND.observer };
}

/** Resolve the viewer a submitted action is for: the named seat (kind derived
 *  from its controller), or the projection viewer when no participantId is given. */
function resolveActionViewer(
  participants: readonly ExperienceParticipant[],
  projectionViewer: ExperienceViewer,
  participantId?: string,
): ExperienceViewer {
  if (participantId !== undefined) {
    const p = participants.find((seat) => seat.id === participantId);
    if (p !== undefined) {
      return { kind: viewerKindForController(p.controller), participantId: p.id };
    }
    return { kind: EXPERIENCE_VIEWER_KIND.human, participantId };
  }
  return projectionViewer;
}

// ─── Error construction (mirrors the tester's typed envelope exactly) ────────

function testError(
  status: 409 | 422,
  code: string,
  message: string,
  consoleBuf: readonly ExperienceConsoleEntry[],
  extra?: {
    kind?: string;
    currentRevision?: number;
    participantId?: string;
    granted?: readonly ExperienceCapability[];
    needs?: readonly ExperienceCapability[];
  },
): ExperienceTestError {
  return {
    status,
    code,
    message,
    console: [...consoleBuf],
    ...(extra?.kind !== undefined ? { kind: extra.kind } : {}),
    ...(extra?.currentRevision !== undefined ? { currentRevision: extra.currentRevision } : {}),
    ...(extra?.participantId !== undefined ? { participantId: extra.participantId } : {}),
    ...(extra?.granted !== undefined ? { granted: extra.granted } : {}),
    ...(extra?.needs !== undefined ? { needs: extra.needs } : {}),
  };
}

/**
 * Map a kernel/sandbox failure to a typed error, merging the console captured so
 * far with the failing call's console. Mirrors the tester's classification:
 * validation-shaped kinds become `validation_error`, an `illegal_action` keeps
 * its code, and everything else becomes `vm_error` carrying the kernel `kind`.
 */
function fromKernel(
  e: { readonly ok: false; readonly kind: string; readonly message: string; readonly console: readonly ExperienceConsoleEntry[] },
  consoleBuf: readonly ExperienceConsoleEntry[],
): ExperienceTestError {
  const merged = [...consoleBuf, ...e.console];
  if (e.kind === "illegal_action") {
    return testError(422, "illegal_action", e.message, merged);
  }
  if (
    e.kind === "invalid_definition" ||
    e.kind === "invalid_state" ||
    e.kind === "invalid_view" ||
    e.kind === "invalid_actions" ||
    e.kind === "invalid_transition"
  ) {
    return testError(422, "validation_error", e.message, merged, { kind: e.kind });
  }
  return testError(422, "vm_error", e.message, merged, { kind: e.kind });
}

// ─── Projection (degrades gracefully, mirroring the tester) ─────────────────

/**
 * Project the current state for the response viewer. Degrades to
 * `{ state: null, actions: [] }` on a project/actions failure (the turn already
 * succeeded; a projection fault is surfaced via the captured console rather than
 * discarding the authoritative result). Matches the IR-81B tester's projection
 * exactly (state + legal actions; no random/chance) so playground parity against
 * `runExperienceTest` is byte-for-byte.
 *
 * AC-2b (async flavor, item 4): after both project + actions succeed, the
 * optional `flavor` method is run (ephemeral chance only — never the
 * deterministic cursor) and, when a chatter seam is wired on the session, a
 * chatter-marked flavor is normalized through it. Flavor is best-effort: a
 * kernel fault degrades to `undefined`, mirroring the persistent service.
 */
function projectForResponse(
  session: EphemeralPlaygroundSession,
  state: unknown,
  viewer: ExperienceViewer,
): ExperienceTestProjection {
  const caps = buildCapabilityContext(session.grants, session.participants);
  const projected = runProject(session.code, session.scriptName, state, viewer, caps);
  if (!projected.ok) {
    session.consoleBuf.push(...projected.console);
    return { state: null, actions: [] };
  }
  session.consoleBuf.push(...projected.console);
  const legal = runActions(session.code, session.scriptName, state, viewer, caps);
  if (!legal.ok) {
    session.consoleBuf.push(...legal.console);
    return { state: projected.value, actions: [] };
  }
  session.consoleBuf.push(...legal.console);

  // AC-2b: flavor is computed only after project + actions both succeed (the
  // same ordering as the persistent getProjectedView path). Ephemeral chance,
  // never the deterministic cursor.
  const flavorCaps = buildCapabilityContext(session.grants, session.participants, undefined, createEphemeralRandom());
  const flavorRes = runFlavor(session.code, session.scriptName, state, viewer, flavorCaps);
  session.consoleBuf.push(...flavorRes.console);
  let flavor: unknown = flavorRes.ok ? flavorRes.value : undefined;
  if (flavorRes.ok && session.chatter !== undefined) {
    flavor = session.chatter.resolveChatterFlavor(
      session.playgroundSessionId,
      viewer,
      session.revision,
      flavor,
      session.participants,
    );
  }

  return { state: projected.value, actions: legal.value, ...(flavor !== undefined ? { flavor } : {}) };
}

// ─── Script-seat advancement (shared by start + advance) ────────────────────

/**
 * Advance script-controlled seats synchronously via the real `choose` until the
 * turn reaches a human/model seat, the status becomes terminal, no legal action
 * remains, a script seat lacks `choose`, or the host bound is hit. Mirrors the
 * IR-81B tester's simulate loop and the persistent service's
 * advanceScriptTurns/findActor sequencing, but over the in-memory session.
 * Returns the stop-reason on success, or the first typed kernel error (which the
 * caller propagates as the operation result). The deterministic stream is
 * advanced only by the script-seat reduces (choose uses ephemeral chance).
 */
function advanceScriptSeats(
  session: EphemeralPlaygroundSession,
  turnEvents: ExperienceEvent[],
  turnEffects: ExperienceEffectRequest[],
): { readonly ok: true; readonly stopReason: ExperienceTestStopReason } | { readonly ok: false; readonly error: ExperienceTestError } {
  if (session.status === EXPERIENCE_SESSION_STATUS.completed) {
    return { ok: true, stopReason: "completed" };
  }

  for (let bound = 0; bound < DEFAULT_MAX_ITERATIONS; bound += 1) {
    // findActor: the first participant (in roster order) with legal actions.
    let actor: {
      participant: ExperienceParticipant;
      viewer: ExperienceViewer;
      legal: ExperienceActionDescriptor[];
    } | null = null;
    for (const p of session.participants) {
      const viewer: ExperienceViewer = {
        kind: viewerKindForController(p.controller),
        participantId: p.id,
      };
      const legal = runActions(
        session.code,
        session.scriptName,
        session.state,
        viewer,
        buildCapabilityContext(session.grants, session.participants),
      );
      session.consoleBuf.push(...legal.console);
      if (legal.ok && legal.value.length > 0) {
        actor = { participant: p, viewer, legal: legal.value };
        break;
      }
    }

    if (actor === null) {
      // Nobody among the participants can act — idle (the human/observer may
      // still hold legal actions; the projection carries them).
      return { ok: true, stopReason: "no_legal_action" };
    }

    const controller = actor.participant.controller;
    if (controller === EXPERIENCE_CONTROLLER.human) {
      return { ok: true, stopReason: "awaiting_human" };
    }
    if (controller === EXPERIENCE_CONTROLLER.model) {
      // OPTIONAL/STUBBED: report the boundary and stop — never call a provider.
      return { ok: true, stopReason: "awaiting_model" };
    }

    // script-controlled seat: requires the optional `choose` method.
    if (!session.definition.hasChoose) {
      return { ok: true, stopReason: "no_choose_method" };
    }

    // choose (ephemeral chance; no deterministic-cursor draw) → reduce.
    const chooseCaps = buildCapabilityContext(
      session.grants,
      session.participants,
      undefined,
      createEphemeralRandom(),
    );
    const chosen = runChoose(session.code, session.scriptName, session.state, actor.viewer, actor.legal, chooseCaps);
    if (!chosen.ok) return { ok: false, error: fromKernel(chosen, session.consoleBuf) };
    session.consoleBuf.push(...chosen.console);
    const intent = chosen.value;

    const chosenAction: ExperienceAction = {
      type: intent.type,
      requestId: `auto:pg:${session.playgroundSessionId}:${session.revision + 1}`,
      expectedRevision: session.revision,
      participantId: intent.participantId ?? actor.participant.id,
      ...(intent.payload !== undefined ? { payload: intent.payload } : {}),
    };

    const reduceCaps = buildCapabilityContext(session.grants, session.participants, session.rng);
    const reduced = runReduce(session.code, session.scriptName, session.state, chosenAction, reduceCaps);
    if (!reduced.ok) return { ok: false, error: fromKernel(reduced, session.consoleBuf) };
    session.consoleBuf.push(...reduced.console);
    const transition = reduced.value;

    session.revision += 1;
    session.state = transition.state;
    session.status = transition.status;
    for (const ev of transition.events) {
      session.events.push(ev);
      turnEvents.push(ev);
    }
    if (transition.effects !== undefined) {
      for (const ef of transition.effects) {
        session.effects.push(ef);
        turnEffects.push(ef);
      }
    }

    if (session.status === EXPERIENCE_SESSION_STATUS.completed) {
      return { ok: true, stopReason: "completed" };
    }
  }
  // Safety bound — a script never relinquished the turn.
  return { ok: true, stopReason: "bounded_non_termination" };
}

// ─── start ───────────────────────────────────────────────────────────────────

/**
 * Discover the rules via the real sandbox; create the ephemeral session via the
 * real kernel; project the initial viewer state + legal actions; advance any
 * LEADING script-controlled seats synchronously via the real `choose` until the
 * first human/model/idle boundary; return the validated definition, initial
 * authoritative state, projection, accumulated events/effects/console, current
 * revision, status, and the boundary stop-reason. The session is held in
 * process memory keyed by the returned playground session id.
 */
export function startExperiencePlayground(
  input: ExperiencePlaygroundStartInput,
  deps?: { readonly chatter?: PlaygroundChatter },
): ExperiencePlaygroundStartResult {
  const scriptName = input.scriptName ?? DEFAULT_SCRIPT_NAME;

  // 1. Discover + capability gate (granted ⊆ declared).
  const discovery = discoverExperienceDefinition(input.rulesCode, scriptName);
  if (!discovery.ok) return { ok: false, error: fromKernel(discovery, []) };
  const consoleBuf: ExperienceConsoleEntry[] = [...discovery.console];
  const grants = input.capabilityGrants;
  const undeclared = undeclaredGrantedCapabilities(discovery.definition.declaredCapabilities, grants);
  if (undeclared.length > 0) {
    return {
      ok: false,
      error: testError(
        422,
        "capability_denied",
        `Granted capabilities not declared by the rules: ${undeclared.join(", ")}`,
        consoleBuf,
        { granted: grants, needs: undeclared },
      ),
    };
  }

  const definition = discovery.definition;
  const code = input.rulesCode;
  const participants = input.participants;
  const settings = input.settings ?? {};
  const projectionViewer = resolveProjectionViewer(participants, input.humanSeatId);

  // 2. Create (one deterministic stream from seed, advanced across create + reduces).
  const rng = createDeterministicRandom(hashSeedString(input.seed ?? DEFAULT_SEED));
  const createCaps = buildCapabilityContext(grants, participants, rng);
  const created = runCreate(code, scriptName, settings, createCaps);
  if (!created.ok) return { ok: false, error: fromKernel(created, consoleBuf) };
  consoleBuf.push(...created.console);

  // 3. Build the ephemeral session, then advance leading script seats.
  const playgroundSessionId = crypto.randomUUID();
  const session: EphemeralPlaygroundSession = {
    playgroundSessionId,
    code,
    scriptName,
    definition,
    grants,
    participants,
    projectionViewer,
    chatter: deps?.chatter,
    initialState: created.value,
    state: created.value,
    revision: 0,
    status: EXPERIENCE_SESSION_STATUS.active,
    rng,
    consoleBuf,
    events: [],
    effects: [],
    consumedEffectSlots: new Set(),
    applied: new Map(),
    stopReason: "no_legal_action",
  };

  const leading = advanceScriptSeats(session, session.events, session.effects);
  if (!leading.ok) return { ok: false, error: leading.error };
  session.stopReason = leading.stopReason;

  // 4. Project for the human seat at the post-advancement state.
  const projection = projectForResponse(session, session.state, projectionViewer);

  playgroundSessions.set(playgroundSessionId, session);

  return {
    ok: true,
    data: {
      playgroundSessionId,
      definition,
      initialState: session.initialState,
      state: session.state,
      projection,
      events: [...session.events],
      effects: [...session.effects],
      console: [...session.consoleBuf],
      revision: session.revision,
      status: session.status,
      stopReason: session.stopReason,
    },
  };
}

// ─── advance ─────────────────────────────────────────────────────────────────

/**
 * Apply the ONE human action via the real kernel reduce (with requestId
 * idempotency + expectedRevision CAS, mirroring the service), then advance
 * script-controlled seats synchronously via the real `choose` until the next
 * human/model/idle boundary. Returns the next authoritative state, projection,
 * this turn's events/effects (reported only), this turn's console, bumped
 * revision, status, and the boundary stop-reason. An unknown playground session
 * id is a typed 422; a duplicate requestId replays the prior step without
 * re-reducing; a stale expectedRevision is a typed 409.
 */
export function advanceExperiencePlayground(input: ExperiencePlaygroundAdvanceInput): ExperiencePlaygroundAdvanceResult {
  const session = playgroundSessions.get(input.playgroundSessionId);
  if (session === undefined) {
    return {
      ok: false,
      error: testError(
        422,
        "session_not_found",
        `Playground session '${input.playgroundSessionId}' not found`,
        [],
      ),
    };
  }

  const action = input.humanAction;
  const consoleStart = session.consoleBuf.length;

  // 1. Idempotency FIRST (mirrors the service + tester): a duplicate requestId
  //    replays the prior step and does NOT re-reduce or advance the revision.
  //    Checked before CAS: a retried duplicate carries the ORIGINAL (now-stale)
  //    expectedRevision.
  const prior = session.applied.get(action.requestId);
  if (prior !== undefined) {
    const projection = projectForResponse(session, session.state, session.projectionViewer);
    return {
      ok: true,
      data: {
        playgroundSessionId: session.playgroundSessionId,
        initialState: session.initialState,
        state: session.state,
        projection,
        events: [...prior.events],
        effects: [...prior.effects],
        console: session.consoleBuf.slice(consoleStart),
        revision: session.revision,
        status: session.status,
        stopReason: session.stopReason,
      },
    };
  }

  // 2. CAS: the action must claim the current in-memory revision.
  if (action.expectedRevision !== session.revision) {
    return {
      ok: false,
      error: testError(
        409,
        "stale_revision",
        `Action expected revision ${action.expectedRevision}, session is at ${session.revision}`,
        session.consoleBuf,
        { currentRevision: session.revision },
      ),
    };
  }

  // 3. Legal-action pre-check for this participant (real VM actions()).
  const viewer = resolveActionViewer(session.participants, session.projectionViewer, action.participantId);
  const legal = runActions(
    session.code,
    session.scriptName,
    session.state,
    viewer,
    buildCapabilityContext(session.grants, session.participants),
  );
  if (!legal.ok) return { ok: false, error: fromKernel(legal, session.consoleBuf) };
  session.consoleBuf.push(...legal.console);
  const valid = validateSubmittedAction(action, legal.value);
  if (!valid.ok) return { ok: false, error: fromKernel(valid, session.consoleBuf) };

  // 4. Reduce under the real VM (random injected if granted; cursor advances).
  const reduceCaps = buildCapabilityContext(session.grants, session.participants, session.rng);
  const reduced = runReduce(session.code, session.scriptName, session.state, action, reduceCaps);
  if (!reduced.ok) return { ok: false, error: fromKernel(reduced, session.consoleBuf) };
  session.consoleBuf.push(...reduced.console);
  const transition = reduced.value;

  const turnEvents: ExperienceEvent[] = [...transition.events];
  const turnEffects: ExperienceEffectRequest[] = [...(transition.effects ?? [])];

  session.revision += 1;
  session.state = transition.state;
  session.status = transition.status;
  for (const ev of transition.events) session.events.push(ev);
  if (transition.effects !== undefined) {
    for (const ef of transition.effects) session.effects.push(ef);
  }
  session.applied.set(action.requestId, { events: turnEvents, effects: turnEffects });

  // 5. Advance script-controlled seats until the next boundary.
  const advanced = advanceScriptSeats(session, turnEvents, turnEffects);
  if (!advanced.ok) return { ok: false, error: advanced.error };
  session.stopReason = advanced.stopReason;

  // 6. Project for the human seat at the post-advancement state.
  const projection = projectForResponse(session, session.state, session.projectionViewer);

  return {
    ok: true,
    data: {
      playgroundSessionId: session.playgroundSessionId,
      initialState: session.initialState,
      state: session.state,
      projection,
      events: turnEvents,
      effects: turnEffects,
      console: session.consoleBuf.slice(consoleStart),
      revision: session.revision,
      status: session.status,
      stopReason: session.stopReason,
    },
  };
}

// ─── executeModelTurn — ephemeral model continuation (IR-90E) ────────────────

/** Find the most recent pending model effect and resolve its target seat.
 *  IR-90E: the actor is selected by the effect's `request.viewer`, NOT by
 *  iterating model participants — with multiple model seats the correct one is
 *  the one the pending effect targets. */
function findPendingModelEffect(
  session: EphemeralPlaygroundSession,
): { effect: ExperienceEffectRequest; participantId: string; index: number } | null {
  // OLDEST-first (fix step 10): with multiple model effects from one transition
  // the correct drain order is emission order, and the first unconsumed slot is
  // the next one to execute. Consumed slots (already delivered) are skipped so a
  // repeated call never re-executes a delivered effect.
  for (let i = 0; i < session.effects.length; i += 1) {
    if (session.consumedEffectSlots.has(i)) continue;
    const effect = session.effects[i]!;
    if (effect.kind !== EXPERIENCE_EFFECT_KIND.model) continue;
    const req = effect.request as { viewer?: unknown };
    if (typeof req.viewer === "string") {
      return { effect, participantId: req.viewer, index: i };
    }
  }
  return null;
}

/** Extract the actionType from a raw model effect request (defaults to "reply"). */
function modelEffectActionType(request: unknown): string {
  if (request !== null && typeof request === "object") {
    const actionType = (request as { actionType?: unknown }).actionType;
    if (typeof actionType === "string" && actionType.length > 0) return actionType;
  }
  return "reply";
}

/**
 * Drain ALL pending ephemeral model effects at an `awaiting_model` boundary
 * (fix step 10), OLDEST-first and bounded by `MODEL_DRAIN_MAX_ITERATIONS`,
 * feeding each validated model result back into the reducer through the REAL
 * projected action/effect contract. ZERO ExperienceStore/chat/DB writes — the
 * injected seam resolves the pinned provider/model read-only, builds a minimal
 * prompt, and calls the REAL non-streaming executor.
 *
 * The caller (adapter) invokes this after a start/advance returns
 * `stopReason: "awaiting_model"` when a model seam is available. Each drain
 * iteration resolves the next unconsumed model seat (request.viewer) with its
 * legal actions, projects its private view, invokes the seam, maps the result
 * to a `reply` action (type = effect's `actionType`, participantId = model
 * seat), reduces it via the real kernel, marks the effect slot consumed, then
 * advances script seats to the next boundary. A transition emitting N model
 * effects (a group chat) therefore delivers ALL N in emission order.
 */
export async function executeModelTurnExperiencePlayground(
  input: { readonly playgroundSessionId: string },
  deps: PlaygroundModelDeps,
): Promise<ExperiencePlaygroundAdvanceResult> {
  const session = playgroundSessions.get(input.playgroundSessionId);
  if (session === undefined) {
    return {
      ok: false,
      error: testError(
        422,
        "session_not_found",
        `Playground session '${input.playgroundSessionId}' not found`,
        [],
      ),
    };
  }

  const consoleStart = session.consoleBuf.length;

  // Drain ALL pending model effects OLDEST-first (fix step 10), bounded by
  // MODEL_DRAIN_MAX_ITERATIONS. Each iteration runs exactly one effect through
  // the seam → map → validate → reduce → script-seat advance, marking the slot
  // consumed on a successful reduce. A typed error aborts the drain and returns
  // the error envelope; slots already delivered stay consumed. New model
  // effects emitted by a model reduce are appended to `session.effects` and
  // picked up by a later iteration (desired drain semantics).
  const turnEvents: ExperienceEvent[] = [];
  const turnEffects: ExperienceEffectRequest[] = [];
  for (let bound = 0; bound < MODEL_DRAIN_MAX_ITERATIONS; bound += 1) {
    const pending = findPendingModelEffect(session);
    if (pending === null) {
      // No unconsumed pending model effect — nothing further to continue.
      const projection = projectForResponse(session, session.state, session.projectionViewer);
      return {
        ok: true,
        data: {
          playgroundSessionId: session.playgroundSessionId,
          initialState: session.initialState,
          state: session.state,
          projection,
          events: turnEvents,
          effects: turnEffects,
          console: session.consoleBuf.slice(consoleStart),
          revision: session.revision,
          status: session.status,
          stopReason: session.stopReason,
        },
      };
    }

    // 2. Resolve the target participant from the effect's viewer.
    const participant = session.participants.find((p) => p.id === pending.participantId);
    if (participant === undefined || participant.controller !== EXPERIENCE_CONTROLLER.model) {
      return {
        ok: false,
        error: testError(
          422,
          "no_model_effect",
          `Model effect targets '${pending.participantId}' which is not a model seat`,
          session.consoleBuf,
          { participantId: pending.participantId },
        ),
      };
    }

    // 3. Resolve the pinned provider/model from the seat.
    const providerProfileId = participant.providerProfileId?.trim();
    const modelId = participant.modelId?.trim();
    if (!providerProfileId || !modelId) {
      return {
        ok: false,
        error: testError(
          422,
          "no_model",
          `Model seat '${participant.id}' has no pinned provider/model`,
          session.consoleBuf,
          { participantId: participant.id },
        ),
      };
    }

    // 4. Get the legal actions for the model seat's viewer (real VM actions()).
    const viewer: ExperienceViewer = { kind: EXPERIENCE_VIEWER_KIND.model, participantId: participant.id };
    const caps = buildCapabilityContext(session.grants, session.participants);
    const legal = runActions(session.code, session.scriptName, session.state, viewer, caps);
    if (!legal.ok) return { ok: false, error: fromKernel(legal, session.consoleBuf) };
    session.consoleBuf.push(...legal.console);

    // 5. Project the private view for the model seat (real VM project).
    const projected = projectForResponse(session, session.state, viewer);

    // 6. Invoke the model seam (provider resolution + prompt + executor).
    const resolved = await deps.resolveModelReply({
      providerProfileId,
      modelId,
      request: pending.effect.request,
      projectedView: projected.state,
      legalActions: legal.value,
    });
    if (!resolved.ok) {
      return {
        ok: false,
        error: testError(
          422,
          resolved.code,
          resolved.message,
          session.consoleBuf,
          { participantId: participant.id },
        ),
      };
    }

    // 7. Map the validated result to an action for the model seat, mirroring
    //    the model-effect-service's mapResultToAction: text mode → actionType +
    //    {text}; action mode → actionId + optional args.
    const actionType = modelEffectActionType(pending.effect.request);
    const modelAction: ExperienceAction = resolved.mode === "action"
      ? {
          type: resolved.actionId,
          requestId: `model:pg:${session.playgroundSessionId}:${session.revision + 1}`,
          expectedRevision: session.revision,
          participantId: participant.id,
          ...(resolved.args !== undefined ? { payload: resolved.args } : {}),
        }
      : {
          type: actionType,
          requestId: `model:pg:${session.playgroundSessionId}:${session.revision + 1}`,
          expectedRevision: session.revision,
          participantId: participant.id,
          payload: { text: resolved.text },
        };

    // 8. Validate the action against the model seat's legal actions.
    const valid = validateSubmittedAction(modelAction, legal.value);
    if (!valid.ok) {
      return { ok: false, error: fromKernel(valid, session.consoleBuf) };
    }

    // 8. Reduce under the real VM (random injected if granted; cursor advances).
    const reduceCaps = buildCapabilityContext(session.grants, session.participants, session.rng);
    const reduced = runReduce(session.code, session.scriptName, session.state, modelAction, reduceCaps);
    if (!reduced.ok) return { ok: false, error: fromKernel(reduced, session.consoleBuf) };
    session.consoleBuf.push(...reduced.console);
    const transition = reduced.value;

    // Mark this effect slot consumed ONLY after the reduce succeeded — a typed
    // error above leaves it unconsumed so a retry re-attempts it.
    session.consumedEffectSlots.add(pending.index);

    turnEvents.push(...transition.events);
    if (transition.effects !== undefined) turnEffects.push(...transition.effects);

    session.revision += 1;
    session.state = transition.state;
    session.status = transition.status;
    for (const ev of transition.events) session.events.push(ev);
    if (transition.effects !== undefined) {
      for (const ef of transition.effects) session.effects.push(ef);
    }

    // 9. Advance script-controlled seats until the next boundary.
    const advanced = advanceScriptSeats(session, turnEvents, turnEffects);
    if (!advanced.ok) return { ok: false, error: advanced.error };
    session.stopReason = advanced.stopReason;
  }

  // Bound hit with model effects still pending — return the partial drain so the
  // caller sees the state after the drained steps (remaining effects are still
  // in `session.effects`, unconsumed).
  const projection = projectForResponse(session, session.state, session.projectionViewer);
  return {
    ok: true,
    data: {
      playgroundSessionId: session.playgroundSessionId,
      initialState: session.initialState,
      state: session.state,
      projection,
      events: turnEvents,
      effects: turnEffects,
      console: session.consoleBuf.slice(consoleStart),
      revision: session.revision,
      status: session.status,
      stopReason: session.stopReason,
    },
  };
}
