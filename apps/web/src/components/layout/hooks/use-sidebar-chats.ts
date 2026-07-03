/**
 * Sidebar chat-list derivation — shared by the desktop `Sidebar` and the mobile
 * `Rail`, and (after the shell fork) by `CoauthorSidebar` / `CoauthorRail`.
 *
 * Owns the three-step pipeline that both surfaces previously duplicated inline:
 *   1. character-scope the full chat list down to one character's chats;
 *   2. enrich each chat with a `recentKey` (= its own `lastMessageAt`) and apply
 *      the shared name search + recency/alphabetical sort via `filterAndSortList`;
 *   3. split the sorted result by chat `mode` into the RP and co-author subsets,
 *      and select the subset active for the current nav `mode`.
 *
 * The mode split is what gives the rail the mode-awareness it previously lacked
 * (the rail rendered every chat for the active character regardless of mode —
 * the never-landed mode integration). After the fork, each shell consumes only
 * the subset it owns, but the derivation stays single-sourced here so desktop
 * and mobile can never drift on sort/filter/grouping.
 *
 * This is a derivation hook, not a stateful one: `allChats`, `characterId`, and
 * the live `query` come from the caller (the caller already derives the first
 * two for its own rendering and owns the search-input state locally); only
 * `chatSortMode` and nav `mode` are read from the navigation store, because
 * they are global and shared across both surfaces.
 */
import { useMemo } from "react";
import type { ChatListItem } from "../../../app-client.js";
import { filterAndSortList } from "../../../lib/list-filter.js";
import { useNavigationStore } from "../../../stores/index.js";

export interface UseSidebarChatsArgs {
	/** Full chat list (typically `chatMeta?.chats ?? []`). */
	readonly allChats: readonly ChatListItem[];
	/**
	 * The character to scope to. `null` leaves the list unscoped (all chats).
	 * Both shells derive this identically: `selectedCharacterId ?? activeChat.characterId`.
	 */
	readonly characterId: string | null;
	/** Live chat-search query (local UI state owned by the caller). */
	readonly query: string;
}

export interface UseSidebarChatsResult {
	/** Character-scoped chat list (step 1; unsorted, unenriched). */
	readonly chats: readonly ChatListItem[];
	/** Character-scoped + searched + sorted (steps 1–2). */
	readonly visibleChats: readonly ChatListItem[];
	/** `visibleChats` filtered to RP chats (`mode !== "coauthor"`). */
	readonly rpVisibleChats: readonly ChatListItem[];
	/** `visibleChats` filtered to co-author chats (`mode === "coauthor"`). */
	readonly coauthorVisibleChats: readonly ChatListItem[];
	/** The subset active for the current nav mode: co-author chats under `coauthor`, RP chats otherwise (incl. `build`). */
	readonly sectionChats: readonly ChatListItem[];
}

export function useSidebarChats({ allChats, characterId, query }: UseSidebarChatsArgs): UseSidebarChatsResult {
	const sortMode = useNavigationStore((s) => s.chatSortMode);
	const mode = useNavigationStore((s) => s.mode);

	// Step 1 — character-scope. Matches the previous inline memo: scoped when a
	// character is selected, otherwise the full list (NOT a copy — downstream
	// `.map` in step 2 allocates fresh objects, so the store array is only read).
	const chats = useMemo(
		() => (characterId ? allChats.filter((c) => c.characterId === characterId) : allChats),
		[allChats, characterId],
	);

	// Step 2 — enrich + search + sort. Chats carry no tags, so tag filtering is
	// disabled (empty array). `recentKey` is the chat's own `lastMessageAt`.
	const visibleChats = useMemo(() => {
		const enriched = chats.map((c) => ({ ...c, recentKey: c.lastMessageAt }));
		return filterAndSortList({
			items: enriched,
			getName: (i) => i.title,
			sortMode,
			query,
			selectedTags: [],
		});
	}, [chats, sortMode, query]);

	// Step 3 — mode split. A single pass keeps this O(n) rather than two filters.
	const { rpVisibleChats, coauthorVisibleChats } = useMemo(() => {
		const rp: ChatListItem[] = [];
		const co: ChatListItem[] = [];
		for (const c of visibleChats) {
			if (c.mode === "coauthor") co.push(c);
			else rp.push(c);
		}
		return { rpVisibleChats: rp, coauthorVisibleChats: co };
	}, [visibleChats]);

	const sectionChats = mode === "coauthor" ? coauthorVisibleChats : rpVisibleChats;

	return { chats, visibleChats, rpVisibleChats, coauthorVisibleChats, sectionChats };
}
