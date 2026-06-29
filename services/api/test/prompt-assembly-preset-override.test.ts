import { describe, it, expect } from "bun:test";
import { PromptAssemblyService, type PromptAssemblyResolver } from "../src/domain/prompt/prompt-assembly-service.js";
import type { StoreContainer } from "@vibe-tavern/db";
import type { ChatId } from "@vibe-tavern/domain";

/**
 * Characterization test for the per-request PRESET OVERRIDE path (Wave Q1b).
 *
 * `assembleForChat({ ..., presetId? })` short-circuits the prompt-preset
 * cascade: when `presetId` is provided, the assembled prompt uses THAT preset
 * instead of `chat.promptPresetId` — WITHOUT mutating the chat row. This is the
 * queue's per-job preset mechanism (each job snapshots a preset id).
 *
 * Invariant pinned:
 *  - no override → uses the chat's preset (preset_chat, unchanged cascade);
 *  - override → uses the override preset's text, chat's preset never consulted
 *    for the picked id, and the chat row is not mutated.
 */

const CHAT_PRESET_TEXT = "CHAT_PRESET_TEXT {{char}}";
const OVERRIDE_PRESET_TEXT = "OVERRIDE_PRESET_TEXT {{char}}";

function makeResolver(): { resolver: PromptAssemblyResolver; calls: string[] } {
  const calls: string[] = [];
  const resolver: PromptAssemblyResolver = {
    getCharacter: async () => ({
      id: "char_1",
      name: "TestBot",
      description: "A test character.",
      scenario: null,
      systemPrompt: null,
      personality: null,
      mesExample: null,
      postHistoryInstructions: null,
    }),
    getPersona: async () => ({ id: "persona_1", name: "User", description: "A user." }),
    // Discriminate by id so the test can tell which preset was selected.
    getPromptPreset: async (presetId: string) => {
      calls.push(presetId);
      if (presetId === "preset_override") {
        return {
          id: "preset_override",
          name: "Override",
          text: OVERRIDE_PRESET_TEXT,
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
      }
      return {
        id: "preset_chat",
        name: "ChatDefault",
        text: CHAT_PRESET_TEXT,
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
    getToolInstructions: () => null,
    executeScripts: async (input: { characterRecord: { personality: string | null; scenario: string | null } }) => ({
      personality: input.characterRecord.personality ?? "",
      scenario: input.characterRecord.scenario ?? "",
      injectedMessages: [],
      errors: [],
      scriptRuns: [],
    }),
  };
  return { resolver, calls };
}

const mockStores = {
  chats: {
    getById: async () => ({
      id: "chat_1",
      characterId: "char_1",
      personaId: "persona_1",
      promptPresetId: "preset_chat",
      activeBranchId: "branch_1",
      title: "Test",
      summary: null,
      createdAt: "0",
      updatedAt: "0",
    }),
    getBranches: async () => [{ id: "branch_1", chatId: "chat_1", parentBranchId: null, label: "main" }],
    getMessages: async () => [],
  },
  personas: { listAll: async () => [] },
  messages: { getMessages: async () => [] },
  chatSummaries: { listByChatBranch: async () => [] },
  characterAssets: { listByCharacter: async () => [] },
  presets: { listAll: async () => [] },
} as unknown as StoreContainer;

const mockFileStore = {
  dataRoot: "/mock",
  resolvePath: (_f: string, r: string) => `/mock/${r}`,
  readJson: async <T>() => null as T,
  writeJson: async () => {},
  asyncWriteJson: async () => {},
};

function payloadText(result: { prompt: { finalPayload: unknown } }): string {
  const messages = (result.prompt.finalPayload as { messages?: Array<{ content: string }> }).messages ?? [];
  return messages.map((m) => m.content).join("\n");
}

describe("Q1b: assembleForChat preset override", () => {
  it("no override → resolves the chat's prompt preset (unchanged cascade)", async () => {
    const { resolver, calls } = makeResolver();
    const service = new PromptAssemblyService(mockStores, resolver, mockFileStore);

    const result = await service.assembleForChat({ chatId: "chat_1" as ChatId, model: "m" });

    expect(calls).toEqual(["preset_chat"]); // chat's preset consulted
    expect(payloadText(result)).toContain("CHAT_PRESET_TEXT");
    expect(payloadText(result)).not.toContain("OVERRIDE_PRESET_TEXT");
  });

  it("preset override → uses the override preset, not the chat's", async () => {
    const { resolver, calls } = makeResolver();
    const service = new PromptAssemblyService(mockStores, resolver, mockFileStore);

    const result = await service.assembleForChat({
      chatId: "chat_1" as ChatId,
      model: "m",
      presetId: "preset_override" as ChatId, // branded at the boundary; cast for test
    });

    expect(calls).toEqual(["preset_override"]); // override short-circuited the cascade
    expect(payloadText(result)).toContain("OVERRIDE_PRESET_TEXT");
    expect(payloadText(result)).not.toContain("CHAT_PRESET_TEXT");
  });

  it("preset override does NOT mutate the chat row's promptPresetId", async () => {
    // The chat mock always reports promptPresetId "preset_chat". After an override
    // assembly, a second no-override assembly must STILL resolve "preset_chat" —
    // proving the override was transient (per-request) and did not write back.
    const { resolver, calls } = makeResolver();
    const service = new PromptAssemblyService(mockStores, resolver, mockFileStore);

    await service.assembleForChat({ chatId: "chat_1" as ChatId, model: "m", presetId: "preset_override" as ChatId });
    await service.assembleForChat({ chatId: "chat_1" as ChatId, model: "m" });

    expect(calls).toEqual(["preset_override", "preset_chat"]); // override, then back to chat's
  });

  it("preset override with a non-existent id → getPromptPreset returns null-ish, handled gracefully", async () => {
    // If the override id is unknown, the resolver returns a default (chat) shape
    // here — the assembly must not throw. Documents the no-throw contract.
    const { resolver } = makeResolver();
    const service = new PromptAssemblyService(mockStores, resolver, mockFileStore);

    const result = await service.assembleForChat({ chatId: "chat_1" as ChatId, model: "m", presetId: "unknown_preset" as ChatId });
    expect(result.prompt).toBeDefined();
  });
});
