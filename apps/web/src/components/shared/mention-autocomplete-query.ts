/**
 * Pure logic for the `@`-mention autocomplete (CX-5,
 * COPILOT_CONTEXT_PICKER_PLAN). Sibling of {@link "./MentionAutocomplete.tsx"}
 * — mirrors the MacroAutocomplete / macro-autocomplete-store split: the React
 * component stays presentational, and every input→output rule (session
 * detection, filtering) lives here so it is unit-testable without a DOM.
 *
 * Trigger design (plan decision): `@` is only the ENTRY gesture — the popover
 * opens while an `@query` session is active at the caret, and picking an item
 * pins the target per-thread (PATCH full-replace of contextLinks). Nothing
 * about the mention persists in the message text.
 *
 * The macro picker (`{{`) deliberately keeps its own module: different
 * trigger, different item shape, and different insert semantics (token
 * insertion vs pin). This module is the shared generalization new surfaces
 * (copilot now, co-author later) adopt.
 */

/** One pickable row in the mention popover. */
export interface MentionAutocompleteItem {
  /** Target kind — a copilot/co-author context target type
   *  ("character" | "persona" | "lorebook" | "script" | "skill"). Rendered as
   *  the type chip; kept a plain string so non-copilot surfaces can reuse the
   *  primitive with their own kinds. */
  targetType: string;
  /** Stable id within the target type (together with `targetType` it forms the
   *  pin identity and the React row key). */
  id: string;
  /** Primary label — the display name the author typed at. */
  label: string;
  /** Optional secondary line (e.g. a skill's one-line description). */
  hint?: string;
}

/** Maximum query length before the `@` session is treated as not-a-trigger
 *  (no character/persona/lorebook/skill name is anywhere near this long). */
export const MAX_MENTION_QUERY_LEN = 40;

/**
 * Index of the `@` that opens the active mention session (see
 * {@link readMentionQuery}), or null when no session is active. The owning
 * surface uses it to STRIP the `@query` from the text when an item is picked
 * (CX-6): `value.slice(0, start) + value.slice(caret)` drops the gesture.
 * Pure input→output, unit-tested with its sibling.
 */
export function mentionQueryStart(value: string, caret: number): number | null {
  const before = value.slice(0, caret);
  for (let i = before.length - 1; i >= 0; i--) {
    const ch = before[i];
    if (/\s/.test(ch)) return null;
    if (ch === "@") {
      if (i > 0 && !/\s/.test(before[i - 1])) return null;
      return i;
    }
  }
  return null;
}

/**
 * Read the active `@` query for a text field: the text between the last
 * word-start `@` before the caret and the caret itself. Returns null when no
 * mention session is active:
 *  - no `@` before the caret, or whitespace between the `@` and the caret
 *    (a space/newline closes the session);
 *  - the `@` is not at word start (mid-word `@` — emails like `a@b` — never
 *    trigger);
 *  - the query exceeds {@link MAX_MENTION_QUERY_LEN}.
 * An empty query right after `@` IS a session (returns "") — the popover then
 * shows the full list, same as the macro picker's bare `{{`.
 * Pure input→output, exported for unit testing without the React component.
 */
export function readMentionQuery(value: string, caret: number): string | null {
  const start = mentionQueryStart(value, caret);
  if (start === null) return null;
  const q = value.slice(start + 1, caret);
  return q.length > MAX_MENTION_QUERY_LEN ? null : q;
}

/**
 * Filter mention items by a query: substring match on label or id,
 * case-insensitive. An empty query returns the full list capped at `limit`
 * (the caller applies display order first — pin order for the copilot).
 */
export function filterMentionItems<T extends MentionAutocompleteItem>(
  items: readonly T[],
  query: string,
  limit = 50,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, limit);
  const out: T[] = [];
  for (const item of items) {
    if (item.label.toLowerCase().includes(q) || item.id.toLowerCase().includes(q)) {
      out.push(item);
      if (out.length >= limit) break;
    }
  }
  return out;
}
