/**
 * Sidebar character-list derivation — shared by the desktop `Sidebar` and the
 * mobile `Rail` (and after the shell fork, by `CoauthorSidebar` / `CoauthorRail`).
 *
 * Owns the character-tab pipeline both surfaces previously duplicated inline:
 *   1. mode-filter the chat list (F-6 fix) — a character's resolved `chatId`
 *      must come from the CURRENT nav mode's chats, not all chats. Before this
 *      hook, `buildCharacterTabs(allCharacters, allChats)` built its
 *      characterId→chatId map over EVERY chat (RP + co-author) and picked the
 *      first, so clicking a character in the RP sidebar could open its
 *      co-author chat. The hook filters chats by nav mode first.
 *   2. build `characterTabs` via `buildCharacterTabs` (now mode-scoped);
 *   3. `charTagPool` — every tag across all characters, for the filter UI;
 *   4. enrich each tab with a `recentKey` (max `lastMessageAt` across the
 *      character's MODE-SCOPED chats — consistent with the chatId fix) and its
 *      tags, then apply the shared filter + sort via `filterAndSortList`.
 *
 * `query` and `selectedTags` are caller-owned local UI state (the search input
 * + tag combobox live in the shell); `characterSortMode` and nav `mode` are read
 * from the navigation store because they are global and shared across surfaces.
 *
 * Rail note: the Rail does not use `characterTabs` (it renders characters
 * directly and switches chats by explicit chat click, so it is immune to F-6),
 * but it DOES consume `visibleCharacterTabs` + `charTagPool` so desktop and
 * mobile can't drift on character sort/filter/tag-pool.
 */
import { useMemo } from "react";
import type { ChatListItem } from "../../../app-client.js";
import { buildCharacterTabs } from "../../../lib/character-tabs.js";
import { filterAndSortList } from "../../../lib/list-filter.js";
import { useNavigationStore } from "../../../stores/index.js";
import type { CharacterTab } from "../app-shell-types.js";

export interface UseSidebarCharactersArgs {
	/** Full character list (typically from bootstrap snapshot). Mode-filtered internally. */
	readonly allCharacters: Array<{
		id: string;
		name: string;
		subtitle: string;
		avatarAssetId: string | null;
		avatarCropJson: string | null;
		avatarExt: string | null;
		updatedAt: string;
		tags?: readonly string[] | null;
	}>;
	/** Full chat list (typically `chatMeta?.chats ?? []`). Mode-filtered internally. */
	readonly allChats: readonly ChatListItem[];
	/** Live character-search query (local UI state owned by the caller). */
	readonly query: string;
	/** Live tag-filter selection (local UI state owned by the caller). */
	readonly selectedTags: readonly string[];
}

export interface UseSidebarCharactersResult {
	/** Character tabs built from the mode-scoped chats (F-6 fix). */
	readonly characterTabs: readonly CharacterTab[];
	/** Every tag across all characters, sorted — for the filter combobox / bottom sheet. */
	readonly charTagPool: readonly string[];
	/** Character tabs enriched (recentKey + tags) + searched + tag-filtered + sorted. */
	readonly visibleCharacterTabs: readonly CharacterTab[];
}

export function useSidebarCharacters({ allCharacters, allChats, query, selectedTags }: UseSidebarCharactersArgs): UseSidebarCharactersResult {
	const sortMode = useNavigationStore((s) => s.characterSortMode);
	const mode = useNavigationStore((s) => s.mode);

	// Step 1 — F-6 fix: scope chats to the current nav mode before the character
	// tabs are built, so a character's resolved chatId is always from this mode.
	// `buildCharacterTabs` picks the first chat per character; without this filter
	// it could pick a co-author chat for an RP character tab (or vice versa).
	const modeChats = useMemo(
		() => (mode === "coauthor" ? allChats.filter((c) => c.mode === "coauthor") : allChats.filter((c) => c.mode !== "coauthor")),
		[allChats, mode],
	);

	// Step 2 — build tabs over the mode-scoped chats.
	const characterTabs = useMemo(
		() => buildCharacterTabs(allCharacters, modeChats),
		[allCharacters, modeChats],
	);

	// Step 3 — tag pool across all characters (independent of mode: a character's
	// tags don't change between modes; only its chats do).
	const charTagPool = useMemo(
		() => Array.from(new Set(allCharacters.flatMap((c) => c.tags ?? []))).sort((a, b) => a.localeCompare(b)),
		[allCharacters],
	);

	// Step 4 — enrich + search + tag-filter + sort. recentKey is the max
	// lastMessageAt across the character's MODE-SCOPED chats (consistent with
	// the chatId fix: a character with only an old co-author chat sorts by its
	// RP chats in play mode, not by the co-author chat it no longer shows).
	const visibleCharacterTabs = useMemo(() => {
		const lastByChar = new Map<string, string>();
		for (const ch of modeChats) {
			const prev = lastByChar.get(ch.characterId) ?? "";
			if (ch.lastMessageAt > prev) lastByChar.set(ch.characterId, ch.lastMessageAt);
		}
		const tagsById = new Map(allCharacters.map((c) => [c.id, c.tags ?? []] as const));
		const enriched = characterTabs.map((tab) => ({
			...tab,
			recentKey: lastByChar.get(tab.id) ?? "",
			tags: tagsById.get(tab.id) ?? [],
		}));
		return filterAndSortList({
			items: enriched,
			getName: (i) => i.name,
			sortMode,
			query,
			selectedTags,
		});
	}, [characterTabs, allCharacters, modeChats, sortMode, query, selectedTags]);

	return { characterTabs, charTagPool, visibleCharacterTabs };
}
