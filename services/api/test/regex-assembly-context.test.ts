/**
 * RX-13 server seam: PromptAssemblyService hands the chat's ACTIVE regex
 * presets into the pipeline context (PromptAssemblyContext.regexPresets).
 *
 * Pins:
 *   - the FULL active set (all apply-targets) enters the context — mode
 *     filtering is the pipeline's authoritative gate (applyRegexToChatHistory);
 *   - resolution failures degrade to "no presets" and NEVER break assembly;
 *   - the resolver receives the chat's characterId and effective presetId.
 */
import { describe, it, expect } from "bun:test";
import { PromptAssemblyService, type PromptAssemblyResolver } from "../src/domain/prompt/prompt-assembly-service.js";
import type { StoreContainer } from "@vibe-tavern/db";
import type { ChatId, RegexPreset } from "@vibe-tavern/domain";

function makePreset(id: string, overrides: Partial<RegexPreset> = {}): RegexPreset {
  return {
    id: id as RegexPreset["id"],
    name: id,
    findRegex: "/secret/g",
    replaceString: "[redacted]",
    trimStrings: [],
    substituteRegex: 0,
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
    minDepth: null,
    maxDepth: null,
    placement: [2],
    isGlobal: false,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function createStores(regexStore: StoreContainer["regex"]): StoreContainer {
  return {
    chats: {
      getById: async () => ({
        id: "chat_1",
        characterId: "char_1",
        personaId: "persona_1",
        promptPresetId: "preset_1",
        activeBranchId: "branch_1",
        title: "Test Chat",
        summary: null,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      }),
      getBranches: async () => [
        { id: "branch_1", chatId: "chat_1", parentBranchId: null, label: "main" },
      ],
      getMessages: async () => [
        { id: "msg_1", role: "user", content: "Hello!", branchId: "branch_1" },
        { id: "msg_2", role: "assistant", content: "Hi secret bot!", branchId: "branch_1" },
      ],
    },
    personas: {
      listAll: async () => [{ id: "persona_1", name: "User", description: "A user.", defaultForNewChats: true }],
    },
    messages: {
      getMessages: async () => [
        { id: "msg_1", role: "user", content: "Hello!", branchId: "branch_1" },
        { id: "msg_2", role: "assistant", content: "Hi secret bot!", branchId: "branch_1" },
      ],
    },
    chatSummaries: { listByChatBranch: async () => [] },
    characterAssets: {
      listByCharacter: async () => [],
      listGalleryByCharacter: async () => [],
    },
    diceRolls: { getRollsForMessages: async () => new Map() },
    experiences: { getAttachmentsForMessages: async () => new Map() },
    regex: regexStore,
  } as unknown as StoreContainer;
}

const mockResolver: PromptAssemblyResolver = {
  getCharacter: async () => ({
    id: "char_1",
    name: "TestBot",
    description: "A test character.",
    scenario: "A test scenario.",
    systemPrompt: "You are TestBot.",
    personality: "Friendly.",
    mesExample: null,
    postHistoryInstructions: null,
  }),
  getPersona: async () => ({ id: "persona_1", name: "User", description: "A regular user." }),
  getPromptPreset: async () => ({
    id: "preset_1",
    name: "Default",
    text: "Write {{char}}'s next reply.",
    jailbreak: "",
    summary: "",
    tools: "",
    prefill: "",
    authorsNote: "",
    authorsNoteDepth: 4,
  }),
  listActiveLoreEntries: async () => [],
  listRetrievedMemories: async () => [],
  getToolInstructions: () => null,
  executeScripts: async () => ({
    personality: "",
    scenario: "",
    injectedMessages: [],
    errors: [],
    scriptRuns: [],
  }),
};

const mockFileStore = {
  dataRoot: "/mock",
  resolvePath: (_folder: string, relativePath: string) => `/mock/${relativePath}`,
  readJson: async <T>() => null as T,
  writeJson: async () => {},
  asyncWriteJson: async () => {},
};

describe("PromptAssemblyService — RX-13 regexPresets context seam", () => {
  it("passes the FULL active preset set into the pipeline context", async () => {
    const full = [
      makePreset("rx_persist"),
      makePreset("rx_display", { markdownOnly: true }),
      makePreset("rx_prompt", { promptOnly: true }),
    ];
    let received: { characterId?: string; presetId?: string | null } | null = null;
    const stores = createStores({
      resolveActiveRegexPresets: async (q) => {
        received = { ...q };
        return full;
      },
    } as unknown as StoreContainer["regex"]);
    const service = new PromptAssemblyService(stores, mockResolver, mockFileStore);

    const built = await service.buildPipelineContext({
      chatId: "chat_1" as ChatId,
      model: "test-model",
    });

    expect(received).toEqual({ characterId: "char_1", presetId: "preset_1" });
    expect(built.context.regexPresets).toEqual(full);
  });

  it("prompt-only history actually transforms inside the assembled prompt (end-to-end pin)", async () => {
    const stores = createStores({
      resolveActiveRegexPresets: async () => [makePreset("rx_prompt", { promptOnly: true, placement: [2] })],
    } as unknown as StoreContainer["regex"]);
    const service = new PromptAssemblyService(stores, mockResolver, mockFileStore);

    const result = await service.assembleForChat({
      chatId: "chat_1" as ChatId,
      model: "test-model",
    });

    const messages = result.prompt.finalPayload.messages as Array<{ role: string; content: string }>;
    const assistantMsg = [...messages].reverse().find((m) => m.role === "assistant");
    expect(assistantMsg?.content).toContain("[redacted]");
    expect(assistantMsg?.content).not.toContain("secret");
  });

  it("resolution failure degrades to no presets without breaking assembly", async () => {
    const stores = createStores({
      resolveActiveRegexPresets: async () => {
        throw new Error("regex store exploded");
      },
    } as unknown as StoreContainer["regex"]);
    const service = new PromptAssemblyService(stores, mockResolver, mockFileStore);

    const built = await service.buildPipelineContext({
      chatId: "chat_1" as ChatId,
      model: "test-model",
    });

    expect(built.context.regexPresets).toEqual([]);
    const assistantMsg = built.context.chat.recentMessages.find((m) => m.role === "assistant");
    expect(assistantMsg?.content).toContain("secret"); // untouched
  });
});
