import { DiceApiError } from "../api/dice-api.js";
import { ProviderStreamError } from "../api/provider-stream-error.js";

const DICE_CONFLICT_CODES = new Set(["stale_revision", "unresolved_choose"]);
const EXPERIENCE_CONFLICT_CODES = new Set(["not_found", "already_bound", "stale_queue", "stale_session"]);

export function diceConflictCode(error: unknown): string | undefined {
  const code = error instanceof DiceApiError || error instanceof ProviderStreamError ? error.code : undefined;
  return code !== undefined && DICE_CONFLICT_CODES.has(code) ? code : undefined;
}

export function experienceConflictCode(error: unknown): string | undefined {
  const code = error instanceof DiceApiError || error instanceof ProviderStreamError ? error.code : undefined;
  return code !== undefined && EXPERIENCE_CONFLICT_CODES.has(code) ? code : undefined;
}

export function gateErrorCode(error: unknown): "vision_not_supported" | "voice_transcribe_unavailable" | undefined {
  if (error instanceof Error && error.message === "VISION_NOT_SUPPORTED") return "vision_not_supported";
  if (error instanceof Error && error.message === "VOICE_TRANSCRIBE_UNAVAILABLE") return "voice_transcribe_unavailable";
  const code = error instanceof ProviderStreamError ? error.code : undefined;
  return code === "vision_not_supported" || code === "voice_transcribe_unavailable" ? code : undefined;
}
