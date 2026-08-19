/**
 * Experience replay service (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 3 / IR-31).
 *
 * Owns history-driven reconstruction: deterministic replay of the saved initial
 * settings + recorded action journal under the preserved random stream (from
 * seed+0), append-only undo (a rewind is a NEW authoritative revision, never a
 * history rewrite), and rules-recalculation preview (replay the same setup +
 * chosen actions under NEW rules, safe-stopping at the first now-illegal or
 * incompatible historical action). The replay engine is shared by all three.
 *
 * Determinism invariant: live transitions and replay use the SAME capability-
 * gating policy ({@link buildCapabilityContext}), the SAME cursor-counting RNG,
 * and the SAME per-action viewer resolution — so a replay reproduces the exact
 * authoritative state the live session reached.
 */

import type { StoreContainer } from "@vibe-tavern/db";
import type {
  ExperienceAction,
  ExperienceCapability,
  ExperienceEvent,
  ExperienceParticipant,
  ExperienceSessionStatus,
} from "@vibe-tavern/domain";

import {
  runActions,
  runCreate,
  runReduce,
  validateSubmittedAction,
} from "./experience-kernel.js";
import {
  type ExperienceApiError,
  type ExperienceResult,
  buildCapabilityContext,
  err,
  fromKernelError,
  ok,
} from "./experience-shared.js";
import {
  type AppliedAction,
  type ExperienceSessionView,
  createCountingRandom,
  resolveHumanViewer,
  seedToNumeric,
} from "./experience-service.js";
import { ExperienceResourceService, type ResolvedRulesSource } from "./experience-resource-service.js";

// ─── Replay outcome ──────────────────────────────────────────────────────────

export interface ReplayCheckpoint {
  revision: number;
  state: unknown;
  cursor: number;
}

export type ReplayOutcome =
  | { ok: true; finalState: unknown; cursor: number; checkpoints: ReplayCheckpoint[] }
  | {
      ok: false;
      /** The revision at which replay stopped (the action that failed). */
      failedAtRevision: number;
      reason: "create_failed" | "illegal_action" | "vm_error";
      message: string;
      /** The last state successfully reached before the failure. */
      partialState: unknown;
    };

export interface RecalculationPreview {
  /** The rules the session currently pins (the baseline). */
  originalRulesHash: string;
  originalState: unknown;
  originalRevision: number;
  /** The new rules' discovered manifest + hash. */
  newManifestId: string;
  newRulesHash: string;
  outcome: ReplayOutcome;
}

// ─── Loaded session (for replay) ─────────────────────────────────────────────

interface ReplaySession {
  sessionId: string;
  rules: ResolvedRulesSource;
  initialSettings: unknown;
  participants: ExperienceParticipant[];
  grants: ExperienceCapability[];
  seed: string;
  currentRevision: number;
  currentState: unknown;
  status: ExperienceSessionStatus;
  /** Recorded action inputs in journal order (kind === "action"). */
  history: ExperienceAction[];
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class ExperienceReplayService {
  private readonly stores: StoreContainer;
  private readonly resources: ExperienceResourceService;

  constructor(stores: StoreContainer, resources: ExperienceResourceService) {
    this.stores = stores;
    this.resources = resources;
  }

  // ─── Replay ───────────────────────────────────────────────────────────────

  /**
   * Reconstruct the session by replaying its saved initial settings + recorded
   * action journal under the preserved random stream (seed + cursor 0), using
   * the CURRENTLY pinned rules. Verifies the live authoritative state is
   * reproducible; also the engine for undo + recalculation.
   */
  async replaySession(sessionId: string): Promise<ExperienceResult<ReplayOutcome>> {
    const loaded = await this.loadForReplay(sessionId);
    if (!loaded.ok) return loaded;
    return ok(this.replayHistory(loaded.data, loaded.data.rules));
  }

  // ─── Undo (append-only) ───────────────────────────────────────────────────

  /**
   * Undo to a target revision by APPENDING a new system revision whose state is
   * the reconstructed state at the target revision (replayed from seed). History
   * is never deleted — the journal records the rewind as a system step, and the
   * random cursor rewinds to the target's reconstructed cursor. The target must
   * be an earlier revision than the current one.
   */
  async undoToRevision(
    sessionId: string,
    targetRevision: number,
  ): Promise<ExperienceResult<AppliedAction>> {
    const loaded = await this.loadForReplay(sessionId);
    if (!loaded.ok) return loaded;
    if (targetRevision < 0 || targetRevision >= loaded.data.currentRevision) {
      return err({
        status: 422,
        code: "validation_error",
        message: `Undo target revision ${targetRevision} is out of range (current: ${loaded.data.currentRevision})`,
      });
    }

    const outcome = this.replayHistory(loaded.data, loaded.data.rules);
    if (!outcome.ok) {
      // Current journal does not replay cleanly under its own rules — refuse to
      // undo rather than commit a partially-reconstructed checkpoint.
      return err({
        status: 422,
        code: "replay_failed",
        message: `Cannot undo: current journal did not replay cleanly (${outcome.reason} at revision ${outcome.failedAtRevision})`,
        failedActionIndex: outcome.failedAtRevision,
      });
    }
    const checkpoint = outcome.checkpoints[targetRevision];
    if (checkpoint === undefined) {
      return err({ status: 500, code: "internal", message: `Replay produced no checkpoint for revision ${targetRevision}` });
    }

    const applied = await this.stores.experiences.applyTransition({
      sessionId,
      expectedRevision: loaded.data.currentRevision,
      requestId: null,
      kind: "system",
      actorSnapshotJson: null,
      inputJson: JSON.stringify({ undoToRevision: targetRevision }),
      emittedEventsJson: JSON.stringify([
        { visibility: "public", type: "undo", detail: { toRevision: targetRevision } },
      ] satisfies ExperienceEvent[]),
      emittedEffectsJson: "[]",
      stateHash: null,
      message: null,
      newCurrentStateJson: JSON.stringify(checkpoint.state),
      newStatus: "active",
      newRandomCursor: checkpoint.cursor,
    });
    if (!applied.ok) {
      return err({
        status: 409,
        code: "stale_revision",
        message: `Session revision changed before undo`,
        currentRevision: loaded.data.currentRevision,
      });
    }

    // Undo cancels pending timer effects whose spawn steps (revisions above
    // the target) no longer exist in the rewound timeline — otherwise the host
    // scheduler would still fire them into a CAS that must reject (undo
    // appended a revision, so `originatingRevision` can never match again) and
    // they would read as a fake `succeeded`-but-undelivered. Model effects are
    // left to their existing stale-completion semantics (their run is
    // user-awaited; the feed-back CAS already guards correctness).
    await this.stores.experiences.cancelPendingEffectsAboveRevision(sessionId, targetRevision, "timer");

    const session = this.toView(applied.session);
    return ok({
      session,
      projection: {
        state: checkpoint.state,
        actions: [],
        revision: session.revision,
        status: session.status,
      },
      events: [{ visibility: "public", type: "undo", detail: { toRevision: targetRevision } }],
      replayed: applied.replayed,
      await: "human",
    });
  }

  // ─── Rules recalculation preview ──────────────────────────────────────────

  /**
   * Preview a recalculation: replay the saved initial settings + committed
   * action history under NEW rules source, preserving the same random/setup
   * inputs and chosen actions. Never commits. If an old action is now illegal
   * or the state contract is incompatible, replay safe-stops at that action and
   * the outcome reports the failing revision + reason (the caller offers only
   * continue-with-old-rules or restart-under-new-rules).
   */
  async previewRecalculation(
    sessionId: string,
    newRulesCode: string,
  ): Promise<ExperienceResult<RecalculationPreview>> {
    const loaded = await this.loadForReplay(sessionId);
    if (!loaded.ok) return loaded;

    const validation = this.resources.validateRulesSource(newRulesCode, loaded.data.rules.scriptName);
    if (!validation.ok) {
      return err({
        status: 422,
        code: "vm_error",
        message: validation.error.message,
        kind: validation.error.kind,
      });
    }

    const newRules: ResolvedRulesSource = {
      scriptId: loaded.data.rules.scriptId,
      scriptName: loaded.data.rules.scriptName,
      code: newRulesCode,
      definition: validation.definition,
      sourceHash: validation.sourceHash,
      revision: loaded.data.rules.revision,
    };

    const outcome = this.replayHistory(loaded.data, newRules);
    return ok({
      originalRulesHash: loaded.data.rules.sourceHash,
      originalState: loaded.data.currentState,
      originalRevision: loaded.data.currentRevision,
      newManifestId: validation.definition.manifest.id,
      newRulesHash: validation.sourceHash,
      outcome,
    });
  }

  // ─── Replay engine (the shared core) ──────────────────────────────────────

  /**
   * Replay create + the recorded actions in order under the given rules, with
   * the preserved seed advanced from cursor 0. Returns a checkpoint per
   * revision (0 = after create) or a safe-stop at the first failing action.
   * Uses the SAME capability-gating + viewer resolution as live transitions.
   */
  private replayHistory(session: ReplaySession, rules: ResolvedRulesSource): ReplayOutcome {
    const rng = createCountingRandom(seedToNumeric(session.seed), 0);
    const created = runCreate(
      rules.code,
      rules.scriptName,
      session.initialSettings,
      buildCapabilityContext(session.grants, session.participants, rng.random),
    );
    if (!created.ok) {
      return {
        ok: false,
        failedAtRevision: 0,
        reason: "create_failed",
        message: created.message,
        partialState: null,
      };
    }
    let state: unknown = created.value;
    const checkpoints: ReplayCheckpoint[] = [
      { revision: 0, state, cursor: rng.totalDraws() },
    ];

    for (let i = 0; i < session.history.length; i += 1) {
      const action = session.history[i]!;
      const viewer = resolveHumanViewer(session.participants, action.participantId);
      // Projections never consume random — pass no random to actions().
      const legal = runActions(
        rules.code,
        rules.scriptName,
        state,
        viewer,
        buildCapabilityContext(session.grants, session.participants),
      );
      if (!legal.ok) {
        return { ok: false, failedAtRevision: i + 1, reason: "vm_error", message: legal.message, partialState: state };
      }
      const valid = validateSubmittedAction(action, legal.value);
      if (!valid.ok) {
        return { ok: false, failedAtRevision: i + 1, reason: "illegal_action", message: valid.message, partialState: state };
      }
      const reduced = runReduce(
        rules.code,
        rules.scriptName,
        state,
        action,
        buildCapabilityContext(session.grants, session.participants, rng.random),
      );
      if (!reduced.ok) {
        return { ok: false, failedAtRevision: i + 1, reason: "vm_error", message: reduced.message, partialState: state };
      }
      state = reduced.value.state;
      checkpoints.push({ revision: i + 1, cursor: rng.totalDraws(), state });
    }

    return { ok: true, finalState: state, cursor: rng.totalDraws(), checkpoints };
  }

  // ─── Loading ──────────────────────────────────────────────────────────────

  private async loadForReplay(sessionId: string): Promise<ExperienceResult<ReplaySession>> {
    const session = await this.stores.experiences.getSessionById(sessionId);
    if (session === null) {
      return err({ status: 404, code: "session_not_found", message: `Session '${sessionId}' not found` });
    }
    const steps = await this.stores.experiences.getSteps(sessionId);
    // Replay recorded action inputs in journal order. (Effect-result replays are
    // Wave 4; V1 Wave-3 sessions produce action steps only.)
    const history: ExperienceAction[] = steps
      .filter((s) => s.kind === "action")
      .sort((a, b) => a.sequence - b.sequence)
      .map((s) => parseJson<ExperienceAction>(s.inputJson ?? "null", null as never))
      .filter((a): a is ExperienceAction => a !== null);

    const rules: ResolvedRulesSource = {
      scriptId: session.rulesId,
      scriptName: session.rulesLabel,
      code: session.rulesSource,
      definition: {
        apiVersion: session.apiVersion,
        manifest: { id: session.manifestId, name: session.manifestName },
        declaredCapabilities: [],
        hasChoose: false, // not stored; replay re-runs create+reduce only (choose is ephemeral)
        hasFlavor: false,
      },
      sourceHash: session.rulesSourceHash,
      revision: session.rulesRevision,
    };
    return {
      ok: true,
      data: {
        sessionId,
        rules,
        initialSettings: parseJson(session.initialSettingsJson, {}),
        participants: parseJson<ExperienceParticipant[]>(session.participantsJson, []),
        grants: parseJson<ExperienceCapability[]>(session.capabilityGrantsJson, []),
        seed: session.randomSeed,
        currentRevision: session.revision,
        currentState: parseJson(session.currentStateJson, null),
        status: session.status as ExperienceSessionStatus,
        history,
      },
    };
  }

  private toView(session: {
    id: string; chatId: string; branchId: string; status: string; revision: number;
    manifestId: string; manifestName: string; apiVersion: number;
    participantsJson: string; initialSettingsJson: string; capabilityGrantsJson: string; contextMode: string;
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
      initialSettings: parseJson<unknown>(session.initialSettingsJson, {}),
      capabilityGrants: parseJson<ExperienceCapability[]>(session.capabilityGrantsJson, []),
      contextMode: session.contextMode as never,
      rulesRevision: session.rulesRevision,
      rulesSourceHash: session.rulesSourceHash,
      visualId: session.visualId,
      visualSource: session.visualSource,
      visualSourceHash: session.visualSourceHash,
      reportFrontier: session.reportFrontier,
    };
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export type { ExperienceApiError, ExperienceResult } from "./experience-shared.js";
