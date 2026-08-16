/**
 * Experience lifecycle service (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 3 / IR-31).
 *
 * Sits between the IR-12 kernel (pure VM runners) and the IR-21 store (durable
 * sessions/journal/effects). Owns: definition discovery at start, chat-ownership
 * + capability checks, pinned source-snapshot capture, session start/resume/end,
 * per-viewer projection, legal-action discovery, single-action dispatch through
 * the real VM + atomic CAS store transition, the synchronous script-controller
 * loop, deterministic-random cursor tracking across resume, and pending model-
 * effect persistence (the executor that RUNS them is Wave 4).
 *
 * Two design decisions (resolved by the Wave 3 contract revision — 4 mandatory
 * + 2 optional methods):
 *
 *  1. Script-controlled chooser — EXPLICIT `choose`. The optional `choose`
 *     method drives a script seat's turn: the host calls `actions(viewer)` for
 *     the legal set, then `choose({viewer, legal})` for the script's pick, and
 *     reduces it. No implicit "first action"; a script seat with legal actions
 *     but no `choose` is a typed `no_choose_method` error.
 *
 *  2. Two random sources. `context.random` (deterministic, cursor-counting) is
 *     injected for create/reduce only (granted by `deterministic_random`); the
 *     persisted cursor counts create+reduce draws, so resume + recalculation
 *     replay reproduce the exact stream. `context.chance` (ephemeral,
 *     Math.random, non-recorded) is injected into `choose`/`flavor` only — it
 *     lets a script make a varied move or cosmetic detail without disturbing
 *     the cursor (Variant Б of the choose-randomness design).
 *
 * Isolation invariant: imports only the kernel, the resource service, the store
 * container, and domain/shared helpers. No prompt assembly, no provider calls,
 * no EventBus. Model-effect execution is Wave 4.
 */

import type { ExperienceEffectRow, ExperienceSessionRow, StoreContainer } from "@vibe-tavern/db";
import {
  EXPERIENCE_CAPABILITY,
  EXPERIENCE_CONTROLLER,
  EXPERIENCE_VIEWER_KIND,
  type ExperienceAction,
  type ExperienceActionDescriptor,
  type ExperienceCapability,
  type ExperienceContextMode,
  type ExperienceEvent,
  type ExperienceParticipant,
  type ExperiencePublicReport,
  type ExperienceSessionStatus,
  type ExperienceViewer,
} from "@vibe-tavern/domain";

import {
  createEphemeralRandom,
  createMulberry32,
  runActions,
  runChoose,
  runCreate,
  runFlavor,
  runProject,
  runReduce,
  validateSubmittedAction,
  type DeterministicRandom,
  type EphemeralRandom,
  type ExperienceCapabilityContext,
} from "./experience-kernel.js";
import {
  type ExperienceApiError,
  type ExperienceResult,
  type ModelEffectRequestPayload,
  type TimerEffectRequestPayload,
  buildCapabilityContext,
  err,
  fromKernelError,
  ok,
} from "./experience-shared.js";
import {
  type ResolvedRulesSource,
  type ResolvedVisualSource,
  ExperienceResourceService,
} from "./experience-resource-service.js";
import { ExperienceReportService, toQueuedAttachmentView, type ExperienceReportStatus } from "./experience-report-service.js";
import { ExperienceChatterService } from "./experience-chatter-service.js";

// ─── Counting RNG (cursor tracking) ─────────────────────────────────────────

/**
 * A deterministic-random wrapper that counts every draw so the lifecycle service
 * can persist the cursor and resume the exact stream. Built on the kernel's
 * mulberry32 primitive (single source of truth). Pre-advances `startCursor`
 * discarded draws on construction (resume fast-path); {@link totalDraws} reports
 * the absolute cursor including that pre-advance.
 */
export function createCountingRandom(seed: number, startCursor: number): {
  random: DeterministicRandom;
  totalDraws: () => number;
} {
  const core = createMulberry32(seed);
  for (let i = 0; i < startCursor; i += 1) core.next();
  let draws = startCursor;
  // Wrap next() so every draw is counted, then delegate to a standard
  // DeterministicRandom built on the SAME advanced core.
  const countingNext = (): number => {
    draws += 1;
    return core.next();
  };
  // Rebuild the DeterministicRandom surface against countingNext rather than
  // createDeterministicRandom (which would re-seed from zero).
  const random: DeterministicRandom = {
    float: () => countingNext(),
    int: (min, max) => {
      if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
        throw new RangeError("random.int: min and max must be integers with min <= max");
      }
      return Math.floor(countingNext() * (max - min + 1)) + min;
    },
    die: (sides) => {
      if (!Number.isInteger(sides) || sides < 1) {
        throw new RangeError("random.die: sides must be a positive integer");
      }
      return Math.floor(countingNext() * sides) + 1;
    },
    pick: <T>(items: readonly T[]): T => {
      if (!Array.isArray(items) || items.length === 0) {
        throw new RangeError("random.pick: a non-empty array is required");
      }
      return items[Math.floor(countingNext() * items.length)]!;
    },
    shuffle: <T>(items: readonly T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(countingNext() * (i + 1));
        [out[i]!, out[j]!] = [out[j]!, out[i]!];
      }
      return out;
    },
    weightedPick: <T extends { weight: number }>(items: readonly T[]): T => {
      if (!Array.isArray(items) || items.length === 0) {
        throw new RangeError("random.weightedPick: a non-empty array is required");
      }
      const total = items.reduce((sum, it) => sum + (Number(it.weight) || 0), 0);
      let roll = countingNext() * total;
      for (const it of items) {
        roll -= Number(it.weight) || 0;
        if (roll <= 0) return it;
      }
      return items[items.length - 1]!;
    },
  };
  return { random, totalDraws: () => draws };
}

/** Hash a string seed to a 32-bit number (FNV-1a, same family as dice revisions). */
export function seedToNumeric(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// ─── View types ──────────────────────────────────────────────────────────────

export interface ExperienceSessionView {
  sessionId: string;
  chatId: string;
  branchId: string;
  status: ExperienceSessionStatus;
  revision: number;
  manifest: { id: string; name: string };
  apiVersion: number;
  participants: ExperienceParticipant[];
  capabilityGrants: ExperienceCapability[];
  contextMode: ExperienceContextMode;
  rulesRevision: number;
  rulesSourceHash: string;
  visualId: string | null;
  /** Pinned visual source snapshot (IR-70G; client-executable, no hidden state). */
  visualSource: string | null;
  visualSourceHash: string | null;
  reportFrontier: number;
}

export interface ExperienceProjection {
  state: unknown;
  actions: ExperienceActionDescriptor[];
  /** Cosmetic display data from the optional `flavor` method (best-effort; may be absent). */
  flavor?: unknown;
  revision: number;
  status: ExperienceSessionStatus;
}

/** Privacy-safe queued-attachment view (IR-70A). A dedicated public DTO that
 *  exposes ONLY what the client needs for display / commit intent — it is the
 *  attachment row MINUS `hiddenStateCheckpointJson`. The hidden authoritative
 *  checkpoint is read only on branch-fork restore (IR-53), never on a client
 *  read; mirroring it here would leak private game state to the visual. */
export interface ExperienceQueuedAttachmentView {
  id: string;
  chatId: string;
  branchId: string;
  sessionId: string;
  sessionRevision: number;
  queueRevision: number;
  kind: string;
  /** Parsed public report envelope (`{ title, summary?, events[] }`); null when
   *  the stored JSON was malformed (defensive — should not happen for a
   *  properly queued attachment). Never derived from hidden state. */
  publicReport: ExperiencePublicReport | null;
  rulesSourceHash: string;
  visualSourceHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TurnAwait = "human" | "model" | "completed" | "idle";

export interface AppliedAction {
  session: ExperienceSessionView;
  projection: ExperienceProjection;
  events: ExperienceEvent[];
  replayed: boolean;
  await: TurnAwait;
}

export interface StartSessionInput {
  chatId: string;
  branchId: string;
  /** Game-specific setup passed to `create`. */
  settings: unknown;
  /** Seat roster. The host uses it for turn detection + per-viewer projection. */
  participants: ExperienceParticipant[];
}

/** VM + projection context the model-effect service needs to build its prompt. */
export interface ModelEffectVmContext {
  effect: ExperienceEffectRow;
  request: ModelEffectRequestPayload;
  viewer: ExperienceViewer;
  participant: ExperienceParticipant;
  /** The model seat's projected private view (the only hidden material it sees). */
  projectedView: unknown;
  /** Legal actions for action mode (empty for text mode). */
  legalActions: ExperienceActionDescriptor[];
  rules: ResolvedRulesSource;
  state: unknown;
  participants: ExperienceParticipant[];
  grants: ExperienceCapability[];
  chatId: string;
  characterId: string | null;
}

/** VM context the timer-effect service needs to fire a tick. */
export interface TimerEffectVmContext {
  effect: ExperienceEffectRow;
  request: TimerEffectRequestPayload;
  viewer: ExperienceViewer;
  participant: ExperienceParticipant;
  /** Legal actions for the viewer at claim time (the tick must be among them). */
  legalActions: ExperienceActionDescriptor[];
}

/** Outcome of an effect-result feed-back (acceptance is the CAS). */
export interface EffectDelivery {
  delivered: boolean;
  /** Present when the session advanced past the originating revision. */
  reason?: "stale";
  session: ExperienceSessionView;
  projection: ExperienceProjection;
}

/** Parse + validate a persisted effect's `{ kind, request }` envelope into the V1 model-effect payload. */
export function parseModelEffectRequest(requestJson: string): ModelEffectRequestPayload | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(requestJson);
  } catch {
    return null;
  }
  if (typeof envelope !== "object" || envelope === null) return null;
  const req = (envelope as { request?: unknown }).request;
  if (typeof req !== "object" || req === null) return null;
  const r = req as Record<string, unknown>;
  if (typeof r.viewer !== "string" || (r.mode !== "action" && r.mode !== "text")) return null;
  if (r.mode === "text" && typeof r.actionType !== "string") return null;
  return {
    viewer: r.viewer,
    mode: r.mode,
    ...(typeof r.actionType === "string" ? { actionType: r.actionType } : {}),
    ...(typeof r.instruction === "string" ? { instruction: r.instruction } : {}),
  };
}

/** Parse + strictly validate a persisted effect's `{ kind, request }` envelope
 *  into the timer-effect payload. Unlike the lenient model parser, this rejects
 *  any unknown key and enforces the `afterMs` bound, so a malformed timer
 *  request fails here (and later persists as a validation error) rather than
 *  reaching the scheduler. */
export function parseTimerEffectRequest(requestJson: string): TimerEffectRequestPayload | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(requestJson);
  } catch {
    return null;
  }
  if (typeof envelope !== "object" || envelope === null) return null;
  const env = envelope as Record<string, unknown>;
  if (env.kind !== "timer") return null;
  const req = env.request;
  if (typeof req !== "object" || req === null) return null;
  const r = req as Record<string, unknown>;
  // Strict: exactly the known keys, nothing else.
  const allowed = new Set(["viewer", "actionType", "afterMs", "args"]);
  for (const key of Object.keys(r)) {
    if (!allowed.has(key)) return null;
  }
  if (typeof r.viewer !== "string" || r.viewer.length === 0) return null;
  if (typeof r.actionType !== "string" || r.actionType.length === 0) return null;
  if (typeof r.afterMs !== "number" || !Number.isInteger(r.afterMs)) return null;
  if (r.afterMs <= 0 || r.afterMs > 2_147_483_647) return null;
  return {
    viewer: r.viewer,
    actionType: r.actionType,
    afterMs: r.afterMs,
    ...(r.args !== undefined ? { args: r.args } : {}),
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────

const MAX_SCRIPT_TURNS = 200;
/** Max delivery attempts for one completed effect (fix item 11): attempt 1 is
 *  the IR-22 optimistic CAS at the originating revision; on stale_revision the
 *  delivery re-originates against the current frontier (reload + reduce at the
 *  current state + apply at the observed revision), bounded by this constant.
 *  Timer effects keep the intentional stale-drop (2c) via a single attempt. */
const EFFECT_DELIVERY_MAX_ATTEMPTS = 3;

export class ExperienceService {
  private readonly stores: StoreContainer;
  private readonly resources: ExperienceResourceService;
  private readonly generateSeed: () => string;
  private readonly reports: ExperienceReportService;
  /** Async flavor chatter (item 4): null = flavor passes through unchanged
   *  (the pre-AC-2 behavior — playgrounds/tests without provider access). */
  private readonly chatter: ExperienceChatterService | null;

  constructor(
    stores: StoreContainer,
    resources: ExperienceResourceService,
    deps: { generateSeed?: () => string; reportService?: ExperienceReportService; chatter?: ExperienceChatterService } = {},
  ) {
    this.stores = stores;
    this.resources = resources;
    this.generateSeed = deps.generateSeed ?? defaultGenerateSeed;
    this.reports = deps.reportService ?? new ExperienceReportService(stores);
    this.chatter = deps.chatter ?? null;
  }

  // ─── Session lifecycle ────────────────────────────────────────────────────

  /**
   * Start a new session for a chat+branch: resolve the enabled setup, validate
   * the roster, run `create` under the real VM, capture pinned rules/visual
   * snapshots, and persist the session at revision 0. Throws branch_has_active
   * (typed) if the branch already has an active session.
   */
  async startSession(input: StartSessionInput): Promise<ExperienceResult<ExperienceSessionView>> {
    const chat = await this.stores.chats.getById(input.chatId);
    if (chat === null) {
      return err({ status: 404, code: "chat_not_found", message: `Chat '${input.chatId}' not found` });
    }
    const branch = await this.findBranch(input.chatId, input.branchId);
    if (branch === null) {
      return err({ status: 404, code: "branch_not_found", message: `Branch '${input.branchId}' not found` });
    }

    const setup = await this.resources.resolveEffectiveSetup(input.chatId);
    if (!setup.ok) return setup;
    if (!setup.data.enabled || setup.data.rules === null) {
      return err({ status: 409, code: "not_enabled", message: "Interactive experience is not configured for this chat" });
    }
    const rules = setup.data.rules;
    const visual = setup.data.visual;
    const grants = setup.data.capabilityGrants;

    // V1: at most one human-controlled seat.
    const humanSeats = input.participants.filter((p) => p.controller === EXPERIENCE_CONTROLLER.human);
    if (humanSeats.length > 1) {
      return err({
        status: 422,
        code: "validation_error",
        message: "At most one participant may be human-controlled in V1",
      });
    }

    // IR-70E: validate the NEW-session participant assignments at the service
    // boundary (mirrors the HTTP schema so a direct caller cannot bypass it).
    // A model-controlled seat must pin BOTH a nonblank providerProfileId and
    // modelId and requires the `model` capability grant; a human/script seat
    // must carry NEITHER. Legacy persisted participants (neither field) are a
    // load-time concern, never accepted as a new start.
    const participantError = validateParticipantsForStart(input.participants, grants);
    if (participantError !== null) return err(participantError);

    // Report item 6b: freeze each character-backed model seat's card into the
    // persisted roster. The card must exist at start (a clean 404 beats a silent
    // label-only seat); after start, deleting the source character cannot
    // corrupt the session — the snapshot is frozen inside participantsJson.
    const enrichedParticipants: ExperienceParticipant[] = [];
    for (const seat of input.participants) {
      if (seat.characterId === undefined) {
        enrichedParticipants.push(seat);
        continue;
      }
      const characterRow = await this.stores.characters.getById(seat.characterId);
      if (characterRow === null) {
        return err({
          status: 404,
          code: "character_not_found",
          message: `Participant '${seat.label || seat.id}' references character '${seat.characterId}' that was not found`,
        });
      }
      enrichedParticipants.push({
        ...seat,
        character: {
          id: characterRow.id,
          name: characterRow.name,
          description: characterRow.description,
          scenario: characterRow.defaultScenario,
          personality: characterRow.personalitySummary,
        },
      });
    }

    // Run create under the real VM, with random injected only if granted.
    const seed = this.generateSeed();
    const numericSeed = seedToNumeric(seed);
    const createRng = createCountingRandom(numericSeed, 0);
    const caps = this.buildCaps(grants, enrichedParticipants, createRng.random);
    const created = runCreate(rules.code, rules.scriptName, input.settings, caps);
    if (!created.ok) return err(fromKernelError(created));
    const initialState = created.value;
    const cursorAfterCreate = createRng.totalDraws();

    // `create()` emits state rather than reportable events. The revision-zero
    // attachment therefore records only an explicit public setup projection,
    // never the authoritative state supplied to the store below.
    const startViewer: ExperienceViewer = { kind: EXPERIENCE_VIEWER_KIND.observer };
    const startCaps = this.buildCaps(grants, enrichedParticipants, undefined, createEphemeralRandom());
    const startProjection = runProject(rules.code, rules.scriptName, initialState, startViewer, startCaps);
    if (!startProjection.ok) return err(fromKernelError(startProjection));
    const startActions = runActions(rules.code, rules.scriptName, initialState, startViewer, startCaps);
    if (!startActions.ok) return err(fromKernelError(startActions));

    const created_row = this.stores.experiences.createSessionWithInitialReport({
      chatId: input.chatId,
      branchId: input.branchId,
      rulesId: rules.scriptId,
      rulesLabel: rules.scriptName,
      rulesRevision: rules.revision,
      rulesSource: rules.code,
      rulesSourceHash: rules.sourceHash,
      visualId: visual?.visualId ?? null,
      visualLabel: visual?.name ?? null,
      visualRevision: visual?.revision ?? null,
      visualSource: visual?.source ?? null,
      visualSourceHash: visual?.sourceHash ?? null,
      apiVersion: rules.definition.apiVersion,
      manifestId: rules.definition.manifest.id,
      manifestName: rules.definition.manifest.name,
      initialSettingsJson: safeStringify(input.settings),
      currentStateJson: safeStringify(initialState),
      participantsJson: safeStringify(enrichedParticipants),
      capabilityGrantsJson: safeStringify(grants),
      contextMode: setup.data.contextMode,
      randomSeed: seed,
      randomCursor: cursorAfterCreate,
    }, (session) => this.reports.buildStartReport(session, {
      projection: startProjection.value,
      legalActions: startActions.value,
      participants: enrichedParticipants,
    }));
    if (!created_row.ok) {
      return err({
        status: 409,
        code: "branch_has_active",
        message: `Branch '${input.branchId}' already has an active experience session`,
      });
    }

    return ok(this.toSessionView(created_row.session));
  }

  /** Load a session's current view (no VM call). */
  async resumeSession(sessionId: string): Promise<ExperienceResult<ExperienceSessionView>> {
    const session = await this.stores.experiences.getSessionById(sessionId);
    if (session === null) {
      return err({ status: 404, code: "session_not_found", message: `Session '${sessionId}' not found` });
    }
    return ok(this.toSessionView(session));
  }

  /**
   * Resolve the active session for a chat + branch (IR-70A). Verifies the chat
   * exists, the branch belongs to the chat, and a session is currently active
   * for that branch — each returning a typed 404 so the client can distinguish
   * the cause. Never fabricates or persists state: this is a pure read of the
   * authoritative `activeSlot` claim created by {@link startSession}.
   */
  async getActiveSessionForBranch(
    chatId: string,
    branchId: string,
  ): Promise<ExperienceResult<ExperienceSessionView>> {
    const chat = await this.stores.chats.getById(chatId);
    if (chat === null) {
      return err({ status: 404, code: "chat_not_found", message: `Chat '${chatId}' not found` });
    }
    const branch = await this.findBranch(chatId, branchId);
    if (branch === null) {
      return err({ status: 404, code: "branch_not_found", message: `Branch '${branchId}' not found` });
    }
    const session = await this.stores.experiences.getActiveSessionForBranch(branchId);
    if (session === null) {
      return err({ status: 404, code: "no_active_session", message: `No active experience session for branch '${branchId}'` });
    }
    return ok(this.toSessionView(session));
  }

  // ─── Projection ───────────────────────────────────────────────────────────

  /**
   * Project the current state for a viewer (real VM `project` + `actions`).
   * Hidden information is enforced by the author's per-viewer projection; this
   * method never injects random (projections are deterministic).
   */
  async getProjectedView(
    sessionId: string,
    viewer: ExperienceViewer,
  ): Promise<ExperienceResult<ExperienceProjection>> {
    const ctx = await this.loadSessionForVm(sessionId);
    if (!ctx.ok) return ctx;
    const caps = this.buildCaps(ctx.data.grants, ctx.data.participants, undefined, createEphemeralRandom());
    const state = ctx.data.state;

    const projected = runProject(ctx.data.rules.code, ctx.data.rules.scriptName, state, viewer, caps);
    if (!projected.ok) return err(fromKernelError(projected));
    const legal = runActions(ctx.data.rules.code, ctx.data.rules.scriptName, state, viewer, caps);
    if (!legal.ok) return err(fromKernelError(legal));

    const flavorRes = runFlavor(ctx.data.rules.code, ctx.data.rules.scriptName, state, viewer, caps);
    return ok({
      state: projected.value,
      actions: legal.value,
      flavor: this.chatter === null
        ? (flavorRes.ok ? flavorRes.value : undefined)
        : this.chatter.resolveChatterFlavor(sessionId, viewer, ctx.data.revision, flavorRes.ok ? flavorRes.value : undefined, ctx.data.participants),
      revision: ctx.data.revision,
      status: ctx.data.status,
    });
  }

  /** Legal actions for a viewer at the current revision (real VM `actions`). */
  async getLegalActions(
    sessionId: string,
    viewer: ExperienceViewer,
  ): Promise<ExperienceResult<ExperienceActionDescriptor[]>> {
    const ctx = await this.loadSessionForVm(sessionId);
    if (!ctx.ok) return ctx;
    const caps = this.buildCaps(ctx.data.grants, ctx.data.participants);
    const legal = runActions(ctx.data.rules.code, ctx.data.rules.scriptName, ctx.data.state, viewer, caps);
    if (!legal.ok) return err(fromKernelError(legal));
    return ok(legal.value);
  }

  // ─── Action dispatch ──────────────────────────────────────────────────────

  /**
   * Apply ONE submitted action (human or script) through the real VM reducer +
   * atomic CAS store transition. Validates the action is in the legal set for
   * its participant before reducing. Persists the new random cursor and any
   * emitted model-effect requests as pending rows (Wave 4 runs them). Does NOT
   * auto-advance script turns — call {@link advanceScriptTurns} afterwards.
   */
  async submitAction(
    sessionId: string,
    action: ExperienceAction,
  ): Promise<ExperienceResult<AppliedAction>> {
    const ctx = await this.loadSessionForVm(sessionId);
    if (!ctx.ok) return ctx;
    const { rules, grants, participants } = ctx.data;

    // 1. Idempotency — a duplicate requestId returns the prior transition's
    //    result (never re-applies). Must precede the CAS check: a retried
    //    duplicate carries the ORIGINAL (now-stale) expectedRevision.
    if (action.requestId !== null) {
      const prior = await this.stores.experiences.getStepByRequestId(sessionId, action.requestId);
      if (prior !== null) {
        const session = await this.viewById(sessionId);
        const projection = await this.projectForResponseById(sessionId, rules, ctx.data.state, participants);
        return ok({
          session,
          projection,
          events: parseJson<ExperienceEvent[]>(prior.emittedEventsJson, []),
          replayed: true,
          await: session.status === "completed" ? "completed" : "human",
        });
      }
    }

    // 2. CAS — the action must claim the current revision.
    if (action.expectedRevision !== ctx.data.revision) {
      return err({
        status: 409,
        code: "stale_revision",
        message: `Action expected revision ${action.expectedRevision}, session is at ${ctx.data.revision}`,
        currentRevision: ctx.data.revision,
      });
    }

    // Validate against the legal set for this participant (real VM actions()).
    const viewer = resolveHumanViewer(participants, action.participantId);
    const legal = runActions(rules.code, rules.scriptName, ctx.data.state, viewer, this.buildCaps(grants, participants));
    if (!legal.ok) return err(fromKernelError(legal));
    const valid = validateSubmittedAction(action, legal.value);
    if (!valid.ok) {
      return err({ status: 422, code: "illegal_action", message: valid.message });
    }

    // Reduce under the real VM with random injected (counting cursor).
    const rng = createCountingRandom(seedToNumeric(ctx.data.seed), ctx.data.cursor);
    const reduceCaps = this.buildCaps(grants, participants, rng.random);
    const reduced = runReduce(rules.code, rules.scriptName, ctx.data.state, action, reduceCaps);
    if (!reduced.ok) return err(fromKernelError(reduced));
    const transition = reduced.value;
    const newCursor = rng.totalDraws();

    const applied = await this.stores.experiences.applyTransition({
      sessionId,
      expectedRevision: action.expectedRevision,
      requestId: action.requestId,
      kind: "action",
      actorSnapshotJson: safeStringify(viewer),
      inputJson: safeStringify(action),
      emittedEventsJson: safeStringify(transition.events),
      emittedEffectsJson: safeStringify(transition.effects ?? []),
      stateHash: null,
      message: transition.message ?? null,
      newCurrentStateJson: safeStringify(transition.state),
      newStatus: transition.status,
      newRandomCursor: newCursor,
    });
    if (!applied.ok) {
      return err({
        status: 409,
        code: "stale_revision",
        message: `Session revision changed before apply`,
        currentRevision: ctx.data.revision,
      });
    }

    const session = this.toSessionView(applied.session);
    const projection = await this.projectForResponse(session, rules, transition.state, viewer);
    return ok({
      session,
      projection,
      events: transition.events,
      replayed: applied.replayed,
      await: transition.status === "completed" ? "completed" : "human",
    });
  }

  /**
   * Advance script-controlled participants whose turn it is, applying each as
   * its own atomic transition, until the turn reaches a human seat, a model
   * seat (Wave 4), or nobody can act. The script picks its move explicitly via
   * the optional `choose` method (ephemeral `chance`, no deterministic-cursor
   * draw); a script seat with legal actions but no `choose` is a typed
   * `no_choose_method` error. Bounded to defend against a misbehaving script.
   */
  async advanceScriptTurns(sessionId: string): Promise<ExperienceResult<AppliedAction>> {
    let ctx = await this.loadSessionForVm(sessionId);
    if (!ctx.ok) return ctx;
    if (ctx.data.status !== "active") {
      return err({ status: 422, code: "session_not_active", message: `Session is ${ctx.data.status}`, currentStatus: ctx.data.status });
    }

    for (let bound = 0; bound < MAX_SCRIPT_TURNS; bound += 1) {
      const actor = this.findActor(ctx.data);
      if (actor === null) {
        // Nobody can act — idle (awaiting completion or external input).
        const projection = await this.projectForResponseById(sessionId, ctx.data.rules, ctx.data.state, ctx.data.participants);
        return ok({ session: await this.viewById(sessionId), projection, events: [], replayed: false, await: "idle" });
      }
      if (actor.participant.controller === EXPERIENCE_CONTROLLER.human) {
        const projection = await this.projectForResponseById(sessionId, ctx.data.rules, ctx.data.state, ctx.data.participants);
        return ok({ session: await this.viewById(sessionId), projection, events: [], replayed: false, await: "human" });
      }
      if (actor.participant.controller === EXPERIENCE_CONTROLLER.model) {
        const projection = await this.projectForResponseById(sessionId, ctx.data.rules, ctx.data.state, ctx.data.participants);
        return ok({ session: await this.viewById(sessionId), projection, events: [], replayed: false, await: "model" });
      }
      // script: ask the script's `choose` for its move (ephemeral chance; no cursor draw).
      const scriptViewer: ExperienceViewer = { kind: EXPERIENCE_VIEWER_KIND.script, participantId: actor.participant.id };
      const chooseCaps = this.buildCaps(ctx.data.grants, ctx.data.participants, undefined, createEphemeralRandom());
      const chosenResult = runChoose(ctx.data.rules.code, ctx.data.rules.scriptName, ctx.data.state, scriptViewer, actor.legal, chooseCaps);
      if (!chosenResult.ok) {
        if (chosenResult.kind === "missing_method") {
          return err({ status: 422, code: "no_choose_method", message: `Script participant "${actor.participant.id}" has legal actions but the rules define no \`choose\` method`, participantId: actor.participant.id });
        }
        return err(fromKernelError(chosenResult));
      }
      const intent = chosenResult.value;
      const chosen: ExperienceAction = {
        type: intent.type,
        requestId: `auto:${sessionId}:${ctx.data.revision + 1}`,
        expectedRevision: ctx.data.revision,
        participantId: intent.participantId ?? actor.participant.id,
        ...(intent.payload !== undefined ? { payload: intent.payload } : {}),
      };
      const rng = createCountingRandom(seedToNumeric(ctx.data.seed), ctx.data.cursor);
      const reduceCaps = this.buildCaps(ctx.data.grants, ctx.data.participants, rng.random);
      const reduced = runReduce(ctx.data.rules.code, ctx.data.rules.scriptName, ctx.data.state, chosen, reduceCaps);
      if (!reduced.ok) return err(fromKernelError(reduced));
      const transition = reduced.value;
      const nextCursor = rng.totalDraws();
      const applied = await this.stores.experiences.applyTransition({
        sessionId,
        expectedRevision: ctx.data.revision,
        requestId: chosen.requestId,
        kind: "action",
        actorSnapshotJson: safeStringify({ kind: "script", participantId: actor.participant.id }),
        inputJson: safeStringify(chosen),
        emittedEventsJson: safeStringify(transition.events),
        emittedEffectsJson: safeStringify(transition.effects ?? []),
        stateHash: null,
        message: transition.message ?? null,
        newCurrentStateJson: safeStringify(transition.state),
        newStatus: transition.status,
        newRandomCursor: nextCursor,
      });
      if (!applied.ok) {
        return err({ status: 409, code: "stale_revision", message: `Script turn raced`, currentRevision: ctx.data.revision });
      }
      if (transition.status === "completed") {
        const projection = await this.projectForResponseById(sessionId, ctx.data.rules, transition.state, ctx.data.participants);
        return ok({ session: this.toSessionView(applied.session), projection, events: transition.events, replayed: applied.replayed, await: "completed" });
      }
      // Reload for the next iteration.
      ctx = await this.loadSessionForVm(sessionId);
      if (!ctx.ok) return ctx;
    }
    // Safety bound hit — a script never relinquished the turn.
    const projection = await this.projectForResponseById(sessionId, ctx.ok ? ctx.data.rules : ({} as ResolvedRulesSource), ctx.ok ? ctx.data.state : null, ctx.ok ? ctx.data.participants : []);
    return ok({ session: await this.viewById(sessionId), projection, events: [], replayed: false, await: "idle" });
  }

  // ─── Effect introspection (Wave 4 runs them) ──────────────────────────────

  async getPendingEffects(sessionId: string): Promise<ExperienceResult<ExperienceEffectRow[]>> {
    const session = await this.stores.experiences.getSessionById(sessionId);
    if (session === null) {
      return err({ status: 404, code: "session_not_found", message: `Session '${sessionId}' not found` });
    }
    const all = await this.stores.experiences.getEffectsForSession(sessionId);
    return ok(all.filter((e) => e.status === "pending"));
  }

  /** Fetch one effect row by id (the adapter shapes the run-effect response). */
  async getEffect(effectId: string): Promise<ExperienceResult<ExperienceEffectRow>> {
    const effect = await this.stores.experiences.getEffectById(effectId);
    if (effect === null) {
      return err({ status: 404, code: "effect_not_found", message: `Effect '${effectId}' not found` });
    }
    return ok(effect);
  }

  // ─── Queued-attachment read (IR-70A) ───────────────────────────────────────

  /**
   * Read the session's current queued (unbound) attachment through the
   * privacy-safe {@link ExperienceQueuedAttachmentView} DTO. Verifies the
   * session exists first (typed 404), then reads the queued row. Returns `null`
   * when no unbound attachment exists. The returned view NEVER includes
   * `hiddenStateCheckpointJson` — hidden authoritative state is read only on
   * branch-fork restore (IR-53), never on a client read.
   */
  async getQueuedAttachment(
    sessionId: string,
  ): Promise<ExperienceResult<ExperienceQueuedAttachmentView | null>> {
    const session = await this.stores.experiences.getSessionById(sessionId);
    if (session === null) {
      return err({ status: 404, code: "session_not_found", message: `Session '${sessionId}' not found` });
    }
    const attachment = await this.stores.experiences.getQueuedAttachmentForSession(sessionId);
    if (attachment === null) {
      return ok(null);
    }
    return ok(toQueuedAttachmentView(attachment));
  }

  /** Explicitly freeze the public journal frontier the user selected. */
  queueReport(sessionId: string, expectedRevision: number) {
    return this.reports.queue(sessionId, expectedRevision);
  }

  /** Server-authoritative queue/frontier status; counts validated public events. */
  getReportStatus(sessionId: string): Promise<ExperienceResult<ExperienceReportStatus>> {
    return this.reports.getStatus(sessionId);
  }

  /** Explicit user finish: durable public system event + terminal frozen report. */
  finishWithReport(sessionId: string, expectedRevision: number) {
    return this.reports.finish(sessionId, expectedRevision);
  }

  // ─── Model-effect VM ops (Wave 4 / IR-43) ─────────────────────────────────

  /**
   * Resolve the VM + projection context for a pending model effect: the model
   * seat's participant, its projected private view, and (for action mode) the
   * legal actions the model may choose among. Pure VM reads — no network, no
   * state mutation. The model-effect service (IR-43) builds the prompt from
   * this context + the frozen RP bundle + prompt overrides, then runs the
   * provider, then calls {@link applyEffectResult} to re-enter the reducer.
   */
  async resolveModelEffectContext(effectId: string): Promise<ExperienceResult<ModelEffectVmContext>> {
    const effect = await this.stores.experiences.getEffectById(effectId);
    if (effect === null) {
      return err({ status: 404, code: "effect_not_found", message: `Effect '${effectId}' not found` });
    }
    const request = parseModelEffectRequest(effect.requestJson);
    if (request === null) {
      return err({ status: 422, code: "validation_error", message: `Effect '${effectId}' has a malformed model-effect request payload` });
    }
    const ctx = await this.loadSessionForVm(effect.sessionId);
    if (!ctx.ok) return ctx;
    const participant = ctx.data.participants.find((p) => p.id === request.viewer) ?? null;
    if (participant === null) {
      return err({ status: 422, code: "validation_error", message: `Model-effect viewer '${request.viewer}' is not a session participant` });
    }
    const viewer: ExperienceViewer = { kind: viewerKindForController(participant.controller), participantId: participant.id };
    const viewCaps = this.buildCaps(ctx.data.grants, ctx.data.participants, undefined, createEphemeralRandom());
    const projected = runProject(ctx.data.rules.code, ctx.data.rules.scriptName, ctx.data.state, viewer, viewCaps);
    if (!projected.ok) return err(fromKernelError(projected));
    let legalActions: ExperienceActionDescriptor[] = [];
    if (request.mode === "action") {
      const legal = runActions(ctx.data.rules.code, ctx.data.rules.scriptName, ctx.data.state, viewer, viewCaps);
      if (!legal.ok) return err(fromKernelError(legal));
      legalActions = legal.value;
    }
    const chat = await this.stores.chats.getById(ctx.data.session.chatId);
    return ok({
      effect,
      request,
      viewer,
      participant,
      projectedView: projected.value,
      legalActions,
      rules: ctx.data.rules,
      state: ctx.data.state,
      participants: ctx.data.participants,
      grants: ctx.data.grants,
      chatId: ctx.data.session.chatId,
      characterId: chat?.characterId ?? null,
    });
  }

  /**
   * Resolve the VM + legal-set context for a pending timer effect: the tick
   * viewer's participant and the legal actions for that viewer at claim time.
   * Pure VM reads — no network, no state mutation. The timer-effect service
   * (fix step 2b) sleeps the declared delay, then calls {@link applyEffectResult}
   * to fire the tick back through the reducer.
   */
  async resolveTimerEffectContext(effectId: string): Promise<ExperienceResult<TimerEffectVmContext>> {
    const effect = await this.stores.experiences.getEffectById(effectId);
    if (effect === null) {
      return err({ status: 404, code: "effect_not_found", message: `Effect '${effectId}' not found` });
    }
    const request = parseTimerEffectRequest(effect.requestJson);
    if (request === null) {
      return err({ status: 422, code: "validation_error", message: `Effect '${effectId}' has a malformed timer-effect request payload` });
    }
    const ctx = await this.loadSessionForVm(effect.sessionId);
    if (!ctx.ok) return ctx;
    const participant = ctx.data.participants.find((p) => p.id === request.viewer) ?? null;
    if (participant === null) {
      return err({ status: 422, code: "validation_error", message: `Timer-effect viewer '${request.viewer}' is not a session participant` });
    }
    const viewer: ExperienceViewer = { kind: viewerKindForController(participant.controller), participantId: participant.id };
    const viewCaps = this.buildCaps(ctx.data.grants, ctx.data.participants, undefined, createEphemeralRandom());
    const legal = runActions(ctx.data.rules.code, ctx.data.rules.scriptName, ctx.data.state, viewer, viewCaps);
    if (!legal.ok) return err(fromKernelError(legal));
    return ok({
      effect,
      request,
      viewer,
      participant,
      legalActions: legal.value,
    });
  }

  /**
   * Feed a completed effect's mapped action back into the reducer as an
   * `effect_result` transition, with bounded re-origination (fix item 11).
   *
   * The FIRST attempt keeps the IR-22 optimistic CAS (`expectedRevision` =
   * `effect.originatingRevision`): a completion racing a genuinely newer
   * transition is rejected with `stale_revision`. But one transition may emit
   * SEVERAL effects (a group chat's per-character replies) and only the first
   * lands on the originating revision — without re-origination the rest would
   * stay terminal `succeeded` yet undelivered forever. So on `stale_revision`
   * the delivery RE-ORIGINATES against the current frontier: reload the
   * session, re-run the reducer against the CURRENT state (the author's rules
   * stay the sole legality authority — a reply the rules no longer accept is
   * rejected by `reduce`, not by the CAS), and retry at the observed revision,
   * up to {@link EFFECT_DELIVERY_MAX_ATTEMPTS} attempts. IR-22 holds in
   * substance: a completion never OVERWRITES newer state, it appends on top of
   * it at the frontier with the reducer's consent. Timer effects keep the
   * intentional stale-drop semantics (fix step 2c): a late tick does NOT
   * re-originate.
   */
  async applyEffectResult(effectId: string, action: ExperienceAction, opts?: { actorKind?: "model" | "timer" }): Promise<ExperienceResult<EffectDelivery>> {
    const effect = await this.stores.experiences.getEffectById(effectId);
    if (effect === null) {
      return err({ status: 404, code: "effect_not_found", message: `Effect '${effectId}' not found` });
    }
    if (effect.status !== "succeeded") {
      return err({ status: 409, code: "effect_not_retryable", message: `Effect '${effectId}' is ${effect.status}, not succeeded`, currentStatus: effect.status });
    }
    const maxAttempts = opts?.actorKind === "timer" ? 1 : EFFECT_DELIVERY_MAX_ATTEMPTS;
    for (let attempt = 1; ; attempt += 1) {
      const ctx = await this.loadSessionForVm(effect.sessionId);
      if (!ctx.ok) return ctx;
      const rng = createCountingRandom(seedToNumeric(ctx.data.seed), ctx.data.cursor);
      const reduceCaps = this.buildCaps(ctx.data.grants, ctx.data.participants, rng.random);
      const reduced = runReduce(ctx.data.rules.code, ctx.data.rules.scriptName, ctx.data.state, action, reduceCaps);
      if (!reduced.ok) return err(fromKernelError(reduced));
      const transition = reduced.value;
      const nextCursor = rng.totalDraws();
      const applied = await this.stores.experiences.applyTransition({
        sessionId: effect.sessionId,
        // Attempt 1 is the IR-22 optimistic CAS at the originating revision;
        // re-origination retries land at the frontier revision observed by the
        // reload above (the reduce already ran against that same reload's state).
        expectedRevision: attempt === 1 ? effect.originatingRevision : ctx.data.revision,
        requestId: action.requestId,
        kind: "effect_result",
        actorSnapshotJson: safeStringify({ kind: opts?.actorKind ?? "model", effectId, participantId: action.participantId ?? null }),
        inputJson: safeStringify(action),
        emittedEventsJson: safeStringify(transition.events),
        emittedEffectsJson: safeStringify(transition.effects ?? []),
        stateHash: null,
        message: transition.message ?? null,
        newCurrentStateJson: safeStringify(transition.state),
        newStatus: transition.status,
        newRandomCursor: nextCursor,
      });
      if (!applied.ok && applied.conflict === "stale_revision" && attempt < maxAttempts) {
        continue; // re-originate against the moved frontier
      }
      const session = applied.ok ? this.toSessionView(applied.session) : await this.viewById(effect.sessionId);
      const projection = await this.projectForResponseById(
        effect.sessionId,
        ctx.data.rules,
        applied.ok ? transition.state : ctx.data.state,
        ctx.data.participants,
      );
      return ok({
        delivered: applied.ok,
        ...(applied.ok ? {} : { reason: "stale" as const }),
        session,
        projection,
      });
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private buildCaps(
    grants: ExperienceCapability[],
    participants: ExperienceParticipant[],
    random?: DeterministicRandom,
    chance?: EphemeralRandom,
  ): ExperienceCapabilityContext {
    return buildCapabilityContext(grants, participants, random, chance);
  }

  /** Find the one participant who can act right now (turn detection via actions()). */
  private findActor(loaded: LoadedSessionVmCtx): { participant: ExperienceParticipant; legal: ExperienceActionDescriptor[] } | null {
    for (const p of loaded.participants) {
      const viewer: ExperienceViewer = { kind: viewerKindForController(p.controller), participantId: p.id };
      const legal = runActions(loaded.rules.code, loaded.rules.scriptName, loaded.state, viewer, this.buildCaps(loaded.grants, loaded.participants));
      if (legal.ok && legal.value.length > 0) {
        return { participant: p, legal: legal.value };
      }
    }
    return null;
  }

  private async loadSessionForVm(sessionId: string): Promise<ExperienceResult<LoadedSessionVmCtx>> {
    const session = await this.stores.experiences.getSessionById(sessionId);
    if (session === null) {
      return err({ status: 404, code: "session_not_found", message: `Session '${sessionId}' not found` });
    }
    const participants = parseJson<ExperienceParticipant[]>(session.participantsJson, []);
    const grants = parseJson<ExperienceCapability[]>(session.capabilityGrantsJson, []);
    const state = parseJson<unknown>(session.currentStateJson, null);
    const rules: ResolvedRulesSource = {
      scriptId: session.rulesId,
      scriptName: session.rulesLabel,
      code: session.rulesSource,
      definition: {
        apiVersion: session.apiVersion,
        manifest: { id: session.manifestId, name: session.manifestName },
        declaredCapabilities: [], // not needed for runtime; re-discovery is Wave 8 trust
        hasChoose: false, // not stored on the session; lifecycle probes runChoose directly
        hasFlavor: false,
      },
      sourceHash: session.rulesSourceHash,
      revision: session.rulesRevision,
    };
    return ok({
      session,
      rules,
      state,
      participants,
      grants,
      revision: session.revision,
      status: session.status as ExperienceSessionStatus,
      seed: session.randomSeed,
      cursor: session.randomCursor,
    });
  }

  private async projectForResponse(
    session: ExperienceSessionView,
    rules: ResolvedRulesSource,
    state: unknown,
    viewer: ExperienceViewer,
  ): Promise<ExperienceProjection> {
    const caps = this.buildCaps(session.capabilityGrants, session.participants, undefined, createEphemeralRandom());
    const projected = runProject(rules.code, rules.scriptName, state, viewer, caps);
    const legal = runActions(rules.code, rules.scriptName, state, viewer, caps);
    const flavorRes = runFlavor(rules.code, rules.scriptName, state, viewer, caps);
    return {
      state: projected.ok ? projected.value : null,
      actions: legal.ok ? legal.value : [],
      flavor: this.chatter === null
        ? (flavorRes.ok ? flavorRes.value : undefined)
        : this.chatter.resolveChatterFlavor(session.sessionId, viewer, session.revision, flavorRes.ok ? flavorRes.value : undefined, session.participants),
      revision: session.revision,
      status: session.status,
    };
  }

  private async projectForResponseById(
    sessionId: string,
    rules: ResolvedRulesSource,
    state: unknown,
    participants: ExperienceParticipant[],
  ): Promise<ExperienceProjection> {
    const session = await this.stores.experiences.getSessionById(sessionId);
    if (session === null) {
      return { state: null, actions: [], revision: 0, status: "interrupted" as ExperienceSessionStatus };
    }
    const human = participants.find((p) => p.controller === EXPERIENCE_CONTROLLER.human) ?? null;
    const viewer: ExperienceViewer = human
      ? { kind: EXPERIENCE_VIEWER_KIND.human, participantId: human.id }
      : { kind: EXPERIENCE_VIEWER_KIND.observer };
    return this.projectForResponse(this.toSessionView(session), rules, state, viewer);
  }

  private async viewById(sessionId: string): Promise<ExperienceSessionView> {
    const session = await this.stores.experiences.getSessionById(sessionId);
    if (session === null) throw new Error(`Session '${sessionId}' disappeared mid-turn`);
    return this.toSessionView(session);
  }

  private async findBranch(chatId: string, branchId: string): Promise<{ id: string } | null> {
    const branches = await this.stores.chats.getBranches?.(chatId).catch(() => null);
    if (branches && Array.isArray(branches)) {
      return branches.find((b: { id: string }) => b.id === branchId) ?? null;
    }
    // Fallback: the active branch is always valid; otherwise trust the caller
    // (the FK constraint on session insert rejects a non-existent branch).
    const chat = await this.stores.chats.getById(chatId);
    return chat !== null ? { id: branchId } : null;
  }

  private toSessionView(session: {
    id: string; chatId: string; branchId: string; status: string; revision: number;
    manifestId: string; manifestName: string; apiVersion: number;
    participantsJson: string; capabilityGrantsJson: string; contextMode: string;
    rulesRevision: number; rulesSourceHash: string; visualId: string | null;
    visualSource: string | null; visualSourceHash: string | null; reportFrontier: number;
  }): ExperienceSessionView {
    return {
      sessionId: session.id,
      chatId: session.chatId,
      branchId: session.branchId,
      status: session.status as ExperienceSessionStatus,
      revision: session.revision,
      manifest: { id: session.manifestId, name: session.manifestName },
      apiVersion: session.apiVersion,
      participants: parseJson<ExperienceParticipant[]>(session.participantsJson, []),
      capabilityGrants: parseJson<ExperienceCapability[]>(session.capabilityGrantsJson, []),
      contextMode: session.contextMode as ExperienceContextMode,
      rulesRevision: session.rulesRevision,
      rulesSourceHash: session.rulesSourceHash,
      visualId: session.visualId,
      visualSource: session.visualSource,
      visualSourceHash: session.visualSourceHash,
      reportFrontier: session.reportFrontier,
    };
  }

}

// ─── Small helpers ───────────────────────────────────────────────────────────

interface LoadedSessionVmCtx {
  session: ExperienceSessionRow;
  rules: ResolvedRulesSource;
  state: unknown;
  participants: ExperienceParticipant[];
  grants: ExperienceCapability[];
  revision: number;
  status: ExperienceSessionStatus;
  seed: string;
  cursor: number;
}

export function resolveHumanViewer(
  participants: ExperienceParticipant[],
  participantId?: string,
): ExperienceViewer {
  if (participantId !== undefined) {
    return { kind: EXPERIENCE_VIEWER_KIND.human, participantId };
  }
  const human = participants.find((p) => p.controller === EXPERIENCE_CONTROLLER.human);
  if (human !== undefined) {
    return { kind: EXPERIENCE_VIEWER_KIND.human, participantId: human.id };
  }
  // No seat roster (e.g. a solitaire game): the single player is the observer.
  return { kind: EXPERIENCE_VIEWER_KIND.observer };
}

export function viewerKindForController(controller: string): ExperienceViewer["kind"] {
  if (controller === EXPERIENCE_CONTROLLER.human) return EXPERIENCE_VIEWER_KIND.human;
  if (controller === EXPERIENCE_CONTROLLER.script) return EXPERIENCE_VIEWER_KIND.script;
  if (controller === EXPERIENCE_CONTROLLER.model) return EXPERIENCE_VIEWER_KIND.model;
  return EXPERIENCE_VIEWER_KIND.observer;
}

/**
 * Validate a NEW session's participant roster at the service boundary (IR-70E).
 * Mirrors the HTTP schema's conditional rules so a direct service caller
 * cannot bypass them: a model-controlled seat must pin BOTH a nonblank
 * providerProfileId and modelId (and requires the `model` capability grant);
 * a human/script seat must carry NEITHER. Returns the first violation as a
 * typed 422 error, or `null` when the roster is valid. Legacy persisted
 * participants (neither field) are never accepted as a NEW start — they are a
 * load-time fallback concern handled by the model-effect service.
 */
function validateParticipantsForStart(
  participants: ExperienceParticipant[],
  grants: ExperienceCapability[],
): ExperienceApiError | null {
  const hasModelGrant = grants.includes(EXPERIENCE_CAPABILITY.model);
  for (const p of participants) {
    const isModel = p.controller === EXPERIENCE_CONTROLLER.model;
    const hasProviderField = p.providerProfileId !== undefined;
    const hasModelField = p.modelId !== undefined;
    const providerId = p.providerProfileId?.trim();
    const modelId = p.modelId?.trim();
    if (isModel) {
      if (!hasProviderField || !hasModelField || !providerId || !modelId) {
        return {
          status: 422,
          code: "validation_error",
          message:
            "A model-controlled participant must pin both a providerProfileId and a modelId",
        };
      }
      if (!hasModelGrant) {
        return {
          status: 422,
          code: "validation_error",
          message: "A model-controlled participant requires the 'model' capability grant",
        };
      }
    } else if (hasProviderField || hasModelField) {
      return {
        status: 422,
        code: "validation_error",
        message: `A ${p.controller}-controlled participant must not carry a providerProfileId or modelId`,
      };
    } else if (p.characterId !== undefined) {
      // Mirror of the start schema: a character card is a model-seat identity
      // layer only (report item 6b).
      return {
        status: 422,
        code: "validation_error",
        message: `A ${p.controller}-controlled participant must not carry a characterId`,
      };
    }
  }
  return null;
}

function safeStringify(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function defaultGenerateSeed(): string {
  // 32-bit random, base36 — compact, deterministic to re-hash via seedToNumeric.
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]!.toString(36);
}

// Re-export the view + error vocabulary for routes/adapter.
export type { ExperienceApiError, ExperienceResult } from "./experience-shared.js";
export type { ResolvedRulesSource, ResolvedVisualSource } from "./experience-resource-service.js";
