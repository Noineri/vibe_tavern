import { beforeEach, describe, expect, test } from "bun:test";
import type { ChatId, CharacterId } from "@vibe-tavern/domain";
import type { AppSnapshot } from "../../app-client.js";
import { useChatStore } from "../chat-store.js";
import { useSnapshotStore } from "../snapshot-store.js";
import { syncBootstrapSnapshotForActiveChat, reconcileNavModeFromChat } from "./bootstrap-actions.js";
import { useNavigationStore } from "../navigation-store.js";

const chatId = (id: string) => id as ChatId;
const characterId = (id: string) => id as CharacterId;

function snapshot(id: string, personaName = "Persona"): AppSnapshot {
  const typedId = chatId(id);
  return {
    chats: [
      {
        id: typedId,
        title: `Chat ${id}`,
        characterId: characterId("char-1"),
        characterName: "Character",
        subtitle: "",
        activeBranchLabel: "main",
        mode: "rp",
        messageCount: 0,
        lastMessageAt: "2026-01-01T00:00:00.000Z",
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
      pronounForms: null,
      avatarAssetId: null,
      avatarFullAssetId: null,
      avatarCropJson: null,
      defaultForNewChats: false,
      includeAvatarInPrompt: false,
      avatarDescription: null,
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
  };
}

beforeEach(() => {
  useSnapshotStore.getState().clear();
  useChatStore.getState().setActiveChatId(null);
  useNavigationStore.getState().setMode("play");
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

describe("reconcileNavModeFromChat", () => {
  test("a co-author chat sets nav mode to 'coauthor'", () => {
    useNavigationStore.getState().setMode("play");
    reconcileNavModeFromChat({ mode: "coauthor" });
    expect(useNavigationStore.getState().mode).toBe("coauthor");
  });

  test("a co-author chat flips nav mode from build to coauthor too", () => {
    useNavigationStore.getState().setMode("build");
    reconcileNavModeFromChat({ mode: "coauthor" });
    expect(useNavigationStore.getState().mode).toBe("coauthor");
  });

  test("an RP chat entered from coauthor exits back to 'play'", () => {
    useNavigationStore.getState().setMode("coauthor");
    reconcileNavModeFromChat({ mode: "rp" });
    expect(useNavigationStore.getState().mode).toBe("play");
  });

  test("an RP chat does not clobber a deliberate 'build' view", () => {
    useNavigationStore.getState().setMode("build");
    reconcileNavModeFromChat({ mode: "rp" });
    expect(useNavigationStore.getState().mode).toBe("build");
  });

  test("a co-author chat with idempotent re-reconcile stays coauthor", () => {
    useNavigationStore.getState().setMode("coauthor");
    reconcileNavModeFromChat({ mode: "coauthor" });
    expect(useNavigationStore.getState().mode).toBe("coauthor");
  });

  test("no active chat (undefined) exits coauthor to play, leaves play/build untouched", () => {
    useNavigationStore.getState().setMode("coauthor");
    reconcileNavModeFromChat(undefined);
    expect(useNavigationStore.getState().mode).toBe("play");

    useNavigationStore.getState().setMode("play");
    reconcileNavModeFromChat(undefined);
    expect(useNavigationStore.getState().mode).toBe("play");

    useNavigationStore.getState().setMode("build");
    reconcileNavModeFromChat(undefined);
    expect(useNavigationStore.getState().mode).toBe("build");
  });

  test("an active chat whose mode is absent (RP) exits coauthor to play", () => {
    useNavigationStore.getState().setMode("coauthor");
    reconcileNavModeFromChat({ mode: undefined });
    expect(useNavigationStore.getState().mode).toBe("play");
  });
});
