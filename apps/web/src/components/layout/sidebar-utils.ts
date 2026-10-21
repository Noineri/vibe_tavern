/**
 * Pure positioning + date-format helpers shared by the layout shells.
 *
 * Extracted from `Sidebar.tsx` (SF-3) so the co-author shell fork can consume
 * them without copying. Consumers: the desktop `Sidebar` family and, since
 * RAIL_DRILL_IN RD-2, the mobile character-chats panel (dates on chat/branch
 * rows, the branch-delete rule) and, since RD-3, the rail's character browser
 * (the «N chats · when» summary); `CoauthorSidebar` / `CoauthorRail` import from
 * here as they land (SF-4 / SF-5).
 *
 * All functions are pure — no component state, no store reads. DOM-geometry
 * helpers take the trigger element and return viewport-relative coords for a
 * portaled dropdown (portaled to `document.body` because the sidebar/rail root
 * is a CSS backdrop root — see the in-component comment on charSwitcherPos).
 */

import type { ChatBranch, ChatBranchId } from "@vibe-tavern/domain";
import type { ChatListItem } from "@vibe-tavern/api-contracts";
import { resolveEntityAvatarUrl } from "../../lib/avatar.js";

/** Resolve a character tab's avatar URL (folder avatar when migrated). Pure. */
export function tabAvatarSrc(tab: { id: string; avatarExt: string | null; avatarAssetId: string | null; updatedAt?: string | null }): string | null {
	return resolveEntityAvatarUrl({ kind: "characters", id: tab.id, avatarExt: tab.avatarExt, avatarAssetId: tab.avatarAssetId, updatedAt: tab.updatedAt });
}

/** Short absolute date (e.g. "Jul 3"). Empty for null/invalid input. */
export function formatShortDate(value: string | null | undefined): string {
	if (!value) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Relative time (e.g. "2h ago"), falling back to {@link formatShortDate} beyond a week. */
export function formatRelativeTime(value: string | null | undefined): string {
	if (!value) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	const diffSec = (Date.now() - date.getTime()) / 1000;
	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
	if (diffSec < 45) return rtf.format(0, "second");
	if (diffSec < 3600) return rtf.format(-Math.round(diffSec / 60), "minute");
	if (diffSec < 86400) return rtf.format(-Math.round(diffSec / 3600), "hour");
	if (diffSec < 604800) return rtf.format(-Math.round(diffSec / 86400), "day");
	return formatShortDate(value);
}

/**
 * Whether the ACTIVE branch of a chat may be deleted from the chat UI: never
 * the root (main timeline) branch, and never when it is the only branch.
 *
 * The one home of this rule — the desktop sidebar's chat row, its collapsed
 * flyout and the phone/tablet character-chats panel all read it, so the
 * «Delete» control (enabled state, tooltip / toast) cannot drift between them.
 * `useChatController.handleDeleteActiveBranch` re-checks the root case itself.
 */
export function canDeleteActiveBranch(
	branches: readonly Pick<ChatBranch, "id" | "parentBranchId">[],
	activeBranchId: ChatBranchId | null,
): boolean {
	const rootBranch = branches.find((b) => b.parentBranchId === null);
	const activeIsRoot = rootBranch != null && activeBranchId === rootBranch.id;
	return !activeIsRoot && branches.length > 1;
}

/**
 * What the phone rail's character list shows under a character's name: how many
 * chats its screen lists and when the newest one was last touched.
 */
export interface CharacterChatsSummary {
	readonly count: number;
	/** `updatedAt` of the most recently updated chat; null with no chats (or no parsable timestamp). */
	readonly newestUpdatedAt: string | null;
}

/**
 * Summary of ONE character's chats. Feed it the chats the character's screen
 * lists (the active chat's mode bucket from `useSidebarChats`' `sectionChats`),
 * so the count on the list row equals the rows on the screen it opens — the
 * mode rule lives in that hook only.
 */
export function summarizeCharacterChats(chats: readonly Pick<ChatListItem, "updatedAt">[]): CharacterChatsSummary {
	let newestUpdatedAt: string | null = null;
	let newestMs = Number.NEGATIVE_INFINITY;
	for (const chat of chats) {
		const ms = Date.parse(chat.updatedAt);
		if (Number.isNaN(ms) || ms <= newestMs) continue;
		newestMs = ms;
		newestUpdatedAt = chat.updatedAt;
	}
	return { count: chats.length, newestUpdatedAt };
}

/**
 * {@link summarizeCharacterChats} for every character at once, in one pass
 * over an already mode-bucketed, unscoped chat list. A character without chats
 * has no entry — read it as `summarizeCharacterChats([])`.
 */
export function summarizeChatsByCharacter(
	chats: readonly Pick<ChatListItem, "characterId" | "updatedAt">[],
): ReadonlyMap<string, CharacterChatsSummary> {
	const byCharacter = new Map<string, Pick<ChatListItem, "characterId" | "updatedAt">[]>();
	for (const chat of chats) {
		const bucket = byCharacter.get(chat.characterId);
		if (bucket) bucket.push(chat);
		else byCharacter.set(chat.characterId, [chat]);
	}
	return new Map([...byCharacter].map(([characterId, list]) => [characterId, summarizeCharacterChats(list)] as const));
}
