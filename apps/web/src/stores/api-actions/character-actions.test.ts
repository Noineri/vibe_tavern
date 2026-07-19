import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatId } from "@vibe-tavern/domain";
import type { AppSnapshot } from "../../app-client.js";
import { useChatStore } from "../chat-store.js";
import { useSnapshotStore } from "../snapshot-store.js";
import { createCharacterAction } from "./character-actions.js";

// Mock only `createCharacter` (the RPC); every other app-client export stays
// real (spread) so unrelated actions in this module are unaffected.
const { createCharacterMock } = vi.hoisted(() => ({
	createCharacterMock: vi.fn(),
}));
vi.mock("../../app-client.js", async (importOriginal) => {
	const actual = await importOriginal() as typeof import("../../app-client.js");
	return { ...actual, createCharacter: createCharacterMock };
});
// Stub the fire-and-forget bootstrap so it can't race the assertions.
vi.mock("./bootstrap-actions.js", async (importOriginal) => {
	const actual = await importOriginal() as typeof import("./bootstrap-actions.js");
	return { ...actual, fetchBootstrapAction: vi.fn().mockResolvedValue(undefined) };
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
