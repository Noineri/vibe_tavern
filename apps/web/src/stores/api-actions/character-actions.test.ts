import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChatId } from "@vibe-tavern/domain";
import type { AppSnapshot } from "../../api/types.js";
import { useChatStore } from "../chat-store.js";
import { useSnapshotStore } from "../snapshot-store.js";

// Mock only `createCharacter` (the RPC); every other character-api export stays
// real (spread) so unrelated actions in this module are unaffected.
const createCharacterMock = mock();
const fetchBootstrapMock = mock(async () => undefined);
const importJsonMock = mock(async () => ({ } as unknown as Awaited<ReturnType<typeof import("../../api/import-api.js").importJson>>));
const invalidateActiveRegexPresetsSpy = mock();
const realCharacterApi = await import("../../api/character-api.js");
const realBootstrapActions = await import("./bootstrap-actions.js");
const realActiveRegexPresets = await import("../../hooks/use-active-regex-presets.js");
const realImportApi = await import("../../api/import-api.js");

mock.module("../../api/character-api.js", () => ({
	...realCharacterApi,
	createCharacter: createCharacterMock,
}));
// Stub the fire-and-forget bootstrap so it can't race the assertions.
mock.module("./bootstrap-actions.js", () => ({
	...realBootstrapActions,
	fetchBootstrapAction: fetchBootstrapMock,
}));
mock.module("../../api/import-api.js", () => ({
	...realImportApi,
	importJson: importJsonMock,
}));
mock.module("../../hooks/use-active-regex-presets.js", () => ({
	...realActiveRegexPresets,
	invalidateActiveRegexPresets: invalidateActiveRegexPresetsSpy,
}));

let createCharacterAction: typeof import("./character-actions.js").createCharacterAction;
let importCharacterAction: typeof import("./character-actions.js").importCharacterAction;
beforeAll(async () => {
	({ createCharacterAction, importCharacterAction } = await import("./character-actions.js"));
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
	fetchBootstrapMock.mockReset();
	fetchBootstrapMock.mockResolvedValue(undefined);
	importJsonMock.mockReset();
	importJsonMock.mockResolvedValue({ } as unknown as Awaited<ReturnType<typeof import("../../api/import-api.js").importJson>>);
	invalidateActiveRegexPresetsSpy.mockReset();
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

describe("importCharacterAction", () => {
	test("invalidates the chat-side resolved-regex cache after an import (embedded regex bundle lands without a page reload)", async () => {
		// Owner report 2026-10-09: importing a card with embedded regex_scripts
		// persisted the Profile bundle server-side, but the resolved-presets
		// module cache kept serving the pre-import union until a full reload.
		await importCharacterAction({ fileName: "card.json", jsonText: "{}", enableImportedRegexProfile: true });

		expect(importJsonMock).toHaveBeenCalledTimes(1);
		expect(importJsonMock).toHaveBeenCalledWith(expect.objectContaining({ enableImportedRegexProfile: true }));
		expect(fetchBootstrapMock).toHaveBeenCalledTimes(1);
		expect(invalidateActiveRegexPresetsSpy).toHaveBeenCalledTimes(1);
	});
});
