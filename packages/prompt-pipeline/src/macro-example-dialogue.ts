/**
 * The separator used between character-card example dialogue blocks.
 *
 * SillyTavern obtains this from its context template. VT's layer-based prompt
 * format does not retain that template setting, so a newline is the explicit
 * fallback between parsed `<START>` blocks.
 */
export const EXAMPLE_DIALOGUE_SEPARATOR = "\n";

/**
 * Formats a character card's raw `mes_example` field for `{{mesExamples}}`.
 *
 * `<START>` divides individual example blocks. A card without a marker still
 * represents one block; blank blocks are ignored. `{{mesExamplesRaw}}` must
 * continue returning the unmodified source text instead.
 */
export function formatExampleDialogue(raw: string): string {
  const normalized = raw.trim();
  if (!normalized) return "";

  const blocks = normalized
    .split(/<START>/i)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  return blocks.join(EXAMPLE_DIALOGUE_SEPARATOR);
}
