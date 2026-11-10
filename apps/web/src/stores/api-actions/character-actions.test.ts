import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { brandId } from "@vibe-tavern/domain";
import type { ChatId, CharacterId } from "@vibe-tavern/domain";
import type { ImportJsonResponse } from "../../api/types.js";
import { wireBranch, wireCharacter, wireChat, wireChatListItem } from "../../../test/wire-fixtures.js";
import { useChatStore } from "../chat-store.js";
import { useSnapshotStore } from "../snapshot-store.js";

const realCharacterApi = await import("../../api/character-api.js");
const realBootstrapActions = await import("./bootstrap-actions.js");
const realActiveRegexPresets = await import("../../hooks/use-active-regex-presets.js");
const realImportApi = await import("../../api/import-api.js");

/** Complete lean-path `ImportJsonResponse` (ImportResult): `snapshot` omitted
 *  and `characterId` absent — the shape the lean mass-import path returns, and
 *  exactly what the erased `{}` mock pretended to be without carrying. */
function importResult(): ImportJsonResponse {
	return {
		activeChatId: brandId<ChatId>("chat-imported"),
		imported: { kind: "character", name: "Imported", fileName: "card.json", warningCount: 0, warnings: [] },
	};
}

// Mock only `createCharacter` (the RPC); every other character-api export stays
// real (spread) so unrelated actions in this module are unaffected. Each mock
// wraps the REAL function so stubbed bodies are checked against the real wire
// signature (the 7f PromptManagerModal idiom).
const createCharacterMock = mock(realCharacterApi.createCharacter);
const fetchBootstrapMock = mock(realBootstrapActions.fetchBootstrapAction);
const importJsonMock = mock(realImportApi.importJson);
const invalidateActiveRegexPresetsSpy = mock(realActiveRegexPresets.invalidateActiveRegexPresets);

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
/**
 * Minimal snapshot for the NEW chat — mirrors the backend `createFromScratch`
 * return shape (`snapshot = getSnapshot(createdChatId)`), so the snapshot's
 * activeChat IS the new chat. Typed against the RPC response (no annotation,
 * so the mock's wire type checks every member); `ingestSnapshot`'s
 * absence-pipeline only writes fields that are present, and the fresh-scrape
 * empties match the just-cleared store, so the completions are inert.
 */
function newChatSnapshot(newChatId: string) {
	const id = chatId(newChatId);
	const newCharacterId = brandId<CharacterId>("char-new");
	return {
		chats: [wireChatListItem({ id, title: "New Chat", characterId: newCharacterId, characterName: "New" })],
		allCharacters: [],
		activeChat: wireChat({ id, title: "New Chat", characterId: newCharacterId }),
		activeBranch: wireBranch(),
		branches: [],
		messages: [],
		summaries: [],
		promptTrace: null,
		character: wireCharacter({ id: "char-new", name: "New" }),
		persona: null,
	};
}

beforeEach(() => {
	createCharacterMock.mockReset();
	fetchBootstrapMock.mockReset();
	fetchBootstrapMock.mockResolvedValue(undefined);
	importJsonMock.mockReset();
	importJsonMock.mockResolvedValue(importResult());
	invalidateActiveRegexPresetsSpy.mockReset();
	useSnapshotStore.getState().clear();
	useChatStore.getState().setActiveChatId(null);
});

describe("createCharacterAction", () => {
	test("activates the new character's initial chat after creation", async () => {
		// Prior state: the user is on a different chat.
		useChatStore.getState().setActiveChatId(chatId("prior-chat"));

		createCharacterMock.mockResolvedValue({
			...importResult(),
			activeChatId: chatId("new-chat"),
			snapshot: newChatSnapshot("new-chat"),
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
