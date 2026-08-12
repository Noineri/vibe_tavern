/**
 * Exact SEARCH/REPLACE text editing — pure helpers shared by the AI editing
 * tools (co-author section tools today; the experience-copilot buffer tools
 * next). No I/O, no store access: these are the INPUT-side composition
 * primitive of the co-author "Google-Docs-Suggestions / pull-request" pattern.
 *
 * The model emits small ordered `{ search, replace }` hunks;
 * {@link applyExactEditsToBody} composes them into a whole document, and the
 * user reviews the full canonical→proposed diff on the OUTPUT side (frontend
 * hunk review). The composition is atomic: a failed item throws and the caller
 * discards the partial result, so a batch is all-or-nothing.
 */

/** Count non-overlapping literal occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/**
 * Apply an ordered batch of exact SEARCH/REPLACE edits to a single text body
 * (pure). Each `search` must be non-empty, differ from `replace`, and match
 * EXACTLY ONCE in the CURRENT (already-mutated-by-prior-items-in-this-batch)
 * body. Matching is literal — case-sensitive, no regex, no `$` substitution —
 * implemented via indexOf+slice so replacement text is never reinterpreted. A
 * failed item throws and the caller discards the partial result, so a batch
 * commits atomically (all-or-nothing).
 *
 * `toolName` is folded into thrown error messages only (so callers can tell
 * which tool a failing edit came from); it does not affect the result.
 */
export function applyExactEditsToBody(
  body: string,
  edits: ReadonlyArray<{ search: string; replace: string }>,
  toolName: string,
): string {
  let result = body;
  for (const { search, replace } of edits) {
    if (!search) {
      throw new Error(`${toolName}: edit.search must not be empty`);
    }
    if (search === replace) {
      throw new Error(`${toolName}: edit is a no-op (search === replace): ${JSON.stringify(search.slice(0, 80))}`);
    }
    const count = countOccurrences(result, search);
    if (count === 0) {
      throw new Error(
        `${toolName}: edit.search not found in the current section body: ${JSON.stringify(search.slice(0, 80))}`,
      );
    }
    if (count > 1) {
      throw new Error(
        `${toolName}: edit.search is ambiguous (${count} matches) — add more surrounding context so it matches once: ${JSON.stringify(search.slice(0, 80))}`,
      );
    }
    const idx = result.indexOf(search);
    result = result.slice(0, idx) + replace + result.slice(idx + search.length);
  }
  return result;
}
