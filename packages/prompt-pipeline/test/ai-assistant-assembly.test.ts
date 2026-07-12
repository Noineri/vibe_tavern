import { describe, expect, it } from "bun:test";
import { getAiAssistantAssembler } from "../src/ai-assistant/ai-assistant-assemblers.ts";

function assemble(overrides: Record<string, unknown> = {}) {
  return getAiAssistantAssembler("script").assemble({
    identity: { chatId: "assistant_1" },
    character: { id: "char_1", name: "Aria", description: "A fire mage.", personality: "Bold.", scenario: "A burning tower." },
    persona: { id: "persona_1", name: "Mira", description: "A scholar." },
    lore: [{ id: "lore_1", title: "Ember", content: "Fire magic is forbidden." }],
    chat: { recentMessages: [] },
    mode: "ai_assistant",
    aiAssistant: {
      mode: "script",
      enabledLayers: ["character_base", "persona", "lore"],
      systemPrompt: "You improve character cards.",
      existingContent: "Old description.",
      instruction: "Rewrite it.",
    },
    ...overrides,
  });
}

describe("AI assistant assembly", () => {
  it("keeps the generic assistant layers and final user instruction byte-for-byte", () => {
    const result = assemble();
    expect(result.layers.map((layer) => layer.id)).toEqual([
      "ai_assistant_system",
      "character_base",
      "persona",
      "lore_lore_1",
      "ai_assistant_existing",
      "ai_assistant_instruction",
    ]);
    expect(result.finalPayload.messages).toEqual([
      { role: "system", content: "You improve character cards.", layerId: "ai_assistant_system" },
      { role: "system", content: "Character: Aria\nA fire mage.\nBold.\nScenario: A burning tower.", layerId: "character_base" },
      { role: "system", content: "User persona (Mira): A scholar.", layerId: "persona" },
      { role: "system", content: "Lore: Ember\nFire magic is forbidden.", layerId: "lore_lore_1" },
      { role: "system", content: "Old description.", layerId: "ai_assistant_existing" },
      { role: "user", content: "Rewrite it.", layerId: "ai_assistant_instruction" },
    ]);
    expect(result.prefill).toBeNull();
    expect(result.compactionSummary).toBeNull();
    expect(result.droppedLayers).toEqual([]);
  });

  it("gates only optional context layers", () => {
    const result = assemble({ aiAssistant: {
      mode: "script",
      enabledLayers: [],
      systemPrompt: "System.",
      existingContent: "Existing.",
      instruction: "Instruction.",
    } });
    expect(result.layers.map((layer) => layer.id)).toEqual([
      "ai_assistant_system",
      "ai_assistant_existing",
      "ai_assistant_instruction",
    ]);
  });

  it("adds the chat history layer only for chat_impersonate", () => {
    const result = assemble({
      chat: { recentMessages: [{ id: "msg_1", role: "user", content: "Hello" }, { id: "msg_2", role: "assistant", content: "Hi" }] },
      aiAssistant: { mode: "chat_impersonate", enabledLayers: [], systemPrompt: "Impersonate.", instruction: "Continue." },
    });
    expect(result.layers.map((layer) => layer.id)).toEqual([
      "ai_assistant_system",
      "ai_assistant_chat_history",
      "ai_assistant_instruction",
    ]);
    expect(result.finalPayload.messages[1]).toEqual({ role: "system", content: "[user]: Hello\n\n[assistant]: Hi", layerId: "ai_assistant_chat_history" });
  });
});
