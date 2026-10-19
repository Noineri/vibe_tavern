import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreContainer, type StoreContainer, type Chat } from "@vibe-tavern/db";
import { findBranchOfChat, requireChatBranch } from "../src/domain/chat/chat-branch-ownership.js";
import { isDomainError, httpStatusForDomainError } from "../src/shared/errors.js";

/**
 * The SC-0l ownership module — the single source for "this branch belongs
 * to this chat". The real store container runs end-to-end (in-memory temp
 * DB, no mocked store), same seam as the adapters. Pins: an own branch
 * resolves through BOTH helpers; a missing branch and another chat's
 * branch are indistinguishable in findBranchOfChat (both null — callers
 * that must name the failed half use requireChatBranch) and both 404 as
 * `ChatBranch` there; a missing chat 404s as `Chat` first. The two 404
 * messages are pinned BYTE-FOR-BYTE: they are the SC-0b/SC-0h adapters'
 * wire texts, now owned by this module.
 */

let stores: StoreContainer;
let chat: Chat;
let otherChat: Chat;

beforeAll(async () => {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-chat-branch-ownership-"));
	stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const character = await stores.characters.create({ name: "Ownership fixture" });
	chat = await stores.chats.createChat({
		characterId: character.id,
		title: "Owner chat",
		promptPresetId: null,
	});
	otherChat = await stores.chats.createChat({
		characterId: character.id,
		title: "Foreign branch owner chat",
		promptPresetId: null,
	});
});

describe("findBranchOfChat", () => {
	test("the chat's own branch → the branch", async () => {
		const branch = await findBranchOfChat(stores.chats, chat.id, chat.activeBranchId);
		expect(branch).not.toBeNull();
		expect(branch!.id).toBe(chat.activeBranchId);
		expect(branch!.chatId).toBe(chat.id);
	});

	test("another chat's branch → null (no cross-owner leak)", async () => {
		// The branch EXISTS — but under otherChat: not this chat's branch.
		expect(await findBranchOfChat(stores.chats, chat.id, otherChat.activeBranchId)).toBeNull();
	});

	test("a missing branch → null", async () => {
		expect(await findBranchOfChat(stores.chats, chat.id, "brnch_does_not_exist")).toBeNull();
	});

	test("a missing chat → null even for an existing branch", async () => {
		// The branch exists and belongs to ITS chat — just not to this chatId.
		expect(await findBranchOfChat(stores.chats, "chat_does_not_exist", chat.activeBranchId)).toBeNull();
	});
});

describe("requireChatBranch", () => {
	test("the chat's own pair → { chat, branch }", async () => {
		const { chat: foundChat, branch } = await requireChatBranch(stores.chats, chat.id, chat.activeBranchId);
		expect(foundChat.id).toBe(chat.id);
		expect(branch.id).toBe(chat.activeBranchId);
		expect(branch.chatId).toBe(chat.id);
	});

	test("a missing chat → 404 DomainError on Chat, byte-for-byte text", async () => {
		const err = await requireChatBranch(stores.chats, "chat_does_not_exist", chat.activeBranchId).then(
			() => new Error("expected a rejection"),
			(e) => e,
		);
		expect(isDomainError(err)).toBe(true);
		if (isDomainError(err)) {
			expect(err.kind).toBe("NotFound");
			expect(err.resource).toBe("Chat");
			expect(httpStatusForDomainError(err)).toBe(404);
			expect(err.message).toBe("Chat 'chat_does_not_exist' was not found.");
		}
	});

	test("a missing branch → 404 DomainError on ChatBranch, byte-for-byte text", async () => {
		const err = await requireChatBranch(stores.chats, chat.id, "brnch_does_not_exist").then(
			() => new Error("expected a rejection"),
			(e) => e,
		);
		expect(isDomainError(err)).toBe(true);
		if (isDomainError(err)) {
			expect(err.kind).toBe("NotFound");
			expect(err.resource).toBe("ChatBranch");
			expect(httpStatusForDomainError(err)).toBe(404);
			expect(err.message).toBe(
				`Branch 'brnch_does_not_exist' was not found for chat '${chat.id}'.`,
			);
		}
	});

	test("another chat's branch → 404 DomainError on ChatBranch (never a cross-owner leak)", async () => {
		const err = await requireChatBranch(stores.chats, chat.id, otherChat.activeBranchId).then(
			() => new Error("expected a rejection"),
			(e) => e,
		);
		expect(isDomainError(err)).toBe(true);
		if (isDomainError(err)) {
			expect(err.kind).toBe("NotFound");
			expect(err.resource).toBe("ChatBranch");
			expect(httpStatusForDomainError(err)).toBe(404);
			// The message names the REQUESTED chat, not the branch's real owner.
			expect(err.message).toBe(
				`Branch '${otherChat.activeBranchId}' was not found for chat '${chat.id}'.`,
			);
		}
	});
});
