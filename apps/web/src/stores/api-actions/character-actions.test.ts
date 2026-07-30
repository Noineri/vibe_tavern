import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChatId } from "@vibe-tavern/domain";
import type { AppSnapshot } from "../../app-client.js";
import { useChatStore } from "../chat-store.js";
import { useSnapshotStore } from "../snapshot-store.js";

// Mock only `createCharacter` (the RPC); every other app-client export stays
// real (spread) so unrelated actions in this module are unaffected.
const createCharacterMock = mock();
const fetchBootstrapMock = mock(async () => undefined);
const realAppClient = await import("../../app-client.js");
const realBootstrapActions = await import("./bootstrap-actions.js");

mock.module("../../app-client.js", () => ({
	...realAppClient,
	createCharacter: createCharacterMock,
}));
// Stub the fire-and-forget bootstrap so it can't race the assertions.
mock.module("./bootstrap-actions.js", () => ({
	...realBootstrapActions,
	fetchBootstrapAction: fetchBootstrapMock,
}));

let createCharacterAction: typeof import("./character-actions.js").createCharacterAction;
beforeAll(async () => {
	({ createCharacterAction } = await import("./character-actions.js"));
});

const chatId = (id: string) => id as ChatId;

/**
 * Minimal snapshot for the NEW chat — mirrors the backend `createFromScratch`
 * return shape (`snapshot = getSnapshot(createdChatId)`), so the snapshot's
 * activeChat IS the new chat. `ingestSnapshot`'s absence-pipeline only writes
 * fields that are present, so this partial shape is safe.
 */
function newChatSnapshot(newChatId: string): AppSnapshot {
	const id = chatId(newChatId);
	return {
		chats: [
			{
				id,
				title: "New Chat",
				characterId: "char-new",
				characterName: "New",
				subtitle: "",
				activeBranchLabel: "main",
				mode: "rp",
				messageCount: 0,
				lastMessageAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
		activeChat: { id, characterId: "char-new" } as unknown as AppSnapshot["activeChat"],
		character: { id: "char-new", name: "New" } as unknown as AppSnapshot["character"],
	} as unknown as AppSnapshot;
}

beforeEach(() => {
	createCharacterMock.mockReset();
	useSnapshotStore.getState().clear();
	useChatStore.getState().setActiveChatId(null);
});

describe("createCharacterAction", () => {
	test("activates the new character's initial chat after creation", async () => {
		// Prior state: the user is on a different chat.
		useChatStore.getState().setActiveChatId(chatId("prior-chat"));

		createCharacterMock.mockResolvedValue({
			snapshot: newChatSnapshot("new-chat"),
			activeChatId: "new-chat",
		});

		await createCharacterAction({ name: "New" });

		// The new character's initial chat is now the active chat ...
		expect(useChatStore.getState().activeChatId).toBe(chatId("new-chat"));
		// ... and the authoritative create-response snapshot was ingested
		// (its activeChat is the new chat).
		expect(useSnapshotStore.getState().activeChat?.id).toBe(chatId("new-chat"));
	});

	test("does not activate a chat when creation throws", async () => {
		useChatStore.getState().setActiveChatId(chatId("prior-chat"));
		createCharacterMock.mockRejectedValue(new Error("boom"));

		await expect(createCharacterAction({ name: "X" })).rejects.toThrow("boom");

		// No swap — the user stays on the prior chat.
		expect(useChatStore.getState().activeChatId).toBe(chatId("prior-chat"));
	});
});
