import { and, count, eq, isNull, max, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { chatBranches, chats, messages } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { mapRowBranch, type Chat, type ChatBranch } from './chat-store.js';

// ─── Sidebar chat-list aggregate (LC-2) ───────────────────────────────────────
//
// LONG_CHAT_PERFORMANCE_REPORT D2 fix step 2: the sidebar list needs, per chat,
// only the ACTIVE branch's message count, its newest message createdAt and the
// branch label — plus chat-row fields and the character's name. The per-chat
// loop this replaces (mapChatToListItem) loaded every message of every chat's
// active branch (309 chats → 21 762 messages / 33 MB) plus a full character
// record per chat on every list build. ONE aggregate query carries the branch
// side; the character side is one bulk id→name read (character-store).

/** Per-chat sidebar fields derivable purely from chats/branches/messages —
 *  every ChatListItem input except the character's display name. */
export interface ChatListSummary {
	chatId: string;
	title: string;
	characterId: string;
	mode: Chat['mode'];
	updatedAt: string;
	/** Active branch's label, resolved through the getChatState precedence:
	 *  own active branch → root branch → 'Root' (a zero-branch chat's
	 *  auto-created root would display exactly 'Root'). */
	activeBranchLabel: string;
	/** Message count of the resolved active branch. */
	messageCount: number;
	/** Newest message createdAt of the resolved active branch; null when the
	 *  branch is empty (callers fall back to chats.updatedAt). */
	lastMessageAt: string | null;
}

/** ONE query: every chat's row fields + its resolved active branch's label,
 *  message count and newest message createdAt. The branch resolution mirrors
 *  getChatState's defensive precedence (own branch, else the chat's root
 *  branch) — minus that path's on-read repair writes: a dangling
 *  activeBranchId displays the root branch's values but is NOT re-pointed
 *  here (opening the chat through getChatState still repairs it). */
export async function getChatListSummaries(db: AppDb): Promise<Map<string, ChatListSummary>> {
	// Two aliases of chat_branches: the chat's active branch (guarded to belong
	// to THIS chat, so a foreign-chat branch id cannot leak in) and its root
	// branch (parentBranchId IS NULL — the fallback branch delete/repair paths
	// also prefer). The messages join rides the coalesced branch id.
	const activeBranch = alias(chatBranches, 'active_branch');
	const rootBranch = alias(chatBranches, 'root_branch');
	const rows = await db
		.select({
			chatId: chats.id,
			title: chats.title,
			characterId: chats.characterId,
			mode: chats.mode,
			updatedAt: chats.updatedAt,
			activeBranchLabel: sql<string>`coalesce(${activeBranch.label}, ${rootBranch.label}, 'Root')`,
			// COUNT over the joined column (not count()): a chat whose branch has
			// no messages still contributes one NULL-extended row, which a column
			// count skips → 0.
			messageCount: count(messages.id),
			// MAX over TEXT createdAt is the same lexicographic max the old JS
			// reduce computed (ISO-8601 strings compare chronologically).
			lastMessageAt: max(messages.createdAt),
		})
		.from(chats)
		.leftJoin(
			activeBranch,
			and(eq(activeBranch.id, chats.activeBranchId), eq(activeBranch.chatId, chats.id)),
		)
		.leftJoin(
			rootBranch,
			and(eq(rootBranch.chatId, chats.id), isNull(rootBranch.parentBranchId)),
		)
		.leftJoin(
			messages,
			sql`${messages.branchId} = coalesce(${activeBranch.id}, ${rootBranch.id})`,
		)
		// chats.id is the PK, so every other chats column is constant inside its
		// group; the branch labels are functionally determined by the join guards.
		.groupBy(chats.id)
		.all();
	return new Map(rows.map((row) => [row.chatId, {
		chatId: row.chatId,
		title: row.title,
		characterId: row.characterId,
		mode: row.mode as Chat['mode'],
		updatedAt: row.updatedAt,
		activeBranchLabel: row.activeBranchLabel,
		messageCount: row.messageCount,
		lastMessageAt: row.lastMessageAt,
	}]));
}

/** Per-branch message counts for one chat's branches (moved verbatim from
 *  ChatStore.getBranchMessageCounts when the aggregate landed here — the
 *  arch-gate size ratchet on chat-store.ts; ChatStore delegates to this). */
export async function getBranchMessageCounts(db: AppDb, chatId: string): Promise<Map<string, number>> {
	const rows = await db
		.select({
			branchId: messages.branchId,
			count: count(),
		})
		.from(messages)
		.where(eq(messages.chatId, chatId))
		.groupBy(messages.branchId)
		.all();
	return new Map(rows.map((r) => [r.branchId, r.count]));
}

/** All branches of a chat (moved verbatim from ChatStore.getBranches — same
 *  size-ratchet extraction; ChatStore delegates to this). */
export async function getBranches(db: AppDb, chatId: string): Promise<ChatBranch[]> {
	const rows = await db
		.select()
		.from(chatBranches)
		.where(eq(chatBranches.chatId, chatId))
		.all();
	return rows.map((row) => mapRowBranch(row));
}

/** One branch row by id (moved verbatim from ChatStore.getBranch). */
export async function getBranch(db: AppDb, branchId: string): Promise<ChatBranch | null> {
	const row = await db
		.select()
		.from(chatBranches)
		.where(eq(chatBranches.id, branchId))
		.get();
	return row ? mapRowBranch(row) : null;
}
