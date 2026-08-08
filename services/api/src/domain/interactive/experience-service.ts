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

import type { StoreContainer } from "@vibe-tavern/db";
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
import type { ExperienceEffectRow, ExperienceSessionRow } from "@vibe-tavern/db";

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

// ─── Service ─────────────────────────────────────────────────────────────────

const MAX_SCRIPT_TURNS = 200;

export class ExperienceService {
  private readonly stores: StoreContainer;
  private readonly resources: ExperienceResourceService;
  private readonly generateSeed: () => string;

  constructor(
    stores: StoreContainer,
    resources: ExperienceResourceService,
    deps: { generateSeed?: () => string } = {},
  ) {
    this.stores = stores;
    this.resources = resources;
    this.generateSeed = deps.generateSeed ?? defaultGenerateSeed;
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

    // Run create under the real VM, with random injected only if granted.
    const seed = this.generateSeed();
    const numericSeed = seedToNumeric(seed);
    const createRng = createCountingRandom(numericSeed, 0);
    const caps = this.buildCaps(grants, input.participants, createRng.random);
    const created = runCreate(rules.code, rules.scriptName, input.settings, caps);
    if (!created.ok) return err(fromKernelError(created));
    const initialState = created.value;
    const cursorAfterCreate = createRng.totalDraws();

    const created_row = await this.stores.experiences.createSession({
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
      participantsJson: safeStringify(input.participants),
      capabilityGrantsJson: safeStringify(grants),
      contextMode: setup.data.contextMode,
      randomSeed: seed,
    });
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

  /** End a session (completed/interrupted), releasing the branch active slot. */
  async endSession(
    sessionId: string,
    status: "completed" | "interrupted",
  ): Promise<ExperienceResult<void>> {
    const session = await this.stores.experiences.getSessionById(sessionId);
    if (session === null) {
      return err({ status: 404, code: "session_not_found", message: `Session '${sessionId}' not found` });
    }
    await this.stores.experiences.finishSession(sessionId, status);
    return ok(undefined);
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
      flavor: flavorRes.ok ? flavorRes.value : undefined,
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
        newRandomCursor: rng.totalDraws(),
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
   * Feed a completed effect's mapped action back into the reducer as an
   * `effect_result` transition. Acceptance is the CAS (`expectedRevision` =
   * `effect.originatingRevision`): if the session advanced past the originating
   * revision (stale completion), `applyTransition` returns `stale_revision` and
   * the feed-back is NOT applied — the effect stays terminal (`succeeded`) but
   * undelivered, and the session keeps its newer state. This is the IR-22
   * "delayed effect completions can never overwrite newer session state" rule.
   */
  async applyEffectResult(effectId: string, action: ExperienceAction): Promise<ExperienceResult<EffectDelivery>> {
    const effect = await this.stores.experiences.getEffectById(effectId);
    if (effect === null) {
      return err({ status: 404, code: "effect_not_found", message: `Effect '${effectId}' not found` });
    }
    if (effect.status !== "succeeded") {
      return err({ status: 409, code: "effect_not_retryable", message: `Effect '${effectId}' is ${effect.status}, not succeeded`, currentStatus: effect.status });
    }
    const ctx = await this.loadSessionForVm(effect.sessionId);
    if (!ctx.ok) return ctx;
    const rng = createCountingRandom(seedToNumeric(ctx.data.seed), ctx.data.cursor);
    const reduceCaps = this.buildCaps(ctx.data.grants, ctx.data.participants, rng.random);
    const reduced = runReduce(ctx.data.rules.code, ctx.data.rules.scriptName, ctx.data.state, action, reduceCaps);
    if (!reduced.ok) return err(fromKernelError(reduced));
    const transition = reduced.value;
    const applied = await this.stores.experiences.applyTransition({
      sessionId: effect.sessionId,
      expectedRevision: effect.originatingRevision,
      requestId: action.requestId,
      kind: "effect_result",
      actorSnapshotJson: safeStringify({ kind: "model", effectId, participantId: action.participantId ?? null }),
      inputJson: safeStringify(action),
      emittedEventsJson: safeStringify(transition.events),
      emittedEffectsJson: safeStringify(transition.effects ?? []),
      stateHash: null,
      message: transition.message ?? null,
      newCurrentStateJson: safeStringify(transition.state),
      newStatus: transition.status,
      newRandomCursor: rng.totalDraws(),
    });
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
      flavor: flavorRes.ok ? flavorRes.value : undefined,
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
    rulesRevision: number; rulesSourceHash: string; visualId: string | null; reportFrontier: number;
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
