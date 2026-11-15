import { describe, it, expect } from "bun:test";
import { PromptAssemblyService, type PromptAssemblyResolver } from "../src/domain/prompt/prompt-assembly-service.js";
import type { ChatId } from "@vibe-tavern/domain";
import { makeAssemblyPreset, makeAssemblyResolver, makeFileStoreDouble, makePromptAssemblyStores } from "./insights-test-builders.js";

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
  const resolver = makeAssemblyResolver({
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
    // Discriminate by id so unknown preset ids hit the real null branch.
    getPromptPreset: async (presetId: string) => {
      calls.push(presetId);
      if (presetId === "preset_override") {
        return makeAssemblyPreset({
          id: "preset_override",
          name: "Override",
          text: OVERRIDE_PRESET_TEXT,
        });
      }
      if (presetId === "preset_chat") {
        return makeAssemblyPreset({
          id: "preset_chat",
          name: "ChatDefault",
          text: CHAT_PRESET_TEXT,
        });
      }
      return null;
    },
    executeScripts: async (input) => ({
      personality: input.characterRecord.personality ?? "",
      scenario: input.characterRecord.scenario ?? "",
      injectedMessages: [],
      errors: [],
      scriptRuns: [],
    }),
  });
  return { resolver, calls };
}

const mockStores = makePromptAssemblyStores(
  {
    chat: { personaId: "persona_1", promptPresetId: "preset_chat", title: "Test" },
  },
  "PromptAssemblyService stores (preset-override)",
);

const mockFileStore = makeFileStoreDouble();

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

  it("preset override with a non-existent id → getPromptPreset returns null, handled gracefully", async () => {
    // Missing preset row: resolver returns null, assembly still succeeds
    // and leaves promptTraceDraft.presetName null.
    const { resolver, calls } = makeResolver();
    const service = new PromptAssemblyService(mockStores, resolver, mockFileStore);

    const result = await service.assembleForChat({ chatId: "chat_1" as ChatId, model: "m", presetId: "unknown_preset" as ChatId });
    expect(calls).toEqual(["unknown_preset"]);
    expect(result.prompt).toBeDefined();
    expect(result.promptTraceDraft.presetName).toBeNull();
  });
});
