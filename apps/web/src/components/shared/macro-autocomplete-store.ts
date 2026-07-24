import { create } from "zustand";
import type { MacroCatalogEntry } from "@vibe-tavern/prompt-pipeline";

/**
 * Recency store for the macro autocomplete.
 *
 * Holds the ordered list of recently-picked macro names (most-recent-first),
 * shared across EVERY `AutoTextarea` instance in the app — picking a macro in
 * one field promotes it everywhere. This is plain UI state (NOT persisted):
 * it exists only to make the common identity/pronoun macros rise to the top as
 * the author uses them, with a sensible seed order before first use.
 */

interface MacroAutocompleteState {
  /** Macro names most-recently-first. Empty until the first selection. */
  recency: string[];
  /** Record a selection: hoist `name` to the front (dedup). */
  pick: (name: string) => void;
}

export const useMacroAutocompleteStore = create<MacroAutocompleteState>((set) => ({
  recency: [],
  pick: (name) =>
    set((state) => ({
      recency: [name, ...state.recency.filter((n) => n !== name)],
    })),
}));

/**
 * Category display order for the SEED (pre-recency) list. Identity first (the
 * tokens an author reaches for constantly — `{{user}}`/`{{char}}`/`{{persona}}`),
 * then pronouns (`{{sub}}`/`{{obj}}`/…), then everything else alphabetical by
 * name. Per owner decision A6.
 */
const CATEGORY_SEED_RANK: Record<string, number> = {
  identity: 0,
  pronouns: 1,
};

/**
 * Order the catalog for display: recently-picked names first (in recency
 * order), then the remainder in seed order (identity → pronouns → alphabetical).
 * Pure function over the inputs — exported so the ordering is unit-testable
 * without going through the store.
 */
export function orderMacrosForDisplay(
  catalog: readonly MacroCatalogEntry[],
  recency: readonly string[],
): MacroCatalogEntry[] {
  const byName = new Map<string, MacroCatalogEntry>();
  for (const entry of catalog) byName.set(entry.name, entry);

  const ordered: MacroCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const name of recency) {
    const entry = byName.get(name);
    if (entry && !seen.has(name)) {
      ordered.push(entry);
      seen.add(name);
    }
  }

  const remaining = catalog.filter((entry) => !seen.has(entry.name));
  // Pinned categories (identity, pronouns) keep their CATALOG order (the engine
  // registers them in importance order: user→char→persona, sub→obj→…); the rest
  // sort alphabetically. A stable sort preserves catalog order within a rank.
  const isPinned = (rank: number) => rank < 2;
  remaining.sort((a, b) => {
    const rankA = CATEGORY_SEED_RANK[a.category] ?? 99;
    const rankB = CATEGORY_SEED_RANK[b.category] ?? 99;
    if (isPinned(rankA) && isPinned(rankB)) return rankA - rankB;
    if (!isPinned(rankA) && !isPinned(rankB)) return a.name.localeCompare(b.name);
    return rankA - rankB;
  });

  return [...ordered, ...remaining];
}

/**
 * Filter the catalog by a `{{`-query: substring match on name (canonical and
 * aliases) or description, case-insensitive. An empty query returns the full
 * list (the caller then applies display order). Caps the result so a huge
 * registry can't render thousands of rows.
 */
export function filterMacros(
  catalog: readonly MacroCatalogEntry[],
  query: string,
  limit = 50,
): MacroCatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return catalog.slice(0, limit);
  const out: MacroCatalogEntry[] = [];
  for (const entry of catalog) {
    if (
      entry.name.toLowerCase().includes(q) ||
      entry.description.toLowerCase().includes(q) ||
      entry.aliases.some((alias) => alias.toLowerCase().includes(q))
    ) {
      out.push(entry);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Human label for a macro category (used for the badge in the popup). */
const CATEGORY_LABELS: Record<string, string> = {
  identity: "identity",
  pronouns: "pronouns",
  character: "card",
  chat: "chat",
  runtime: "runtime",
  time: "time",
  utility: "utility",
  variables: "vars",
  random: "random",
};

export function macroCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

/** Maximum query length before the `{{` session is treated as not-a-trigger
 *  (no macro name is anywhere near this long). */
export const MAX_MACRO_QUERY_LEN = 40;

/**
 * Read the active `{{` query for a textarea: the text between the last
 * unbalanced `{{` before the caret and the caret itself. Returns null when no
 * autocomplete session is active (no `{{`, or the session was closed by a `}`,
 * a newline, or an absurdly long query). Pure input→output, exported for
 * unit testing without importing the React component.
 */
export function readMacroQuery(value: string, caret: number): string | null {
  const before = value.slice(0, caret);
  const braceIdx = before.lastIndexOf("{{");
  if (braceIdx === -1) return null;
  const q = before.slice(braceIdx + 2);
  if (q.includes("}") || q.includes("\n") || q.length > MAX_MACRO_QUERY_LEN) return null;
  return q;
}
