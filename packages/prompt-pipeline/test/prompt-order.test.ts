import { describe, expect, it } from "bun:test";
import { assemblePrompt } from "../src/assemble.ts";

describe("Prompt pipeline: preset promptOrder toggles", () => {
  it("disables built-in character/persona/history/example slots", () => {
    const result = assemblePrompt({
      identity: { chatId: "chat_1" },
      chat: {
        recentMessages: [{ id: "m1", role: "user", content: "hello" }],
      },
      character: {
        id: "char_1",
        name: "Aria",
        description: "A mage.",
        scenario: "The tower burns.",
        personality: "Careful.",
        mesExample: "<START>\n{{user}}: hi\n{{char}}: hello",
        mesExampleMode: "always",
      },
      persona: { id: "persona_1", name: "Olya", description: "A scholar." },
      preset: {
        id: "preset_1",
        text: "system prompt",
        promptOrder: [
          { identifier: "charDescription", enabled: false },
          { identifier: "scenario", enabled: false },
          { identifier: "charPersonality", enabled: false },
          { identifier: "personaDescription", enabled: false },
          { identifier: "chatHistory", enabled: false },
          { identifier: "dialogueExamples", enabled: false },
        ],
      },
    });

    const layerIds = result.layers.map((layer) => layer.id);
    expect(layerIds).not.toContain("character_base");
    expect(layerIds).not.toContain("character_scenario");
    expect(layerIds).not.toContain("character_personality");
    expect(layerIds).not.toContain("persona");
    expect(layerIds).not.toContain("recent_history");
    expect(layerIds).not.toContain("mes_example");
    expect(result.finalPayload.messages.some((message) => message.messageId === "m1")).toBe(false);
  });

  it("disables preset-owned main/jailbreak/authorsNote slots", () => {
    const result = assemblePrompt({
      identity: { chatId: "chat_1" },
      chat: { recentMessages: [] },
      character: { id: "char_1", name: "Aria", description: "A mage." },
      preset: {
        id: "preset_1",
        text: "system prompt",
        jailbreak: "post history",
        authorsNote: "author note",
        promptOrder: [
          { identifier: "main", enabled: false },
          { identifier: "jailbreak", enabled: false },
          { identifier: "authorsNote", enabled: false },
        ],
      },
    });

    const layerIds = result.layers.map((layer) => layer.id);
    expect(layerIds).not.toContain("prompt_preset_system");
    expect(layerIds).not.toContain("prompt_preset_jailbreak");
    expect(layerIds).not.toContain("prompt_preset_authors_note");
  });

  it("orders built-in slots and relative custom injections from promptOrder", () => {
    const result = assemblePrompt({
      identity: { chatId: "chat_1" },
      chat: { recentMessages: [{ id: "m1", role: "user", content: "hello" }] },
      character: {
        id: "char_1",
        name: "Aria",
        description: "A mage.",
        scenario: "The tower burns.",
      },
      preset: {
        id: "preset_1",
        text: "system prompt",
        customInjections: [{
          identifier: "custom_relative",
          name: "Custom Relative",
          content: "custom relative text",
          depth: 4,
          role: "user",
          enabled: true,
          injectionPosition: 0,
        }],
        promptOrder: [
          { identifier: "scenario", enabled: true, order: 0, kind: "built_in" },
          { identifier: "main", enabled: true, order: 1, kind: "built_in" },
          { identifier: "charDescription", enabled: true, order: 2, kind: "built_in" },
          { identifier: "custom_relative", enabled: true, order: 3, kind: "custom" },
          { identifier: "chatHistory", enabled: true, order: 4, kind: "built_in" },
        ],
      },
    });

    const ids = result.finalPayload.messages.map((message) => message.layerId ?? message.messageId);
    expect(ids.slice(0, 5)).toEqual([
      "character_scenario",
      "prompt_preset_system",
      "character_base",
      "preset_injection_custom_relative",
      "m1",
    ]);
  });

  it("places reordered relative custom injections after chatHistory", () => {
    const result = assemblePrompt({
      identity: { chatId: "chat_1" },
      chat: { recentMessages: [{ id: "m1", role: "user", content: "hello" }] },
      character: { id: "char_1", name: "Aria", description: "A mage." },
      preset: {
        id: "preset_1",
        text: "system prompt",
        customInjections: [{
          identifier: "custom_after",
          name: "Custom After",
          content: "after chat text",
          depth: 4,
          role: "assistant",
          enabled: true,
          injectionPosition: 0,
        }],
        promptOrder: [
          { identifier: "main", enabled: true, order: 0, kind: "built_in" },
          { identifier: "chatHistory", enabled: true, order: 1, kind: "built_in" },
          { identifier: "custom_after", enabled: true, order: 2, kind: "custom" },
        ],
      },
    });

    const historyIndex = result.finalPayload.messages.findIndex((message) => message.messageId === "m1");
    const customIndex = result.finalPayload.messages.findIndex((message) => message.layerId === "preset_injection_custom_after");
    expect(customIndex).toBe(historyIndex + 1);
    expect(result.finalPayload.messages[customIndex]!.role).toBe("assistant");
  });
});
