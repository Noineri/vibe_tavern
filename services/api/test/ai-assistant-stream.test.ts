import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import { countAiAssistantTokens, type StreamDeps } from "../src/domain/ai-assistant/ai-assistant-stream.js";

function deps(overrides: Partial<StreamDeps> = {}): StreamDeps {
  return {
    getCharacterById: async () => null,
    getPersonaById: async () => null,
    getLoreEntryById: async () => null,
    resolveModel: () => ({}) as never,
    getProviderProfile: async () => ({ id: "profile_1", providerPreset: "openai", endpoint: "", apiKey: "key", defaultModel: "model_1" }),
    getPresetPromptData: async () => ({ aiAssistantPrompts: { chat_impersonate: "Impersonate the character.", md_import: "Import this markdown." }, scriptAiSystemPrompt: null }),
    getChatMessages: async () => [],
    ...overrides,
  };
}

describe("AI assistant stream prompt preparation", () => {
  // The production server injects a model-aware tokenizer at bootstrap. Use a
  // deterministic local substitute so this test cannot inherit another file's
  // process-global tokenizer.
  beforeEach(() => setTokenCountFn((text) => text.length));
  afterEach(() => setTokenCountFn(() => 0));

  it("loads history only for chat_impersonate and includes it in the traced assembly", async () => {
    const calls: Array<[string, number]> = [];
    const result = await countAiAssistantTokens({
      mode: "chat_impersonate",
      instruction: "Continue.",
      providerProfileId: "profile_1",
      enabledLayers: [],
      chatId: "chat_1",
      recentMessageCount: 7,
    }, deps({ getChatMessages: async (chatId, count) => {
      calls.push([chatId, count]);
      return [{ id: "msg_1", role: "user", content: "Hello" }, { id: "msg_2", role: "assistant", content: "Hi" }];
    } }));

    expect(calls).toEqual([["chat_1", 7]]);
    expect(result).toEqual({ tokens: 65, model: "model_1", layerCount: 3, messageCount: 3 });
  });

  it("keeps md_import as a direct two-message path with no resolved context", async () => {
    let resolvedContext = false;
    const result = await countAiAssistantTokens({
      mode: "md_import",
      instruction: "Ignored when content exists.",
      existingContent: "# Imported card",
      providerProfileId: "profile_1",
      enabledLayers: ["character_base", "lore"],
    }, deps({ getCharacterById: async () => { resolvedContext = true; return null; } }));

    expect(resolvedContext).toBeFalse();
    expect(result).toEqual({ tokens: 36, model: "model_1", layerCount: 2, messageCount: 2 });
  });
});
