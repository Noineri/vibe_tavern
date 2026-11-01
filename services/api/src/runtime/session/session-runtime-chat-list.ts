import type { StoreContainer } from "@vibe-tavern/db";
import {
	brandId,
	type CharacterId,
	type ChatId,
} from "@vibe-tavern/domain";
import type { ChatListItem } from "../../api/contract/session-types.js";

/**
 * Sidebar chat-list items for SessionRuntime (LC-2, LONG_CHAT_PERFORMANCE_REPORT
 * D2 fix step 2). ONE derivation: two bulk reads — the chat-list aggregate
 * (stores.chats.getChatListSummaries: chats + resolved active-branch count /
 * max(createdAt) / label in ONE query) and the character id→name map — mapped
 * over the caller's ordered id list. The caller owns the ORDER (fetchChatList:
 * the in-memory chatOrder; listCoauthorChats: listByCharacterAndMode rows).
 *
 * Replaces the per-chat mapChatToListItem loop, which loaded EVERY message of
 * every chat's active branch (309 chats → 21 762 messages / 33 MB) plus a full
 * character record per chat on every sidebar refresh.
 */
export async function buildChatListItems(
	stores: StoreContainer,
	orderedChatIds: readonly string[],
): Promise<ChatListItem[]> {
	const [summaries, characterNames] = await Promise.all([
		stores.chats.getChatListSummaries(),
		stores.characters.listIdNameMap(),
	]);
	const items: ChatListItem[] = [];
	for (const chatId of orderedChatIds) {
		const row = summaries.get(chatId);
		if (!row) continue; // stale order entry (chat deleted elsewhere): the
		// old loop crashed here on a null getById; a read path must not 500 the
		// sidebar over one stale id.
		items.push({
			id: brandId<ChatId>(row.chatId),
			title: row.title,
			characterId: brandId<CharacterId>(row.characterId),
			// Since-deleted character keeps the placeholder (the resolver's
			// NotFound catch, pinned): "Unknown" / "". subtitle is constant ""
			// — toCharacterRecord never derives tags[0] on this path.
			characterName: characterNames.get(row.characterId) ?? "Unknown",
			subtitle: "",
			activeBranchLabel: row.activeBranchLabel,
			mode: row.mode,
			messageCount: row.messageCount,
			// Precedence pinned from the old per-chat reduce: newest active-
			// branch message createdAt, falling back to chat.updatedAt when the
			// branch is empty.
			lastMessageAt: row.lastMessageAt ?? row.updatedAt,
			updatedAt: row.updatedAt,
		});
	}
	return items;
}
