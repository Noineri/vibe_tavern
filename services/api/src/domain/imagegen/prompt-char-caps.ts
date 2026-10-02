/**
 * Prompt character-cap parsing (IF-10). Providers (nanogpt observed live
 * 2026-09-25) enforce per-model image-prompt length limits that NO listing
 * surface exposes — the cap is discoverable only from the rejection. The
 * wire shapes observed on one provider, two envelope kinds, same prose:
 *
 *   {"error":{"message":"Your prompt is too long. Please shorten it to
 *   3000 characters or less (current: 15199 characters).",
 *   "type":"invalid_request_error","code":"prompt_too_long"},
 *   "code":"prompt_too_long"}
 *
 *   {"error":"Your prompt is too long for Z Image Turbo. Please shorten it
 *   to 1200 characters or less (current: 5399 characters).",
 *   "code":"prompt_too_long"}
 *
 * `provider-error-body.ts` flattens both to the message string before this
 * parser sees it, so the match is on the prose alone — any provider whose
 * rejection phrases the cap this way is learned; a different phrasing
 * simply stays unlearned (the failure text still reaches the toast
 * verbatim, which is the hard guarantee that never regresses).
 */

/** The vendor's observed phrasing: "… shorten it to N characters or less". */
const CAP_PHRASE = /shorten it to (\d+) characters? or less/i;

/**
 * Extract the enforced prompt cap from a provider failure message; null when
 * the message carries no parseable cap (a non-limit failure, or a limit
 * phrased in units we cannot map to characters — never a guess).
 */
export function parsePromptCharCapFromErrorMessage(message: string): number | null {
  const hit = CAP_PHRASE.exec(message);
  if (hit === null) return null;
  const parsed = Number.parseInt(hit[1]!, 10);
  // A sane guard: a "cap" of 0 or an absurdly large value is a parse
  // artifact, not a limit worth teaching.
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 1_000_000) return null;
  return parsed;
}
