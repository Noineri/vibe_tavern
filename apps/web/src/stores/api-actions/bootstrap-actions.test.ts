import { beforeEach, describe, expect, test } from "bun:test";
import type { ChatId } from "@vibe-tavern/domain";
import type { AppSnapshot } from "../../app-client.js";
import { useChatStore } from "../chat-store.js";
import { useSnapshotStore } from "../snapshot-store.js";
import { syncBootstrapSnapshotForActiveChat } from "./bootstrap-actions.js";

const chatId = (id: string) => id as ChatId;

function snapshot(id: string, personaName = "Persona"): AppSnapshot {
  const typedId = chatId(id);
  return {
    chats: [
      {
        id: typedId,
        title: `Chat ${id}`,
        characterId: "char-1",
        characterName: "Character",
        subtitle: "",
        activeBranchLabel: "main",
        messageCount: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    allCharacters: [],
    activeChat: {
      id: typedId,
      title: `Chat ${id}`,
      characterId: "char-1",
      personaId: "persona-1",
      promptPresetId: null,
      toolProfileId: null,
      activeBranchId: "branch-1",
      selectedGreetingIndex: 0,
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as unknown as AppSnapshot["activeChat"],
    activeBranch: {
      id: "branch-1",
      chatId: typedId,
      label: "main",
      rootMessageId: null,
      parentBranchId: null,
      forkedFromMessageId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as unknown as AppSnapshot["activeBranch"],
    branches: [],
    messages: [],
    summaries: [],
    promptTrace: null,
    promptTraceHistory: [],
    contextPreview: null,
    character: {
      id: "char-1",
      name: "Character",
      avatarExt: null,
      avatarFullExt: null,
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
      personalitySummary: null,
      avatarCropJson: null,
      includeGalleryInPrompt: false,
      includeAvatarInPrompt: false,
      avatarDescription: null,
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
    persona: {
      id: "persona-1",
      name: personaName,
      avatarExt: null,
      avatarFullExt: null,
      description: "",
      pronouns: null,
      avatarAssetId: null,
      avatarFullAssetId: null,
      avatarCropJson: null,
      includeAvatarInPrompt: false,
      avatarDescription: null,
    },
  };
}

beforeEach(() => {
  useSnapshotStore.getState().clear();
  useChatStore.getState().setActiveChatId(null);
});

describe("syncBootstrapSnapshotForActiveChat", () => {
  test("does not overwrite an active chat with bootstrap's initial chat", async () => {
    useChatStore.getState().setActiveChatId(chatId("active-chat"));
    useSnapshotStore.getState().ingestSnapshot(snapshot("active-chat", "Old persona"));

    const fetched: string[] = [];
    await syncBootstrapSnapshotForActiveChat(
      {
        initialChatId: chatId("initial-chat"),
        snapshot: snapshot("initial-chat", "Wrong persona"),
      },
      async (id) => {
        fetched.push(id);
        return snapshot(id, "Refreshed active persona");
      },
    );

    const state = useSnapshotStore.getState();
    expect(fetched).toEqual(["active-chat"]);
    expect(useChatStore.getState().activeChatId).toBe(chatId("active-chat"));
    expect(state.activeChat?.id).toBe(chatId("active-chat"));
    expect(state.persona?.name).toBe("Refreshed active persona");
  });

  test("keeps the existing active snapshot if active refresh returns a different chat", async () => {
    useChatStore.getState().setActiveChatId(chatId("active-chat"));
    useSnapshotStore.getState().ingestSnapshot(snapshot("active-chat", "Existing persona"));

    await syncBootstrapSnapshotForActiveChat(
      {
        initialChatId: chatId("initial-chat"),
        snapshot: snapshot("initial-chat", "Wrong persona"),
      },
      async () => snapshot("other-chat", "Other persona"),
    );

    const state = useSnapshotStore.getState();
    expect(state.activeChat?.id).toBe(chatId("active-chat"));
    expect(state.persona?.name).toBe("Existing persona");
  });

  test("keeps the existing active snapshot if active refresh fails", async () => {
    useChatStore.getState().setActiveChatId(chatId("active-chat"));
    useSnapshotStore.getState().ingestSnapshot(snapshot("active-chat", "Existing persona"));

    await syncBootstrapSnapshotForActiveChat(
      {
        initialChatId: chatId("initial-chat"),
        snapshot: snapshot("initial-chat", "Wrong persona"),
      },
      async () => {
        throw new Error("network failed");
      },
    );

    const state = useSnapshotStore.getState();
    expect(state.activeChat?.id).toBe(chatId("active-chat"));
    expect(state.persona?.name).toBe("Existing persona");
  });

  test("ingests bootstrap snapshot when no chat is active yet", async () => {
    await syncBootstrapSnapshotForActiveChat({
      initialChatId: chatId("initial-chat"),
      snapshot: snapshot("initial-chat", "Bootstrap persona"),
    });

    const state = useSnapshotStore.getState();
    expect(state.activeChat?.id).toBe(chatId("initial-chat"));
    expect(state.persona?.name).toBe("Bootstrap persona");
  });
});
