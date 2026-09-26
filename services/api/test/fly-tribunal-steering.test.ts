import { describe, expect, it } from "bun:test";
import type { StoreContainer } from "@vibe-tavern/db";
import { EventBus, type ChatId, type MessageId, type PromptPresetId, type StoredProviderProfileRecord } from "@vibe-tavern/domain";
import type { ChatRuntime } from "../src/runtime/session/session-runtime-chat.js";
import type { ChatModeStrategy } from "../src/domain/chat/chat-mode-strategy.js";
import type { ProviderOrchestrator } from "../src/domain/providers/provider-orchestrator.js";
import type { ChatApplicationService } from "../src/domain/chat/chat-application-service.js";
import { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";
import { PromptAssemblyService, type PromptAssemblyResolver } from "../src/domain/prompt/prompt-assembly-service.js";

/**
 * Fly Tribunal steering-note prompt boundary (FLY_TRIBUNAL_PLAN FT-5).
 *
 * Characterization comes FIRST: this file initially pins the unchanged
 * regenerate-with-model/preset-override prompt before steering is threaded.
 * Later cases extend that exact boundary with a one-shot note.
 *
 * L1 checklist:
 * 1. Paths: no fixture or machine paths; the file-store double has no I/O.
 * 2. Restores: no process-global state, registries, fetch, or environment changes.
 * 3. Determinism: every assertion awaits completed pure assembly; no sleeps.
 * 4. Platform: no OS-specific paths or ordering assumptions.
 * 5. Shared worker pool: no module mocks or shared mutable registries.
 * 6. Stable state: assertions read the completed assembled prompt.
 */

const CHAT_ID = "chat_steering" as ChatId;
const USER_MESSAGE_ID = "msg_user" as MessageId;
const REGENERATED_MESSAGE_ID = "msg_target" as MessageId;
const PRESET_OVERRIDE_ID = "preset_override" as PromptPresetId;
const STEERING_NOTE = "TRIBUNAL_STEERING_NOTE";
const LEGACY_REGENERATE_PAYLOAD_JSON = "{\"messages\":[{\"role\":\"system\",\"content\":\"Character: TestBot\",\"layerId\":\"character_base\"},{\"role\":\"user\",\"content\":\"USER_TURN\",\"messageId\":\"msg_user\"}]}";

function makeService(): { service: PromptAssemblyService; presetCalls: string[] } {
  const presetCalls: string[] = [];
  const stores = {
    chats: {
      getById: async () => ({
        id: CHAT_ID,
        characterId: "char_1",
        personaId: null,
        promptPresetId: "preset_chat",
        activeBranchId: "branch_1",
        title: "Steering test",
        summary: null,
        messageHistoryLimit: 0,
        insightsConfig: {},
        insightsObjectiveState: {},
        createdAt: "2026-09-27T00:00:00.000Z",
        updatedAt: "2026-09-27T00:00:00.000Z",
      }),
      getBranches: async () => [{ id: "branch_1", chatId: CHAT_ID, parentBranchId: null, label: "main" }],
    },
    messages: {
      getMessages: async () => [
        {
          id: USER_MESSAGE_ID,
          role: "user",
          content: "USER_TURN",
          branchId: "branch_1",
          position: 0,
          authorType: "user",
          state: "complete",
          createdAt: "2026-09-27T00:00:00.000Z",
          updatedAt: "2026-09-27T00:00:00.000Z",
        },
        {
          id: REGENERATED_MESSAGE_ID,
          role: "assistant",
          content: "TARGET_REPLY",
          branchId: "branch_1",
          position: 1,
          authorType: "character",
          state: "complete",
          createdAt: "2026-09-27T00:00:01.000Z",
          updatedAt: "2026-09-27T00:00:01.000Z",
        },
      ],
    },
    personas: { listAll: async () => [] },
    presets: { listAll: async () => [] },
    chatSummaries: { listByChatBranch: async () => [] },
    characterAssets: { listByCharacter: async () => [] },
    diceRolls: { getRollsForMessages: async () => new Map() },
    experiences: { getAttachmentsForMessages: async () => new Map() },
  } as unknown as StoreContainer;
  const resolver: PromptAssemblyResolver = {
    getCharacter: async () => ({
      id: "char_1",
      name: "TestBot",
      description: "",
      scenario: null,
      systemPrompt: null,
      personality: null,
      mesExample: null,
      postHistoryInstructions: null,
    }),
    getPersona: async () => null,
    getPromptPreset: async (presetId: string) => {
      presetCalls.push(presetId);
      return {
        id: presetId,
        name: "Blank override",
        text: "",
        jailbreak: "",
        summary: "",
        tools: "",
        prefill: "",
        authorsNote: "",
        authorsNoteDepth: 4,
        authorsNotePosition: "in_chat",
        authorsNoteRole: "system",
        nsfw: "",
        enhanceDefinitions: "",
        advancedMode: false,
        customInjections: [],
        promptOrder: [],
      };
    },
    listActiveLoreEntries: async () => [],
    listRetrievedMemories: async () => [],
    executeScripts: async (input) => ({
      personality: input.characterRecord.personality ?? "",
      scenario: input.characterRecord.scenario ?? "",
      injectedMessages: [],
      errors: [],
      scriptRuns: [],
    }),
    getToolInstructions: () => null,
  };
  const fileStore = {
    dataRoot: import.meta.dir,
    resolvePath: (_folder: string, relativePath: string) => relativePath,
    readJson: async <T>() => null as T,
    writeJson: async () => {},
    asyncWriteJson: async () => {},
  };
  return { service: new PromptAssemblyService(stores, resolver, fileStore), presetCalls };
}

function regenerateWithOverride(service: PromptAssemblyService, steeringNote?: string) {
  return service.assembleForChat({
    chatId: CHAT_ID,
    model: "model_override",
    presetId: PRESET_OVERRIDE_ID,
    excludeMessageIds: [REGENERATED_MESSAGE_ID],
    steeringNote,
  });
}

function makeRegenerateForwardingHarness() {
  const reachedAssembly = new Error("assembly reached");
  const seen: Array<{ excludeMessageId?: MessageId; steeringNote?: string }> = [];
  const profile: StoredProviderProfileRecord = {
    id: "profile_1",
    name: "Test profile",
    providerPreset: "openai",
    coauthorTransport: "chatCompletions",
    generationMode: "chat",
    endpoint: "http://example.invalid",
    apiKey: null,
    defaultModel: "model_override",
    contextBudget: 16000,
    pinContextBudget: false,
    tokenPadding: 0,
    bindPerModel: false,
    modelFreeOnly: false,
    modelGroupByOwner: false,
    maxTokens: 512,
    stopSequences: [],
    bannedStrings: [],
    logitBias: [],
    seed: null,
    showReasoning: false,
    streamResponse: true,
    customSamplers: false,
    proxyMode: "inherit",
    proxyId: null,
  };
  const chatRuntime = {
    async assemblePromptPreview(
      _chatId: ChatId,
      options: { excludeMessageId?: MessageId; steeringNote?: string },
    ) {
      seen.push(options);
      throw reachedAssembly;
    },
  } as unknown as ChatRuntime;
  const strategy: ChatModeStrategy = {
    mode: "rp",
    resolveProvider: async () => ({ profile, model: profile.defaultModel }),
    assemble: async () => {
      throw new Error("strategy assembly must not run");
    },
    onMessageAppended: async () => {},
  };
  const orchestrator = new LiveChatOrchestrator(
    chatRuntime,
    null as unknown as ChatApplicationService,
    null as unknown as ProviderOrchestrator,
    new EventBus(),
    async () => strategy,
  );
  return { orchestrator, reachedAssembly, seen, profile };
}

describe("Fly Tribunal steering note", () => {
  it("characterizes the unchanged legacy regenerate prompt with model/preset override", async () => {
    const { service, presetCalls } = makeService();

    const result = await regenerateWithOverride(service);

    expect(presetCalls).toEqual([PRESET_OVERRIDE_ID]);
    expect(result.prompt.finalPayload).toEqual({
      messages: [
        { role: "system", content: "Character: TestBot", layerId: "character_base" },
        { role: "user", content: "USER_TURN", messageId: USER_MESSAGE_ID },
      ],
    });
    expect(JSON.stringify(result.prompt.finalPayload)).toBe(LEGACY_REGENERATE_PAYLOAD_JSON);
  });

  it("appends the note exactly once to the latest user message, not a separate layer", async () => {
    const { service } = makeService();

    const result = await regenerateWithOverride(service, STEERING_NOTE);
    const messages = (result.prompt.finalPayload as {
      messages: Array<{ role: string; content: string; messageId?: string }>;
    }).messages;
    const userMessages = messages.filter((message) => message.role === "user");

    expect(userMessages).toEqual([
      {
        role: "user",
        content: `USER_TURN\n\n${STEERING_NOTE}`,
        messageId: USER_MESSAGE_ID,
      },
    ]);
    expect(JSON.stringify(result.prompt.finalPayload).split(STEERING_NOTE)).toHaveLength(2);
    const legacy = await regenerateWithOverride(service);
    // The note changes the existing history layer's text, never adds a new
    // steering-specific layer (prompt traces honestly retain the final prompt).
    expect(result.prompt.layers.map((layer) => layer.id)).toEqual(legacy.prompt.layers.map((layer) => layer.id));
    expect(result.prompt.layers.some((layer) => layer.id.includes("steering"))).toBe(false);
    expect(result.promptTraceDraft.finalPayload).toEqual(result.prompt.finalPayload);
  });

  it("an absent note remains byte-identical to the characterized legacy prompt", async () => {
    const { service } = makeService();

    const result = await regenerateWithOverride(service);

    expect(JSON.stringify(result.prompt.finalPayload)).toBe(LEGACY_REGENERATE_PAYLOAD_JSON);
  });

  it("forwards the note through both regenerate paths before prompt assembly", async () => {
    const { orchestrator, reachedAssembly, seen, profile } = makeRegenerateForwardingHarness();
    const input = {
      chatId: CHAT_ID,
      messageId: REGENERATED_MESSAGE_ID,
      profile,
      model: profile.defaultModel,
      steeringNote: STEERING_NOTE,
    };

    await expect(orchestrator.regenerateMessage(input)).rejects.toBe(reachedAssembly);
    await expect(orchestrator.regenerateMessageStream(input).next()).rejects.toBe(reachedAssembly);

    expect(seen).toEqual([
      {
        excludeMessageId: REGENERATED_MESSAGE_ID,
        model: profile.defaultModel,
        contextBudget: profile.contextBudget,
        responseReserve: profile.maxTokens,
        presetId: undefined,
        steeringNote: STEERING_NOTE,
      },
      {
        excludeMessageId: REGENERATED_MESSAGE_ID,
        model: profile.defaultModel,
        contextBudget: profile.contextBudget,
        responseReserve: profile.maxTokens,
        presetId: undefined,
        steeringNote: STEERING_NOTE,
      },
    ]);
  });
});
