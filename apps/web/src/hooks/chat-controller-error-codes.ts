import { DiceApiError } from "../api/dice-api.js";
import { ProviderStreamError } from "../api/provider-stream-error.js";

// ─── Dice send gate (DICE-F3) ───────────────────────────────────────────
// Subtractive-only: when Dice is disabled, the lane is absent/empty, or there
// is nothing bindable, every helper below collapses to "no Dice" so a no-Dice
// send stays byte-identical to before. Dice can only ever BLOCK a send, never
// make an otherwise-unsendable draft sendable.

const DICE_CONFLICT_CODES = new Set(["stale_revision", "unresolved_choose"]);

// IR-70H Experience bind conflict codes carried on DiceApiError (non-stream
// HTTP 409 via sendChatMessageError) or ProviderStreamError (SSE error event).
// These are server-side commit conflicts, not provider failures — the
// attachment moved under us. Disjoint from DICE_CONFLICT_CODES.
const EXPERIENCE_CONFLICT_CODES = new Set(["not_found", "already_bound", "stale_queue", "stale_session"]);

/** Extract the dice commit-conflict code from either send-mode error: non-stream
 *  throws {@link DiceApiError} (HTTP 409 body `error.details.code`), stream
 *  throws {@link ProviderStreamError} (SSE error event `code`). */
export function diceConflictCode(error: unknown): string | undefined {
  const code = error instanceof DiceApiError || error instanceof ProviderStreamError ? error.code : undefined;
  return code !== undefined && DICE_CONFLICT_CODES.has(code) ? code : undefined;
}

/** Extract the experience bind-conflict code from either send-mode error
 *  (IR-70H). Same transport as {@link diceConflictCode} but checks the four
 *  Experience bind codes — disjoint from the Dice codes. */
export function experienceConflictCode(error: unknown): string | undefined {
  const code = error instanceof DiceApiError || error instanceof ProviderStreamError ? error.code : undefined;
  return code !== undefined && EXPERIENCE_CONFLICT_CODES.has(code) ? code : undefined;
}

/** Typed attachment-gate failures (vision / voice transcribe). Non-stream
 *  throws a sentinel-message Error (unwrap.ts maps the 422 `type` body);
 *  stream throws {@link ProviderStreamError} with the SSE `type` in `code`
 *  (sse-parser). Returns "vision_not_supported" |
 *  "voice_transcribe_unavailable" | undefined. */
export function gateErrorCode(error: unknown): "vision_not_supported" | "voice_transcribe_unavailable" | undefined {
  if (error instanceof Error && error.message === "VISION_NOT_SUPPORTED") return "vision_not_supported";
  if (error instanceof Error && error.message === "VOICE_TRANSCRIBE_UNAVAILABLE") return "voice_transcribe_unavailable";
  const code = error instanceof ProviderStreamError ? error.code : undefined;
  return code === "vision_not_supported" || code === "voice_transcribe_unavailable" ? code : undefined;
}
