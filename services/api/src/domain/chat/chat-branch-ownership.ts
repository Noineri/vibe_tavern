import type { Chat, ChatBranch, ChatStore } from "@vibe-tavern/db";
import { notFound } from "../../shared/errors.js";

/**
 * THE single source for the (chat, branch) ownership pair check
 * (SIDECHAT_PLAN SC-0l): "the branch exists AND belongs to this chat".
 * Every route or service that takes a chat id together with a branch id
 * resolves the pair through this module — never a private copy of the
 * comparison, because a copy that forgets the ownership half lets one
 * chat's path read another chat's branch. The REACTION to a failed pair
 * stays at each caller: strict callers use {@link requireChatBranch} (the
 * SC-0b/SC-0h adapters' two 404s); soft callers branch on
 * {@link findBranchOfChat} returning null and keep their own reaction
 * (404 "Branch", a plain Error, or an empty result).
 */

/** The minimal chat-store seam this module reads — a `Pick` so tests and
 *  callers can pass a narrow stub instead of the whole ChatStore. */
export type ChatBranchLookup = Pick<ChatStore, "getById" | "getBranches">;

/**
 * The branch when it exists AND belongs to `chatId`, else null — membership
 * in the chat's branch list IS the ownership relation (both derive from the
 * same chat_branches.chatId column).
 *
 * A missing branch and another chat's branch are deliberately
 * indistinguishable here (both null): callers that must report WHICH half
 * failed fetch the chat first — see {@link requireChatBranch}.
 */
export async function findBranchOfChat(
	chats: ChatBranchLookup,
	chatId: string,
	branchId: string,
): Promise<ChatBranch | null> {
	const branches = await chats.getBranches(chatId);
	return branches.find((b) => b.id === branchId) ?? null;
}

/**
 * The strict pair check the chat-owner routes run (SC-0b chat sessions,
 * SC-0h branch plans): resolves to `{ chat, branch }`, or throws the same
 * two 404s those adapters' private copies threw — chat missing →
 * `notFound("Chat", …)` first, then a missing OR foreign branch →
 * `notFound("ChatBranch", …)` (same entity names, same messages; a foreign
 * branch id under this chat's path is a 404, never a cross-owner leak).
 */
export async function requireChatBranch(
	chats: ChatBranchLookup,
	chatId: string,
	branchId: string,
): Promise<{ chat: Chat; branch: ChatBranch }> {
	const chat = await chats.getById(chatId);
	if (!chat) {
		throw notFound("Chat", `Chat '${chatId}' was not found.`);
	}
	const branch = await findBranchOfChat(chats, chatId, branchId);
	if (!branch) {
		throw notFound("ChatBranch", `Branch '${branchId}' was not found for chat '${chatId}'.`);
	}
	return { chat, branch };
}
