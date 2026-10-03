/**
 * @module chat/imagegen-assist-refusal
 *
 * IMAGEGEN_ASSIST_REFUSAL_REPORT step 1: refusal detection over the IG-15
 * assist output. Conjunctive by design — a refusal is ONLY flagged when
 * BOTH hold:
 *
 *   1. refusal phrasing (EN + RU: "I can't / I won't / I'm sorry but /
 *      не могу / не буду / извините / простите …"), AND
 *   2. a structural signal: first-person meta about the assistant (the
 *      output talks about what the model will/won't do) OR the absence of
 *      prompt structure (neither a comma-separated tag list nor BREAK
 *      sectioning nor underscore tags — the shapes every prompt dialect
 *      here produces).
 *
 * A single keyword list is explicitly rejected (report verdict): "sorry"
 * inside quoted scene dialog is a legitimate image tag, and a prompt like
 * `a soldier whispering "I'm sorry, but I can't come home", rain, trench`
 * must NOT be flagged. Quoted spans ("…" and «…") are therefore STRIPPED
 * before the first-person scan, and prompt structure alone can veto the
 * second signal — but the phrasing arm stays first-person-anchored
 * ("I'm sorry but", not bare "sorry"), so the conjunction survives both
 * traps.
 *
 * Pure module (no imports, no I/O): the seam tests pin EN/RU refusals and
 * the scene-dialog traps directly against this contract.
 */

/** EN refusal phrasing — first-person anchored (bare "sorry" is scene
 *  vocabulary; "sorry" counts only when a punctuation mark follows it
 *  immediately — "muttering sorry under his breath" is a pose, "Sorry, no."
 *  is an answer). */
const EN_REFUSAL_PHRASING =
  /\b(i can'?t|i cannot|i can not|i won'?t|i will not|i'?m sorry|i am sorry|sorry,? but|sorry\b(?=[,.!?])|i apologize|i'?m unable|i am unable|unable to comply|i must decline|i'?m not able)\b/i;

/** RU refusal phrasing — substring anchors are safe (each phrase is
 *  multi-syllable and never a scene word). */
const RU_REFUSAL_PHRASING =
  /(не\s+могу|не\s+могу\s+писать|не\s+смогу|не\s+буду|не\s+стану|извините|простите|я\s+не\s+в\s+состоянии)/i;

/** First-person markers (EN ASCII \b works natively; RU needs explicit
 *  non-letter guards because JS \b is ASCII-only and Cyrillic letters are
 *  not \w). */
const EN_FIRST_PERSON = /\b(i|i'?m|i'?ve|my|me|myself)\b/i;
const RU_FIRST_PERSON = /(^|[^а-яёА-ЯЁ])(я|мне|меня|мною|мой|моя|мое|моё|мою)(?![а-яёА-ЯЁ])/;

/** Prompt-structure markers — the shapes every prompt dialect here
 *  produces (tag lists with commas, underscore multi-word tags, BREAK
 *  sectioning). Prose prompts without any of these are rare; a refusal is
 *  conversational and never carries them. */
function hasPromptStructure(text: string): boolean {
  const segments = text.split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (segments.length >= 3) return true;
  if (/[a-z0-9]+_[a-z0-9]+/i.test(text)) return true;
  if (/(^|\s)BREAK(\s|$)/.test(text)) return true;
  return false;
}

/** Strip quoted spans (straight/curly double quotes + guillemets) so
 *  first-person markers inside scene dialog never count as assistant
 *  meta. Single quotes are NOT stripped — apostrophes ("I'm") live there. */
function stripQuotedSpans(text: string): string {
  return text.replace(/"[^"]*"/g, " ").replace(/“[^”]*”/g, " ").replace(/«[^»]*»/g, " ");
}

/** True when the assist output is a refusal (conjunctive contract above).
 *  Empty/whitespace text is never a refusal — the seam's empty-prompt
 *  guard owns that case. */
export function isImageGenAssistRefusal(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  const phrasing = EN_REFUSAL_PHRASING.test(trimmed) || RU_REFUSAL_PHRASING.test(trimmed);
  if (!phrasing) return false;
  const unquoted = stripQuotedSpans(trimmed);
  const firstPersonMeta = EN_FIRST_PERSON.test(unquoted) || RU_FIRST_PERSON.test(unquoted);
  return firstPersonMeta || !hasPromptStructure(trimmed);
}
