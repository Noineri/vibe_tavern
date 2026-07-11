/**
 * Strip markdown code fences that AI models sometimes wrap their output in.
 *
 * Shared by the AI-assistant modal (post-processes streamed script output) and
 * historically by the script editor. Extracted from the two byte-identical
 * inline copies — see AI_ASSISTANT_GOD_OBJECT_AUDIT.md, finding 1.
 */
export function cleanAiCode(raw: string): string {
  let code = raw.trim();
  // Remove opening fence: ```js, ```javascript, ```
  code = code.replace(/^```(?:js|javascript)?\s*\n?/i, '');
  // Remove closing fence
  code = code.replace(/\n?```\s*$/, '');
  return code.trim();
}
