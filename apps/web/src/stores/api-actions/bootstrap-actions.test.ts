import { beforeEach, describe, expect, test } from "bun:test";
import type { ChatId, CharacterId } from "@vibe-tavern/domain";
import type { AppSnapshot } from "../../app-client.js";
import { useChatStore } from "../chat-store.js";
import { useSnapshotStore } from "../snapshot-store.js";
import { syncBootstrapSnapshotForActiveChat, patchUiSettingsAction, useBootstrapStore } from "./bootstrap-actions.js";
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
  useBootstrapStore.setState({ data: null });
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

describe("patchUiSettingsAction", () => {
  const baseSettings = {
    id: "default",
    theme: "dark",
    chatFontSize: 15,
    uiFontSize: 14,
    messageWidth: 700,
    language: "en",
    activePromptPresetId: null,
    aiAssistantProviderId: null,
    aiAssistantModelName: null,
    coauthorProviderId: null,
    coauthorModelName: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  test("merges a coauthor binding patch into the live bootstrap store", async () => {
    useBootstrapStore.setState({
      data: {
        initialChatId: null,
        snapshot: null,
        isFirstRun: false,
        allCharacters: [],
        promptPresets: [],
        uiSettings: { ...baseSettings },
        isArmServer: false,
      },
    });

    const result = await patchUiSettingsAction(
      { coauthorProviderId: "prov_1", coauthorModelName: "m" },
      async (input) => ({ ...baseSettings, ...input, updatedAt: "2026-02-02" }),
    );

    expect(result.coauthorProviderId).toBe("prov_1");
    const live = useBootstrapStore.getState().data!.uiSettings;
    expect(live.coauthorProviderId).toBe("prov_1");
    expect(live.coauthorModelName).toBe("m");
    expect(live.updatedAt).toBe("2026-02-02");
  });

  test("explicit null clears a coauthor field in the live store", async () => {
    useBootstrapStore.setState({
      data: {
        initialChatId: null,
        snapshot: null,
        isFirstRun: false,
        allCharacters: [],
        promptPresets: [],
        uiSettings: { ...baseSettings, coauthorProviderId: "prov_1", coauthorModelName: "m" },
        isArmServer: false,
      },
    });

    await patchUiSettingsAction(
      { coauthorProviderId: null, coauthorModelName: null },
      async (input) => ({ ...baseSettings, ...input }),
    );

    const live = useBootstrapStore.getState().data!.uiSettings;
    expect(live.coauthorProviderId).toBeNull();
    expect(live.coauthorModelName).toBeNull();
  });

  test("preserves snapshot and other bootstrap payload fields", async () => {
    const snap = snapshot("initial-chat", "Preserved");
    useBootstrapStore.setState({
      data: {
        initialChatId: chatId("initial-chat"),
        snapshot: snap,
        isFirstRun: false,
        allCharacters: [{ id: "char-1", name: "Char", subtitle: "", tags: [], avatarAssetId: null, avatarFullAssetId: null, avatarCropJson: null, avatarExt: null, avatarFullExt: null, updatedAt: "" }],
        promptPresets: [],
        uiSettings: { ...baseSettings },
        isArmServer: false,
      },
    });

    await patchUiSettingsAction(
      { coauthorProviderId: "prov_2" },
      async (input) => ({ ...baseSettings, ...input }),
    );

    const data = useBootstrapStore.getState().data!;
    // Snapshot and character list survive the settings patch.
    expect(data.snapshot).toBe(snap);
    expect(data.allCharacters).toHaveLength(1);
    expect(data.uiSettings.coauthorProviderId).toBe("prov_2");
  });
});
