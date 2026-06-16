import { beforeEach, describe, expect, test } from "bun:test";
import type { ChatId, ChatBranchId } from "@vibe-tavern/domain";
import { useSnapshotStore } from "./snapshot-store.js";
import type { AppCharacter, AppMessage, AppSnapshot } from "../app-client.js";

// Branded-id cast helpers (match the convention in bootstrap-actions.test.ts).
const asChatId = (id: string): ChatId => id as ChatId;
const asBranchId = (id: string): ChatBranchId => id as ChatBranchId;

/**
 * Phase 3.4.1 — absence pipeline behavioural spec.
 *
 * ingestSnapshot must treat an ABSENT field as "preserve whatever the store
 * already holds" and a PRESENT field (including empty `[]` or `null`) as
 * "replace". This is what makes endpoint-scoped partial responses (Phase
 * 3.4.2) safe: a swipe response can omit `messages` without wiping the chat,
 * while a delete-message response can send `messages: []` to clear it.
 */

function makeCharacter(id: string, name = `Char ${id}`): AppCharacter {
  return {
    id,
    name,
    avatarExt: null,
    description: "",
    scenario: "",
    systemPrompt: "",
    subtitle: "",
    firstMessage: null,
    mesExample: null,
    mesExampleMode: "always",
    mesExampleDepth: 4,
    alternateGreetings: [],
    postHistoryInstructions: null,
    creatorNotes: null,
    depthPrompt: null,
    depthPromptDepth: null,
    depthPromptRole: null,
    tags: [],
    avatarAssetId: null,
    avatarFullAssetId: null,
    avatarCropJson: null,
    personalitySummary: null,
    includeGalleryInPrompt: false,
    includeAvatarInPrompt: false,
    avatarDescription: null,
  };
}

function makeMessage(id: string, content = `msg ${id}`): AppMessage {
  return {
    id,
    role: "assistant",
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    variants: [],
    selectedVariantIndex: null,
    modelId: null,
  } as unknown as AppMessage;
}

/** A full snapshot seeding the store with a known character + messages. */
function fullSeed(): AppSnapshot {
  return {
    chats: [{ id: "chat-1", title: "Chat 1", characterId: "c1", characterName: "Char c1", subtitle: "", activeBranchLabel: "main", messageCount: 2, updatedAt: "2026-01-01T00:00:00.000Z" }],
    allCharacters: [],
    activeChat: { id: "chat-1", title: "Chat 1", characterId: "c1" } as unknown as AppSnapshot["activeChat"],
    activeBranch: { id: "b1", chatId: "chat-1", label: "main" } as unknown as AppSnapshot["activeBranch"],
    branches: [],
    messages: [makeMessage("m1"), makeMessage("m2")],
    summaries: [],
    promptTrace: null,
    promptTraceHistory: [],
    contextPreview: null,
    character: makeCharacter("c1"),
    persona: null,
  } as unknown as AppSnapshot;
}

beforeEach(() => {
  useSnapshotStore.getState().clear();
});

describe("ingestSnapshot — absence pipeline (Phase 3.4.1)", () => {
  test("a partial { character } response preserves messages, chats, persona, etc.", () => {
    useSnapshotStore.getState().ingestSnapshot(fullSeed());
    const before = useSnapshotStore.getState();
    expect(before.messageOrder).toEqual(["m1", "m2"]);
    expect(before.character?.id).toBe("c1");
    expect(before.chatsById["chat-1"]?.title).toBe("Chat 1");

    // Endpoint returns only the character it mutated — nothing else.
    const partial = { character: makeCharacter("c1", "Updated name") } as AppSnapshot;
    useSnapshotStore.getState().ingestSnapshot(partial);

    const after = useSnapshotStore.getState();
    // character updated
    expect(after.character?.name).toBe("Updated name");
    // everything else preserved (the core TD-004 guarantee)
    expect(after.messageOrder).toEqual(["m1", "m2"]);
    expect(after.messagesById["m1"]?.content).toBe("msg m1");
    expect(after.chatsById["chat-1"]?.title).toBe("Chat 1");
    expect(after.activeChat?.id).toBe(asChatId("chat-1"));
    expect(after.activeBranch?.id).toBe(asBranchId("b1"));
  });

  test("a present `messages: []` REPLACES messages (clears the chat)", () => {
    useSnapshotStore.getState().ingestSnapshot(fullSeed());
    expect(useSnapshotStore.getState().messageOrder).toEqual(["m1", "m2"]);

    useSnapshotStore.getState().ingestSnapshot({ messages: [] } as AppSnapshot);

    const after = useSnapshotStore.getState();
    expect(after.messageOrder).toEqual([]);
    expect(after.messagesById).toEqual({});
    // absent fields preserved
    expect(after.character?.id).toBe("c1");
    expect(after.activeChat?.id).toBe(asChatId("chat-1"));
  });

  test("a response omitting `messages` preserves existing messages", () => {
    useSnapshotStore.getState().ingestSnapshot(fullSeed());
    const originalOrder = useSnapshotStore.getState().messageOrder;

    // Add a new message via a partial that includes messages — replace semantics
    useSnapshotStore.getState().ingestSnapshot({
      messages: [makeMessage("m1"), makeMessage("m2"), makeMessage("m3")],
    } as AppSnapshot);
    expect(useSnapshotStore.getState().messageOrder).toEqual(["m1", "m2", "m3"]);

    // A subsequent contextPreview-only response must NOT drop m3.
    useSnapshotStore.getState().ingestSnapshot({ contextPreview: null } as AppSnapshot);
    expect(useSnapshotStore.getState().messageOrder).toEqual(["m1", "m2", "m3"]);
    expect(originalOrder).toEqual(["m1", "m2"]);
  });

  test("clearMessages() wipes only messages, leaving character/chats intact", () => {
    useSnapshotStore.getState().ingestSnapshot(fullSeed());
    useSnapshotStore.getState().clearMessages();

    const after = useSnapshotStore.getState();
    expect(after.messageOrder).toEqual([]);
    expect(after.messagesById).toEqual({});
    expect(after.character?.id).toBe("c1");
    expect(after.chatsById["chat-1"]?.title).toBe("Chat 1");
  });
});
