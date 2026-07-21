/**
 * Dice adapter (DICE_SYSTEM_BACKEND_PLAN, Wave B3 / DICE-B8).
 *
 * Thin glue between the Hono route layer and the DiceService. Maps HTTP
 * errors to the appropriate status codes and exposes the 7 chat-scoped
 * Dice endpoints.
 */

import type { DiceRuntimeApi } from "../contract/runtime-api.js";
import type { DiceService, DicePendingState } from "../../domain/dice/dice-service.js";
import type { DiceActorType, DiceMode, DiceRollSnapshot } from "@vibe-tavern/domain";
import type { DiceDefinitionsResponse } from "../../domain/scripts-engine/dice-script-service.js";
import { DomainError } from "../../shared/errors.js";

export class DiceAdapter implements DiceRuntimeApi {
  constructor(private readonly diceService: DiceService) {}

  getDefinitions = async (chatId: string): Promise<{ scripts: DiceDefinitionsResponse["scripts"] }> => {
    const result = await this.diceService.listDefinitions(chatId);
    if (!result.ok) throw mapError(result.error);
    return result.data;
  };

  getPending = async (chatId: string, branchId: string): Promise<DicePendingState> => {
    const result = await this.diceService.getPendingState(chatId, branchId);
    if (!result.ok) throw mapError(result.error);
    return result.data;
  };

  roll = async (
    chatId: string,
    body: { scriptId: string; checkId: string; actorType: DiceActorType; actorId: string; mode: DiceMode; requestId: string },
  ): Promise<DiceRollSnapshot> => {
    const result = await this.diceService.roll(chatId, body);
    if (!result.ok) throw mapError(result.error);
    return result.data;
  };

  removeRoll = async (chatId: string, rollId: string): Promise<void> => {
    const result = await this.diceService.removeRoll(chatId, rollId);
    if (!result.ok) throw mapError(result.error);
  };

  clearLane = async (chatId: string, branchId: string): Promise<void> => {
    const result = await this.diceService.clearLane(chatId, branchId);
    if (!result.ok) throw mapError(result.error);
  };

  setIncluded = async (chatId: string, rollId: string, included: boolean): Promise<void> => {
    const result = await this.diceService.setIncluded(chatId, rollId, included);
    if (!result.ok) throw mapError(result.error);
  };

  chooseFinal = async (chatId: string, rollId: string, attemptId: string): Promise<void> => {
    const result = await this.diceService.chooseFinal(chatId, rollId, attemptId);
    if (!result.ok) throw mapError(result.error);
  };
}

function mapError(err: { status: number; code: string; message: string; [k: string]: unknown }): never {
  const kind = err.status === 404 ? "NotFound"
    : err.status === 409 ? "Conflict"
    : err.status === 422 ? "Validation"
    : "Internal";
  throw new DomainError({
    kind,
    message: err.message,
    details: { code: err.code, ...Object.fromEntries(Object.entries(err).filter(([k]) => !["status", "code", "message"].includes(k))) },
  });
}
