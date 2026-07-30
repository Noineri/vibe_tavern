import { describe, expect, it } from "bun:test";
import { getAiAssistantAssembler } from "../src/ai-assistant/ai-assistant-assemblers.ts";
import { setTokenCountFn } from "../src/compaction.ts";
import type { AiAssistantMode, PromptAssemblyContext } from "../src/types.ts";

function assemble(
  overrides: Partial<PromptAssemblyContext> = {},
  registryMode: AiAssistantMode = "script",
) {
  return getAiAssistantAssembler(registryMode).assemble({
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

function assembleMessageMode(mode: AiAssistantMode, contextBudget: number) {
  return getAiAssistantAssembler(mode).assemble({
    identity: { chatId: "message_editor_1" },
    character: {
      id: "char_1",
      name: "Aria",
      description: "CHARACTER_TOKEN",
      personality: "PERSONALITY_TOKEN",
      scenario: "SCENARIO_TOKEN",
      mesExample: "<START>\n{{user}}: EXAMPLE_USER_TOKEN\n{{char}}: EXAMPLE_ASSISTANT_TOKEN",
      mesExampleMode: "always",
    },
    persona: { id: "persona_1", name: "Mira", description: "PERSONA_TOKEN" },
    preset: {
      id: "preset_1",
      name: "Preset",
      text: "PRESET_FOR_{{char}}",
      jailbreak: "JAILBREAK_TOKEN",
      authorsNote: "AUTHORS_NOTE_TOKEN",
      authorsNotePosition: "after_chat",
      prefill: "PREFILL_TOKEN",
    },
    lore: [{ id: "lore_1", title: "LORE_TOKEN", content: "LORE_CONTENT_TOKEN", priority: 0 }],
    memory: {
      summary: [{ id: "summary_1", kind: "Summary", summary: "SUMMARY_MEMORY_TOKEN" }],
      retrieval: [{ id: "retrieval_1", sourceType: "Note", content: "RETRIEVAL_MEMORY_TOKEN", score: 1 }],
    },
    chat: {
      recentMessages: [
        { id: "message_1", role: "user", content: "HISTORY_EARLY_TOKEN ".repeat(30) },
        { id: "message_2", role: "assistant", content: "HISTORY_MIDDLE_TOKEN ".repeat(30) },
        { id: "message_3", role: "user", content: "HISTORY_RECENT_TOKEN ".repeat(20) },
      ],
      scriptInjections: [{ content: "SCRIPT_INJECTION_TOKEN", role: "system" }],
    },
    objectiveTask: { description: "OBJECTIVE_TOKEN", injectPrompt: "OBJECTIVE_PROMPT_TOKEN", injectionDepth: 0 },
    sceneState: {
      entries: [{ scene: "SCENE_TOKEN" }],
      format: "json",
      injectPrompt: "SCENE_PROMPT_TOKEN",
      injectionDepth: 0,
    },
    config: { contextBudget, responseReserve: 0 },
    aiAssistant: {
      mode,
      enabledLayers: [],
      systemPrompt: "EDITOR_SYSTEM_FOR_{{char}}",
      existingContent: "EXISTING_MESSAGE_TOKEN",
      instruction: "EDITOR_TASK_FOR_{{char}}",
    },
  });
}

const EXISTING_AI_ASSISTANT_MODES = [
  "script",
  "lore_entry",
  "lore_keys",
  "chat_impersonate",
  "md_import",
  "vision_describe",
  "scene_schema",
  "scene_rules",
] as const satisfies readonly AiAssistantMode[];

describe("AI assistant assembly", () => {
  it("keeps existing registry modes' minimal final payload bytes stable", () => {
    const baseline = assemble();
    const expectedPayload = JSON.stringify(baseline.finalPayload);

    for (const mode of EXISTING_AI_ASSISTANT_MODES) {
      const result = assemble({
        aiAssistant: {
          mode,
          enabledLayers: ["character_base", "persona", "lore"],
          systemPrompt: "You improve character cards.",
          existingContent: "Old description.",
          instruction: "Rewrite it.",
        },
      }, mode);

      expect(JSON.stringify(result.finalPayload)).toBe(expectedPayload);
      expect(result.totalTokenEstimate).toBe(baseline.totalTokenEstimate);
      expect(result.prefill).toBeNull();
    }
  });

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

const MESSAGE_AI_ASSISTANT_MODES = ["message_edit", "message_merge"] as const;

describe("message AI assistant assembly", () => {
  for (const mode of MESSAGE_AI_ASSISTANT_MODES) {
    it(`retains the full RP pipeline and a final editor instruction when mode is ${mode}`, () => {
      setTokenCountFn((text) => text.length);

      const result = assembleMessageMode(mode, 10_000);
      const layerIds = result.layers.map((layer) => layer.id);
      for (const layerId of [
        "prompt_preset_system",
        "prompt_preset_jailbreak",
        "prompt_preset_authors_note",
        "character_base",
        "character_scenario",
        "character_personality",
        "persona",
        "lore_lore_1",
        "summary_summary_1",
        "retrieval_retrieval_1",
        "mes_example",
        "recent_history",
        "objective_task",
        "scene_state",
        "script_injection_0",
        "ai_assistant_instruction",
      ]) {
        expect(layerIds).toContain(layerId);
      }

      const presetLayer = result.layers.find((layer) => layer.id === "prompt_preset_system");
      expect(presetLayer?.text).toBe("PRESET_FOR_Aria");

      const editorLayer = result.layers.find((layer) => layer.id === "ai_assistant_instruction");
      expect(editorLayer?.tokenCount).toBeGreaterThan(0);
      expect(result.totalTokenEstimate).toBe(result.layers.reduce((total, layer) => total + layer.tokenCount, 0));

      const finalMessage = result.finalPayload.messages.at(-1);
      expect(finalMessage?.role).toBe("user");
      expect(finalMessage?.layerId).toBe("ai_assistant_instruction");
      expect(finalMessage?.content).toContain("EDITOR_SYSTEM_FOR_Aria");
      expect(finalMessage?.content).toContain("EXISTING_MESSAGE_TOKEN");
      expect(finalMessage?.content).toContain("EDITOR_TASK_FOR_Aria");
      expect(result.prefill).toBeNull();
    });

    it(`accounts for the editor instruction before compacting history when mode is ${mode}`, () => {
      setTokenCountFn((text) => text.length);

      const result = assembleMessageMode(mode, 900);
      const editorLayer = result.layers.find((layer) => layer.id === "ai_assistant_instruction");
      const finalMessage = result.finalPayload.messages.at(-1);

      expect(result.compactionSummary).not.toBeNull();
      expect(editorLayer?.tokenCount).toBeGreaterThan(0);
      expect(result.totalTokenEstimate).toBe(result.layers.reduce((total, layer) => total + layer.tokenCount, 0));
      expect(finalMessage?.layerId).toBe("ai_assistant_instruction");
      expect(finalMessage?.content).toContain("EDITOR_TASK_FOR_Aria");
      expect(result.prefill).toBeNull();
    });
  }
});
