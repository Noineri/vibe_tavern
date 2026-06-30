/**
 * Pure sidebar list filtering + sorting.
 *
 * Shared by the characters and chats lists (desktop Sidebar + mobile Rail) so
 * both surfaces apply identical logic. The function is deliberately pure and
 * generic: callers enrich each item with a `recentKey` (ISO timestamp) and, for
 * tag-capable lists, a `tags` array, then pass the sort mode, the name query,
 * and the selected tags.
 *
 * Recency source:
 * - Chats: the item's own `lastMessageAt` (already on ChatListItem).
 * - Characters: the caller computes `max(lastMessageAt)` across the character's
 *   chats and writes it onto the item as `recentKey`.
 *
 * Filter semantics: the name query is a case-insensitive substring on the
 * item's name; tag filtering is AND — an item must contain ALL selected tags.
 * The two filters AND together (name matches AND all tags present).
 *
 * Sort:
 * - `alphabetical` → name.localeCompare (locale-aware, stable for i18n).
 * - `recent` → recentKey DESC. ISO-8601 strings of the same format compare
 *   correctly lexicographically, so no Date parsing is needed.
 */

import type { ListSortMode } from "../stores/navigation-store.js";

export interface ListFilterable {
  /** ISO timestamp used as the "recent" sort key. Empty sorts last. */
  recentKey: string;
  /** Tags present on the item. Optional — absent on chat items. */
  tags?: readonly string[];
}

export interface FilterAndSortListArgs<T extends ListFilterable> {
  items: readonly T[];
  /** Item display name (characters use `name`, chats use `title`). */
  getName: (item: T) => string;
  sortMode: ListSortMode;
  query: string;
  selectedTags: readonly string[];
}

export function filterAndSortList<T extends ListFilterable>(args: FilterAndSortListArgs<T>): T[] {
  const q = args.query.trim().toLowerCase();
  const tags = args.selectedTags;

  const filtered = args.items.filter((item) => {
    if (q && !args.getName(item).toLowerCase().includes(q)) return false;
    if (tags.length > 0) {
      const itemTags = item.tags;
      if (!itemTags) return false;
      // AND: every selected tag must be present on the item.
      return tags.every((tag) => itemTags.includes(tag));
    }
    return true;
  });

  // Copy before sort — Array.prototype.sort mutates in place; the input array
  // is often a store-derived reference we must not mutate.
  return filtered.slice().sort((a, b) => {
    if (args.sortMode === "alphabetical") {
      return args.getName(a).localeCompare(args.getName(b));
    }
    return b.recentKey.localeCompare(a.recentKey);
  });
}
