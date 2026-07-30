/**
 * Dice service (DICE_SYSTEM_BACKEND_PLAN, Wave B3 / DICE-B8).
 *
 * Wraps the B7 DiceRollStore and the B2 DiceScriptService to provide the
 * authoritative API for dice operations. This service:
 * - Resolves active actors/scripts via the DiceScriptService
 * - Validates notation/faces/totals/eligibility/revision BEFORE persisting
 * - Delegates persistence to the DiceRollStore
 * - Uses cryptographic production randomness (injected, deterministic in tests)
 * - Never submits authoritative dice faces/totals from the client
 *
 * Isolation: this service performs NO prompt assembly, NO provider calls, and
 * NO EventBus publish. It is pure dice compute + DB write.
 */

import type { StoreContainer } from "@vibe-tavern/db";
import { DiceRollStore, DiceBindError, type DiceRoll, type LaneState } from "@vibe-tavern/db";
import type {
  DiceActorType,
  DiceMode,
  DiceAttempt,
  DiceRollSnapshot,
  DiceRollId,
} from "@vibe-tavern/domain";
import { brandId, type RandomSource } from "@vibe-tavern/domain";
import {
  discoverDiceScripts,
  resolveDiceRoll,
  type DiceDefinitionsResponse,
  type DiceResolvedRoll,
  type DiceServiceError,
} from "../scripts-engine/dice-script-service.js";

// ─── Response types ──────────────────────────────────────────────────────────

export interface DicePendingState {
  normal: { revision: number; rolls: DiceRollSnapshot[] };
  immersive: { revision: number; rolls: DiceRollSnapshot[] };
}

export type DiceApiError =
  | { status: 404; code: "roll_not_found"; message: string }
  | { status: 404; code: "chat_not_found"; message: string }
  | { status: 404; code: "actor_not_found"; message: string }
  | { status: 409; code: "stale_revision"; message: string; currentRevision: number }
  | { status: 409; code: "unresolved_choose"; message: string }
  | { status: 409; code: "attempt_conflict"; message: string }
  | { status: 422; code: "validation_error"; message: string }
  | { status: 422; code: "actor_ineligible"; message: string; allowed: DiceActorType[] }
  | { status: 422; code: "check_not_found"; message: string }
  | { status: 422; code: "script_not_found"; message: string }
  | { status: 422; code: "no_grant"; message: string }
  | { status: 500; code: "vm_error"; message: string };

export type DiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: DiceApiError };

// ─── Service ─────────────────────────────────────────────────────────────────

export class DiceService {
  private readonly stores: StoreContainer;
  private readonly diceRolls: DiceRollStore;
  private readonly rng: RandomSource;

  constructor(stores: StoreContainer, rng: RandomSource) {
    this.stores = stores;
    this.diceRolls = stores.diceRolls;
    this.rng = rng;
  }

  // ─── Definitions (discovery) ─────────────────────────────────────────────

  /**
   * List enabled Dice scripts and their check descriptors for a chat.
   * Resolves the active actors from the chat context.
   */
  async listDefinitions(chatId: string): Promise<DiceResult<DiceDefinitionsResponse>> {
    const ctx = await this.resolveChatContext(chatId);
    if (!ctx.ok) return ctx;

    const defs = await discoverDiceScripts(this.stores, {
      characterId: ctx.data.characterId,
      personaId: ctx.data.personaId,
      chatId,
      diceScriptIds: ctx.data.diceScriptIds,
    });

    return { ok: true, data: defs };
  }

  // ─── Pending state ──────────────────────────────────────────────────────

  /**
   * Get the current pending state for both lanes of a chat+branch.
   */
  async getPendingState(chatId: string, branchId: string): Promise<DiceResult<DicePendingState>> {
    const ctx = await this.resolveChatContext(chatId);
    if (!ctx.ok) return ctx;

    const pending = await this.diceRolls.listPending(chatId, branchId);
    return {
      ok: true,
      data: {
        normal: { revision: pending.normal.revision, rolls: pending.normal.rolls.map(storeRollToSnapshot) },
        immersive: { revision: pending.immersive.revision, rolls: pending.immersive.rolls.map(storeRollToSnapshot) },
      },
    };
  }

  // ─── Roll ───────────────────────────────────────────────────────────────

  /**
   * Execute a dice roll for a chat. The client submits only the identifiers
   * (scriptId, checkId, actorType, actorId, mode, requestId); the server
   * rolls and validates everything.
   */
  async roll(chatId: string, input: {
    scriptId: string;
    checkId: string;
    actorType: DiceActorType;
    actorId: string;
    mode: DiceMode;
    requestId: string;
  }): Promise<DiceResult<DiceRollSnapshot>> {
    const ctx = await this.resolveChatContext(chatId);
    if (!ctx.ok) return ctx;

    // Resolve the roll via B2's dice-script-service (validates notation, actor,
    // script eligibility, runs the VM, validates arithmetic).
    const rollResult = await resolveDiceRoll(this.stores, {
      scriptId: input.scriptId,
      checkId: input.checkId,
      actorType: input.actorType,
      actorId: input.actorId,
      characterId: ctx.data.characterId,
      personaId: ctx.data.personaId,
      chatId,
      diceScriptIds: ctx.data.diceScriptIds,
      diceActorBindings: ctx.data.diceActorBindings,
      rng: this.rng,
    });

    if (!rollResult.ok) {
      return { ok: false, error: mapServiceError(rollResult.error) };
    }

    const resolved = rollResult.roll;

    // Persist via the store.
    const attemptJson = JSON.stringify([resolved.attempt]);
    const finalJson = resolved.final ? JSON.stringify(resolved.final) : null;

    if (input.mode === "normal") {
      // Normal mode: replace same actor+check.
      const roll = await this.diceRolls.replaceNormalPending({
        chatId,
        branchId: ctx.data.branchId,
        actorType: resolved.actor.actorType,
        actorId: resolved.actor.actorId,
        actorLabel: resolved.actor.actorLabel,
        scriptId: resolved.scriptId,
        scriptLabel: resolved.scriptLabel,
        scriptRevision: resolved.scriptRevision,
        checkId: resolved.checkId,
        checkLabel: resolved.checkLabel,
        notation: resolved.notation,
        faceShape: resolved.faceShape,
        resolution: resolved.resolution,
        attemptsJson: attemptJson,
        finalJson,
        requestId: input.requestId,
      });
      return { ok: true, data: storeRollToSnapshot(roll) };
    }

    // Immersive mode: compare-and-append.
    // For the initial attempt, we don't have an existing roll yet.
    const result = await this.diceRolls.compareAndAppendAttempt({
      chatId,
      branchId: ctx.data.branchId,
      expectedRevision: (await this.diceRolls.getOrCreateLane(chatId, ctx.data.branchId, "immersive")).revision,
      requestId: input.requestId,
      actorType: resolved.actor.actorType,
      actorId: resolved.actor.actorId,
      actorLabel: resolved.actor.actorLabel,
      scriptId: resolved.scriptId,
      scriptLabel: resolved.scriptLabel,
      scriptRevision: resolved.scriptRevision,
      checkId: resolved.checkId,
      checkLabel: resolved.checkLabel,
      notation: resolved.notation,
      faceShape: resolved.faceShape,
      resolution: resolved.resolution,
      newAttemptJson: JSON.stringify(resolved.attempt),
      finalJson,
      finalAttemptId: resolved.final ? "attempt_1" : null,
      ...(resolved.retryReason ? { retryReason: resolved.retryReason } : {}),
      ...(resolved.policy ? { policy: resolved.policy } : {}),
    });

    if (!result.ok) {
      return {
        ok: false,
        error: {
          status: 409,
          code: "stale_revision",
          message: "Lane revision changed — refresh pending state",
          currentRevision: 0,
        },
      };
    }

    return { ok: true, data: storeRollToSnapshot(result.roll) };
  }

  // ─── Remove / clear ─────────────────────────────────────────────────────

  /**
   * Remove a single pending roll. Verifies the roll exists AND belongs to the
   * chat in the path (via the roll→lane join) before deleting — never creates
   * a lane row (the prior `getOrCreateLane(chatId, "", mode)` path failed the
   * branch_id FK constraint).
   */
  async removeRoll(chatId: string, rollId: string): Promise<DiceResult<void>> {
    const owned = await this.diceRolls.getRollWithChat(rollId);
    if (!owned || owned.chatId !== chatId) {
      return { ok: false, error: { status: 404, code: "roll_not_found", message: `Roll '${rollId}' not found` } };
    }
    await this.diceRolls.removeRoll(rollId);
    return { ok: true, data: undefined };
  }

  /**
   * Clear the Normal pending lane.
   */
  async clearLane(chatId: string, branchId: string): Promise<DiceResult<void>> {
    await this.diceRolls.clearNormalLane(chatId, branchId);
    return { ok: true, data: undefined };
  }

  // ─── Include / choose ───────────────────────────────────────────────────

  /**
   * Set the included state of a roll (Immersive include/exclude from binding).
   */
  async setIncluded(chatId: string, rollId: string, included: boolean): Promise<DiceResult<void>> {
    const roll = await this.diceRolls.getRollById(rollId);
    if (!roll) return { ok: false, error: { status: 404, code: "roll_not_found", message: `Roll '${rollId}' not found` } };

    await this.diceRolls.setIncluded(rollId, included);
    return { ok: true, data: undefined };
  }

  /**
   * Finalize a choose-policy attempt. Send is blocked until one exists.
   */
  async chooseFinal(chatId: string, rollId: string, attemptId: string): Promise<DiceResult<void>> {
    const roll = await this.diceRolls.getRollById(rollId);
    if (!roll) return { ok: false, error: { status: 404, code: "roll_not_found", message: `Roll '${rollId}' not found` } };

    // Verify the attempt exists in the roll.
    const attempts = JSON.parse(roll.attemptsJson) as Array<{ attemptId: string }>;
    if (!attempts.some((a) => a.attemptId === attemptId)) {
      return {
        ok: false,
        error: { status: 422, code: "validation_error", message: `Attempt '${attemptId}' not found in roll '${rollId}'` },
      };
    }

    await this.diceRolls.chooseFinalAttempt(rollId, attemptId);
    return { ok: true, data: undefined };
  }

  // ─── Chat context resolution ────────────────────────────────────────────

  private async resolveChatContext(chatId: string): Promise<
    | { ok: true; data: { characterId: string; personaId: string | null; branchId: string; diceScriptIds: string[] | null; diceActorBindings: Record<string, ("persona" | "character")[]> | null } }
    | { ok: false; error: DiceApiError }
  > {
    const chat = await this.stores.chats.getById(chatId);
    if (!chat) return { ok: false, error: { status: 404, code: "chat_not_found", message: `Chat '${chatId}' not found` } };
    // Normalize the chat-local Dice override from the freeform Insights JSON:
    // an array is the explicit set; anything else (null / absent / legacy) is
    // inherit. The column is raw JSON, so guard the type rather than trusting it.
    const rawIds = chat.insightsConfig?.diceScriptIds;
    const diceScriptIds: string[] | null = Array.isArray(rawIds)
      ? rawIds.filter((id): id is string => typeof id === "string")
      : null;
    // Normalize the chat-local per-script actor distribution (Rework R1). The
    // column is raw JSON, so guard shape + actor values. Empty/invalid entries
    // are dropped (an empty binding ≡ absent ≡ fall back to declared actors).
    const rawBindings = chat.insightsConfig?.diceActorBindings;
    const validActors = new Set<string>(["persona", "character"]);
    let diceActorBindings: Record<string, ("persona" | "character")[]> | null = null;
    if (rawBindings && typeof rawBindings === "object" && !Array.isArray(rawBindings)) {
      const out: Record<string, ("persona" | "character")[]> = {};
      for (const [k, v] of Object.entries(rawBindings as Record<string, unknown>)) {
        if (typeof k !== "string" || k.length === 0 || !Array.isArray(v)) continue;
        const actors = v.filter(
          (a): a is "persona" | "character" => typeof a === "string" && validActors.has(a),
        );
        if (actors.length > 0) out[k] = actors;
      }
      diceActorBindings = out;
    }
    return {
      ok: true,
      data: {
        characterId: chat.characterId,
        personaId: chat.personaId,
        branchId: chat.activeBranchId,
        diceScriptIds,
        diceActorBindings,
      },
    };
  }
}

// ─── Mapping helpers ─────────────────────────────────────────────────────────

/**
 * Convert a store DiceRoll (plain strings) to the domain DiceRollSnapshot
 * (branded types). The store is the DB boundary — brands are applied here.
 * Exported so the prompt-assembly read path (Wave B5 / DICE-B14) can reuse the
 * same mapping without duplicating the JSON-parse + brand logic.
 */
export function storeRollToSnapshot(roll: DiceRoll): DiceRollSnapshot {
  return {
    rollId: brandId<DiceRollId>(roll.id),
    requestId: roll.requestId,
    actor: {
      actorType: roll.actorType as DiceActorType,
      actorId: roll.actorId,
      actorLabel: roll.actorLabel,
    },
    scriptId: roll.scriptId,
    scriptLabel: roll.scriptLabel,
    scriptRevision: roll.scriptRevision,
    checkId: roll.checkId,
    checkLabel: roll.checkLabel,
    notation: roll.notation,
    faceShape: roll.faceShape as DiceRollSnapshot["faceShape"],
    resolution: roll.resolution as DiceRollSnapshot["resolution"],
    mode: roll.mode as DiceRollSnapshot["mode"],
    included: roll.included,
    finalAttemptId: roll.finalAttemptId,
    attempts: JSON.parse(roll.attemptsJson) as DiceAttempt[],
    ...(roll.finalJson ? { final: JSON.parse(roll.finalJson) } : {}),
    ...(roll.retryReason ? { retryReason: roll.retryReason } : {}),
    ...(roll.policy ? { policy: roll.policy as DiceRollSnapshot["policy"] } : {}),
    boundMessageId: roll.boundMessageId ? brandId(roll.boundMessageId) : null,
    createdAt: roll.createdAt,
  };
}

function mapServiceError(err: DiceServiceError): DiceApiError {
  switch (err.code) {
    case "script_not_found":
      return { status: 422, code: "script_not_found", message: `Script not found` };
    case "script_disabled":
      return { status: 422, code: "script_not_found", message: `Script is disabled` };
    case "script_not_enabled_for_chat":
      return { status: 422, code: "script_not_found", message: `Script not enabled for this chat` };
    case "check_not_found":
      return { status: 422, code: "check_not_found", message: `Check '${err.checkId}' not found` };
    case "actor_ineligible":
      return { status: 422, code: "actor_ineligible", message: `Actor type '${err.actorType}' is not eligible`, allowed: err.allowed };
    case "actor_not_found":
      return { status: 404, code: "actor_not_found", message: `${err.actorType} '${err.actorId}' not found` };
    case "vm_error":
      return { status: 500, code: "vm_error", message: err.message };
    case "validation_error":
      return { status: 422, code: "validation_error", message: err.message };
    case "script_not_dice":
      return { status: 422, code: "script_not_found", message: `Script is not a dice script` };
    default:
      return { status: 500, code: "vm_error", message: "Unknown error" };
  }
}
