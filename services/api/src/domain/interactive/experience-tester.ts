/**
 * Stateless unsaved-source Interactive-experience tester
 * (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 8 / IR-81B).
 *
 * Lets an author drive UNSAVED rules source through the REAL sandbox/kernel
 * with zero persistence and zero chat/session/DB binding. The entire run lives
 * in request/response memory and the kernel — this module never touches the
 * ExperienceStore, the experience tables, chat config, session start, or any
 * binding surface, and it never calls the persistent {@link ExperienceService}
 * for sequencing. It reuses the pure kernel functions directly, mirroring the
 * service's in-memory semantics (create → project → actions → reduce, and the
 * script-seat advancement loop) without the durable layer.
 *
 * Two operations, both fully self-contained (each request is an independent
 * scenario — there is no server-side state between requests):
 *
 *  - {@link runExperienceTest} — discover a candidate definition from raw
 *    `rulesCode`, create the initial authoritative state from chosen
 *    participants/settings, project for a viewer, list legal actions, and
 *    reduce an ordered list of submitted action intentions. The host owns the
 *    monotonic in-memory revision counter, the requestId idempotency, and the
 *    expectedRevision compare-and-swap the persistent service enforces — all
 *    within this one request. A duplicate requestId replays the prior step
 *    (never re-applies); a stale expectedRevision or an illegal action returns
 *    the existing typed kernel error and applies nothing further.
 *
 *  - {@link simulateExperienceTest} — discover + create, then run a bounded
 *    automated simulation that advances script-controlled seats via the real
 *    `choose` (where the package declares it), reducing each chosen action,
 *    until the boundary turns to a human/model seat, the status becomes
 *    terminal, no legal action remains, or a host bound (max iterations / max
 *    effects) is reached. Each stop reason is returned as a typed diagnostic
 *    (stuck / no-legal-action, script-seat-without-choose is a configuration
 *    error, bounded non-termination) rather than pretending arbitrary games
 *    must terminate.
 *
 * Effects are CAPTURED and REPORTED only — they are durable request data the
 * host would run out-of-band (Wave 4); this tester never executes them.
 *
 * Capability grants for a test run are chosen by the caller from the package's
 * declared capabilities (granted ⊆ declared is enforced, mirroring the resource
 * service's gate). A script that calls a capability API the caller did not
 * grant fails with the kernel's existing typed error: the method-call context
 * simply omits that surface, so accessing it throws inside the VM.
 *
 * Trust posture: a read-only diagnostic surface for unsaved source.
 * Authoritative only over its own ephemeral in-memory state. Reuses the
 * existing bounded-JSON guard, action/transition/effect schemas,
 * capability-context builder, deterministic-random construction, and
 * cloneFrozen input isolation that the kernel and persistent service already
 * share — no parallel validation layer is invented here.
 */

import {
  createDeterministicRandom,
  createEphemeralRandom,
  discoverExperienceDefinition,
  runActions,
  runChoose,
  runCreate,
  runProject,
  runReduce,
  validateSubmittedAction,
  type ExperienceDefinition,
  type ExperienceKernelError,
} from "./experience-kernel.js";
import type { ExperienceConsoleEntry } from "./experience-sandbox.js";
import {
  buildCapabilityContext,
  undeclaredGrantedCapabilities,
} from "./experience-shared.js";
import {
  EXPERIENCE_CONTROLLER,
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
import type {
  ExperienceSeatLegality,
  ExperienceSeatLegalityMatrix,
} from "@vibe-tavern/api-contracts";

// ─── Tunables ────────────────────────────────────────────────────────────────

const DEFAULT_SCRIPT_NAME = "experience-tester";
/** Default deterministic-random seed string for a test run (reproducible). */
const DEFAULT_SEED = "vt-experience-tester";
/** Default iteration bound for the simulation loop (mirrors the persistent
 *  service's MAX_SCRIPT_TURNS, kept distinct so the tester's bound is visible). */
const DEFAULT_MAX_ITERATIONS = 200;
/** Default accumulated-effects bound for the simulation loop. */
const DEFAULT_MAX_EFFECTS = 256;

// ─── Result / error types ────────────────────────────────────────────────────

/**
 * A typed tester failure. Carries the host-managed HTTP status (409 for a
 * stale-revision CAS conflict, 422 for every authoring/validation/VM fault), a
 * stable `code`, the kernel/sandbox `kind` (for vm_error), and the VM console
 * captured up to the failure point — a diagnostic tester surfaces console even
 * on the error path so an author sees `console.log` output before a throw.
 */
export interface ExperienceTestError {
  readonly status: 409 | 422;
  readonly code: string;
  readonly message: string;
  readonly console: ExperienceConsoleEntry[];
  /** Kernel/sandbox failure kind (timeout/syntax/runtime/no_registration/…). */
  readonly kind?: string;
  /** Present on a stale_revision failure (the live in-memory revision). */
  readonly currentRevision?: number;
  /** Present on a no_choose_method configuration error. */
  readonly participantId?: string;
  /** Present on a capability_denied failure (the over-granted capabilities). */
  readonly granted?: readonly ExperienceCapability[];
  readonly needs?: readonly ExperienceCapability[];
}

/** One replayed action's outcome inside a test run / simulation trace. */
export interface ExperienceTestStepTrace {
  readonly requestId: string;
  readonly actionType: string;
  readonly participantId?: string;
  /** True when this requestId was already applied — the step is an idempotent
   *  replay (the revision did NOT advance; the transition was not re-reduced). */
  readonly replayed: boolean;
  /** The in-memory revision AFTER this step applied. */
  readonly revision: number;
  readonly status: ExperienceSessionStatus;
  readonly events: ExperienceEvent[];
  /** Effects the reducer requested at this step (reported, never executed). */
  readonly effects: ExperienceEffectRequest[];
  readonly console: ExperienceConsoleEntry[];
}

/** The projected view for the response viewer at the final state. */
export interface ExperienceTestProjection {
  readonly state: unknown;
  readonly actions: ExperienceActionDescriptor[];
  /** Cosmetic display data from the optional `flavor` method (best-effort; may
   *  be absent). The stateless tester never sets it; the playground driver
   *  (IR-84A) computes it and, when a chatter service is wired, normalizes a
   *  chatter-marked flavor through it (async flavor, item 4 / AC-2b). */
  readonly flavor?: unknown;
}

/** `ExperienceSeatLegality` / `ExperienceSeatLegalityMatrix` (the per-seat
 *  legality matrix, EXPERIENCE_TURN_LEGALITY_DIAGNOSTICS_REPORT step 3) are
 *  imported above from the shared wire contract
 *  `@vibe-tavern/api-contracts` — the backend produces exactly the shape the
 *  frontend renders, so drift is a compile error. */

export interface ExperienceTestRunData {
  readonly definition: ExperienceDefinition;
  readonly sourceHash: string;
  /** Authoritative state immediately after `create` (revision 0). */
  readonly initialState: unknown;
  /** Authoritative state after the final applied action (== initialState when
   *  no actions were supplied). */
  readonly finalState: unknown;
  /** Host-managed monotonic revision (0 after create; +1 per applied reduce). */
  readonly revision: number;
  readonly status: ExperienceSessionStatus;
  /** Projected view for the human seat (or observer) at the final state. */
  readonly projection: ExperienceTestProjection;
  /** All events emitted across create + every applied reduce. */
  readonly events: ExperienceEvent[];
  /** All effects requested across the run (reported, never executed). */
  readonly effects: ExperienceEffectRequest[];
  /** VM console captured across discovery + every method call. */
  readonly console: ExperienceConsoleEntry[];
  readonly steps: ExperienceTestStepTrace[];
  /** Per-seat legality matrix at the final state (one entry per roster
   *  participant, computed under that seat's own viewer). Empty seats array
   *  when the run carried no roster. */
  readonly seatLegality: ExperienceSeatLegalityMatrix;
}

export type ExperienceTestRunResult =
  | { readonly ok: true; readonly data: ExperienceTestRunData }
  | { readonly ok: false; readonly error: ExperienceTestError };

/**
 * Why a bounded simulation stopped. The diagnostic surface distinguishes
 * ordinary boundaries (a human/model seat, a terminal status) from authoring
 * faults (a script seat with legal actions but no `choose`, a stuck position
 * with no legal action, or a non-terminating loop that hit the host bound).
 */
export type ExperienceTestStopReason =
  | "completed"
  | "awaiting_human"
  | "awaiting_model"
  | "no_legal_action"
  | "no_choose_method"
  | "bounded_non_termination"
  | "effects_bound";

export interface ExperienceTestSimulateData {
  readonly definition: ExperienceDefinition;
  readonly sourceHash: string;
  readonly initialState: unknown;
  readonly finalState: unknown;
  readonly revision: number;
  readonly status: ExperienceSessionStatus;
  readonly events: ExperienceEvent[];
  readonly effects: ExperienceEffectRequest[];
  readonly console: ExperienceConsoleEntry[];
  readonly steps: ExperienceTestStepTrace[];
  readonly stopReason: ExperienceTestStopReason;
  /** Number of script-seat reduces performed. */
  readonly iterations: number;
  /** Present on a no_choose_method stop (the offending participant). */
  readonly stopDetail?: { readonly participantId?: string };
}

export type ExperienceTestSimulateResult =
  | { readonly ok: true; readonly data: ExperienceTestSimulateData }
  | { readonly ok: false; readonly error: ExperienceTestError };

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface ExperienceTestRunInput {
  readonly rulesCode: string;
  readonly scriptName?: string;
  /** Game-specific setup passed to `create`; defaults to `{}` when omitted (the
   *  wire schema applies the same default at the route boundary). */
  readonly settings?: unknown;
  readonly participants?: readonly ExperienceParticipant[];
  readonly capabilityGrants?: readonly ExperienceCapability[];
  readonly seed?: string;
  /** Ordered action intentions to replay after create. An empty/omitted list
   *  yields a create-only run (discover + create + project + legal actions). */
  readonly actions?: readonly ExperienceAction[];
}

export interface ExperienceTestSimulateInput {
  readonly rulesCode: string;
  readonly scriptName?: string;
  /** Game-specific setup passed to `create`; defaults to `{}` when omitted. */
  readonly settings?: unknown;
  readonly participants?: readonly ExperienceParticipant[];
  readonly capabilityGrants?: readonly ExperienceCapability[];
  readonly seed?: string;
  readonly maxIterations?: number;
  readonly maxEffects?: number;
}

// ─── Small local helpers ─────────────────────────────────────────────────────
//
// Three tiny mirrors of helpers that live on the persistent ExperienceService
// module (seedToNumeric / viewerKindForController / resolveHumanViewer). They
// are reimplemented locally — against domain constants and the kernel's own
// deterministic-random construction — so the stateless tester's dependency graph
// is kernel + shared + domain + contracts ONLY: it never imports the persistent
// service module, honoring "never call the persistent ExperienceService for
// sequencing" while reusing the SAME algorithm (single source of truth for the
// RNG stream is the kernel's createDeterministicRandom, used below).

/** FNV-1a 32-bit hash of a seed string (mirrors experience-service.seedToNumeric). */
function hashSeedString(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The per-seat legality matrix at `state`: for EVERY roster participant, run
 *  the real `actions()` under that seat's own viewer and aggregate the legal
 *  types. A failing `actions()` does NOT fail the run — the seat entry carries
 *  the kernel message (`error`) so "cannot act" stays distinguishable from
 *  "blew up". `turnOwners` is empty on a terminal status (see the interface). */
function buildSeatLegalityMatrix(
  code: string,
  scriptName: string,
  state: unknown,
  status: ExperienceSessionStatus,
  grants: readonly ExperienceCapability[],
  participants: readonly ExperienceParticipant[],
  consoleBuf: ExperienceConsoleEntry[],
): ExperienceSeatLegalityMatrix {
  const seats: ExperienceSeatLegality[] = participants.map((p) => {
    const viewer: ExperienceViewer = {
      kind: viewerKindForController(p.controller),
      participantId: p.id,
    };
    const legal = runActions(code, scriptName, state, viewer, buildCapabilityContext(grants, participants));
    consoleBuf.push(...legal.console);
    if (!legal.ok) {
      return {
        participantId: p.id,
        label: p.label,
        controller: p.controller,
        actionTypes: [],
        count: 0,
        error: legal.message,
      };
    }
    return {
      participantId: p.id,
      label: p.label,
      controller: p.controller,
      actionTypes: [...new Set(legal.value.map((d) => d.type))],
      count: legal.value.length,
    };
  });
  const turnOwners =
    status === EXPERIENCE_SESSION_STATUS.active
      ? seats.filter((s) => s.error === undefined && s.count > 0).map((s) => s.participantId)
      : [];
  return { seats, turnOwners };
}

function viewerKindForController(controller: string): ExperienceViewer["kind"] {
  if (controller === EXPERIENCE_CONTROLLER.human) return EXPERIENCE_VIEWER_KIND.human;
  if (controller === EXPERIENCE_CONTROLLER.script) return EXPERIENCE_VIEWER_KIND.script;
  if (controller === EXPERIENCE_CONTROLLER.model) return EXPERIENCE_VIEWER_KIND.model;
  return EXPERIENCE_VIEWER_KIND.observer;
}

/** The viewer the response projection is computed for: the human seat, or the
 *  observer view when the roster has no human-controlled seat. */
function resolveProjectionViewer(participants: readonly ExperienceParticipant[]): ExperienceViewer {
  const human = participants.find((p) => p.controller === EXPERIENCE_CONTROLLER.human);
  return human !== undefined
    ? { kind: EXPERIENCE_VIEWER_KIND.human, participantId: human.id }
    : { kind: EXPERIENCE_VIEWER_KIND.observer };
}

/** Resolve the viewer a submitted action is for: the named seat (kind derived
 *  from its controller), or the projection viewer when no participantId is given. */
function resolveViewerForAction(
  participants: readonly ExperienceParticipant[],
  participantId?: string,
): ExperienceViewer {
  if (participantId !== undefined) {
    const p = participants.find((seat) => seat.id === participantId);
    if (p !== undefined) {
      return { kind: viewerKindForController(p.controller), participantId: p.id };
    }
    return { kind: EXPERIENCE_VIEWER_KIND.human, participantId };
  }
  return resolveProjectionViewer(participants);
}

// ─── Error construction ──────────────────────────────────────────────────────

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
 * Map a kernel/sandbox failure to a typed tester error, merging the console
 * captured so far with the failing call's console. Mirrors the persistent
 * service's `fromKernelError` classification: validation-shaped kinds become
 * `validation_error`, an `illegal_action` keeps its code, and everything else
 * (timeout/syntax/runtime/no_registration/multi_registration/missing_method/
 * async_return) becomes `vm_error` carrying the kernel `kind`.
 */
function fromKernel(
  e: ExperienceKernelError,
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

// ─── Shared discovery + capability-gate preamble ────────────────────────────

interface DiscoveredPreamble {
  readonly definition: ExperienceDefinition;
  readonly sourceHash: string;
  readonly console: readonly ExperienceConsoleEntry[];
}

/**
 * Discover one definition from raw source and enforce the granted ⊆ declared
 * capability gate. Returns the validated definition + source hash + discovery
 * console on success, or the first typed error (discovery failure or an
 * over-granted capability) on failure. A discovery failure runs no further step.
 */
function discoverAndGate(
  input: {
    readonly rulesCode: string;
    readonly scriptName?: string;
    readonly capabilityGrants?: readonly ExperienceCapability[];
  },
): { readonly ok: true; readonly data: DiscoveredPreamble } | { readonly ok: false; readonly error: ExperienceTestError } {
  const discovery = discoverExperienceDefinition(
    input.rulesCode,
    input.scriptName ?? DEFAULT_SCRIPT_NAME,
  );
  if (!discovery.ok) {
    return { ok: false, error: fromKernel(discovery, []) };
  }
  const consoleBuf: ExperienceConsoleEntry[] = [...discovery.console];
  const grants = input.capabilityGrants ?? [];
  const undeclared = undeclaredGrantedCapabilities(
    discovery.definition.declaredCapabilities,
    grants,
  );
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
  return {
    ok: true,
    data: {
      definition: discovery.definition,
      sourceHash: discovery.sourceHash,
      console: consoleBuf,
    },
  };
}

// ─── Projection (degrades gracefully, mirroring the service) ────────────────

/**
 * Project the final state for the response viewer. Degrades to `{ state: null,
 * actions: [] }` on a project/actions failure (the run already succeeded; a
 * projection fault is surfaced via the captured console rather than discarding
 * the authoritative result). Projections are deterministic — no random/chance.
 */
function projectForResponse(
  code: string,
  scriptName: string,
  state: unknown,
  viewer: ExperienceViewer,
  grants: readonly ExperienceCapability[],
  participants: readonly ExperienceParticipant[],
  consoleBuf: ExperienceConsoleEntry[],
): ExperienceTestProjection {
  const caps = buildCapabilityContext(grants, participants);
  const projected = runProject(code, scriptName, state, viewer, caps);
  if (!projected.ok) {
    consoleBuf.push(...projected.console);
    return { state: null, actions: [] };
  }
  consoleBuf.push(...projected.console);
  const legal = runActions(code, scriptName, state, viewer, caps);
  if (!legal.ok) {
    consoleBuf.push(...legal.console);
    return { state: projected.value, actions: [] };
  }
  consoleBuf.push(...legal.console);
  return { state: projected.value, actions: legal.value };
}

// ─── run: discover + create + replay actions ─────────────────────────────────

/**
 * Drive unsaved rules source through the real kernel: discover, create the
 * initial authoritative state, then replay an ordered list of action intentions
 * (each carrying requestId + expectedRevision) with the host managing the
 * in-memory revision counter, requestId idempotency, and expectedRevision CAS.
 * Returns the discovered definition, the initial + final authoritative state,
 * the projected view for the human seat, all emitted events, all requested
 * effects (reported, never executed), the captured console, and a per-step
 * trace. See the module doc for the idempotency / CAS / capability semantics.
 */
export function runExperienceTest(input: ExperienceTestRunInput): ExperienceTestRunResult {
  const preamble = discoverAndGate(input);
  if (!preamble.ok) return preamble;
  const { definition, sourceHash } = preamble.data;

  const consoleBuf: ExperienceConsoleEntry[] = [...preamble.data.console];
  const scriptName = input.scriptName ?? DEFAULT_SCRIPT_NAME;
  const code = input.rulesCode;
  const grants = input.capabilityGrants ?? [];
  const participants = input.participants ?? [];
  const settings = input.settings ?? {};

  // One deterministic-random stream advanced across create + every reduce, so
  // the same seed + action sequence reproduces identical draws (replay parity).
  const rng = createDeterministicRandom(hashSeedString(input.seed ?? DEFAULT_SEED));

  const createCaps = buildCapabilityContext(grants, participants, rng);
  const created = runCreate(code, scriptName, settings, createCaps);
  if (!created.ok) return { ok: false, error: fromKernel(created, consoleBuf) };
  consoleBuf.push(...created.console);

  let state: unknown = created.value;
  let revision = 0;
  let status: ExperienceSessionStatus = EXPERIENCE_SESSION_STATUS.active;

  const events: ExperienceEvent[] = [];
  const effects: ExperienceEffectRequest[] = [];
  const steps: ExperienceTestStepTrace[] = [];
  // requestId → the applied step (idempotency: a duplicate replays this).
  const applied = new Map<string, ExperienceTestStepTrace>();

  for (const action of input.actions ?? []) {
    if (status === EXPERIENCE_SESSION_STATUS.completed) break;

    // 1. Idempotency FIRST (mirrors the service): a duplicate requestId replays
    //    the prior step and does NOT re-reduce or advance the revision.
    const prior = applied.get(action.requestId);
    if (prior !== undefined) {
      steps.push({ ...prior, replayed: true, revision });
      continue;
    }

    // 2. CAS: the action must claim the current in-memory revision.
    if (action.expectedRevision !== revision) {
      return {
        ok: false,
        error: testError(
          409,
          "stale_revision",
          `Action expected revision ${action.expectedRevision}, run is at ${revision}`,
          consoleBuf,
          { currentRevision: revision },
        ),
      };
    }

    // 3. Legal-action pre-check for this participant (real VM actions()).
    const viewer = resolveViewerForAction(participants, action.participantId);
    const legal = runActions(code, scriptName, state, viewer, buildCapabilityContext(grants, participants));
    if (!legal.ok) return { ok: false, error: fromKernel(legal, consoleBuf) };
    consoleBuf.push(...legal.console);
    const valid = validateSubmittedAction(action, legal.value);
    if (!valid.ok) return { ok: false, error: fromKernel(valid, consoleBuf) };

    // 4. Reduce under the real VM (random injected if granted; cursor advances).
    const reduceCaps = buildCapabilityContext(grants, participants, rng);
    const reduced = runReduce(code, scriptName, state, action, reduceCaps);
    if (!reduced.ok) return { ok: false, error: fromKernel(reduced, consoleBuf) };
    consoleBuf.push(...reduced.console);
    const transition = reduced.value;

    revision += 1;
    state = transition.state;
    status = transition.status;
    for (const ev of transition.events) events.push(ev);
    if (transition.effects !== undefined) {
      for (const ef of transition.effects) effects.push(ef);
    }

    const step: ExperienceTestStepTrace = {
      requestId: action.requestId,
      actionType: action.type,
      ...(action.participantId !== undefined ? { participantId: action.participantId } : {}),
      replayed: false,
      revision,
      status,
      events: transition.events,
      effects: transition.effects ?? [],
      console: reduced.console,
    };
    steps.push(step);
    applied.set(action.requestId, step);
  }

  const projectionViewer = resolveProjectionViewer(participants);
  const projection = projectForResponse(
    code,
    scriptName,
    state,
    projectionViewer,
    grants,
    participants,
    consoleBuf,
  );

  // Per-seat legality matrix at the FINAL state (post-replay; for a create-only
  // run that IS the initial state). Computed after the projection so a failing
  // per-seat `actions()` cannot shadow the run result (it becomes seat.error).
  const seatLegality = buildSeatLegalityMatrix(code, scriptName, state, status, grants, participants, consoleBuf);

  return {
    ok: true,
    data: {
      definition,
      sourceHash,
      initialState: created.value,
      finalState: state,
      revision,
      status,
      projection,
      events,
      effects,
      console: consoleBuf,
      steps,
      seatLegality,
    },
  };
}

// ─── simulate: bounded script-seat advancement ───────────────────────────────

/**
 * Discover + create, then run a bounded automated simulation that advances
 * script-controlled seats via the real `choose` (where declared), reducing each
 * chosen action, until the boundary reaches a human/model seat, the status
 * becomes terminal, no legal action remains, or a host bound (max iterations /
 * max effects) is reached. Returns the typed stop-reason diagnostic for each
 * case rather than pretending arbitrary games must terminate. Mirrors the
 * persistent service's `advanceScriptTurns` + `findActor` sequencing, but
 * in-memory and stateless across requests.
 */
export function simulateExperienceTest(input: ExperienceTestSimulateInput): ExperienceTestSimulateResult {
  const preamble = discoverAndGate(input);
  if (!preamble.ok) return preamble;
  const { definition, sourceHash } = preamble.data;

  const consoleBuf: ExperienceConsoleEntry[] = [...preamble.data.console];
  const scriptName = input.scriptName ?? DEFAULT_SCRIPT_NAME;
  const code = input.rulesCode;
  const grants = input.capabilityGrants ?? [];
  const participants = input.participants ?? [];
  const settings = input.settings ?? {};
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxEffects = input.maxEffects ?? DEFAULT_MAX_EFFECTS;

  const rng = createDeterministicRandom(hashSeedString(input.seed ?? DEFAULT_SEED));

  const createCaps = buildCapabilityContext(grants, participants, rng);
  const created = runCreate(code, scriptName, settings, createCaps);
  if (!created.ok) return { ok: false, error: fromKernel(created, consoleBuf) };
  consoleBuf.push(...created.console);

  let state: unknown = created.value;
  let revision = 0;
  let status: ExperienceSessionStatus = EXPERIENCE_SESSION_STATUS.active;

  const events: ExperienceEvent[] = [];
  const effects: ExperienceEffectRequest[] = [];
  const steps: ExperienceTestStepTrace[] = [];
  let stopReason: ExperienceTestStopReason | null = null;
  let stopDetail: { participantId?: string } | undefined;
  let iterations = 0;

  while (stopReason === null) {
    if (iterations >= maxIterations) {
      stopReason = "bounded_non_termination";
      break;
    }

    // findActor: the first participant (in roster order) with legal actions.
    let actor: {
      participant: ExperienceParticipant;
      viewer: ExperienceViewer;
      legal: ExperienceActionDescriptor[];
    } | null = null;
    for (const p of participants) {
      const viewer: ExperienceViewer = {
        kind: viewerKindForController(p.controller),
        participantId: p.id,
      };
      const legal = runActions(code, scriptName, state, viewer, buildCapabilityContext(grants, participants));
      consoleBuf.push(...legal.console);
      if (legal.ok && legal.value.length > 0) {
        actor = { participant: p, viewer, legal: legal.value };
        break;
      }
    }

    if (actor === null) {
      // Nobody has legal actions. A completed status would have broken out of
      // the reduce path in a prior iteration (and create never yields
      // completed), so reaching here with no actor is a genuine stuck position.
      stopReason = "no_legal_action";
      break;
    }

    const controller = actor.participant.controller;
    if (controller === EXPERIENCE_CONTROLLER.human) {
      stopReason = "awaiting_human";
      break;
    }
    if (controller === EXPERIENCE_CONTROLLER.model) {
      stopReason = "awaiting_model";
      break;
    }

    // script-controlled seat: requires the optional `choose` method.
    if (!definition.hasChoose) {
      stopReason = "no_choose_method";
      stopDetail = { participantId: actor.participant.id };
      break;
    }

    // choose (ephemeral chance; no deterministic-cursor draw) → reduce.
    const chooseCaps = buildCapabilityContext(grants, participants, undefined, createEphemeralRandom());
    const chosen = runChoose(code, scriptName, state, actor.viewer, actor.legal, chooseCaps);
    if (!chosen.ok) return { ok: false, error: fromKernel(chosen, consoleBuf) };
    consoleBuf.push(...chosen.console);
    const intent = chosen.value;

    const chosenAction: ExperienceAction = {
      type: intent.type,
      requestId: `auto:sim:${revision + 1}`,
      expectedRevision: revision,
      participantId: intent.participantId ?? actor.participant.id,
      ...(intent.payload !== undefined ? { payload: intent.payload } : {}),
    };

    const reduceCaps = buildCapabilityContext(grants, participants, rng);
    const reduced = runReduce(code, scriptName, state, chosenAction, reduceCaps);
    if (!reduced.ok) return { ok: false, error: fromKernel(reduced, consoleBuf) };
    consoleBuf.push(...reduced.console);
    const transition = reduced.value;

    iterations += 1;
    revision += 1;
    state = transition.state;
    status = transition.status;
    for (const ev of transition.events) events.push(ev);
    if (transition.effects !== undefined) {
      for (const ef of transition.effects) effects.push(ef);
    }

    steps.push({
      requestId: chosenAction.requestId,
      actionType: chosenAction.type,
      participantId: chosenAction.participantId,
      replayed: false,
      revision,
      status,
      events: transition.events,
      effects: transition.effects ?? [],
      console: reduced.console,
    });

    if (status === EXPERIENCE_SESSION_STATUS.completed) {
      stopReason = "completed";
      break;
    }
    if (effects.length >= maxEffects) {
      stopReason = "effects_bound";
      break;
    }
  }
  if (stopReason === null) stopReason = "bounded_non_termination";

  return {
    ok: true,
    data: {
      definition,
      sourceHash,
      initialState: created.value,
      finalState: state,
      revision,
      status,
      events,
      effects,
      console: consoleBuf,
      steps,
      stopReason,
      iterations,
      ...(stopDetail !== undefined ? { stopDetail } : {}),
    },
  };
}
