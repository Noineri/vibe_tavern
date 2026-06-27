import { describe, expect, it } from "bun:test";
import { assemblePrompt } from "../src/assemble.ts";

describe("Prompt pipeline: preset promptOrder toggles", () => {
  it("disables built-in character/persona/example slots (chat history is always enabled)", () => {
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
        advancedMode: true,
        promptOrder: [
          { identifier: "charDescription", enabled: false },
          { identifier: "scenario", enabled: false },
          { identifier: "charPersonality", enabled: false },
          { identifier: "personaDescription", enabled: false },
          { identifier: "dialogueExamples", enabled: false },
        ],
      },
    });

    const layerIds = result.layers.map((layer) => layer.id);
    expect(layerIds).not.toContain("character_base");
    expect(layerIds).not.toContain("character_scenario");
    expect(layerIds).not.toContain("character_personality");
    expect(layerIds).not.toContain("persona");
    expect(layerIds).not.toContain("mes_example");
    // chatHistory CANNOT be disabled: it carries container markup used for
    // precise inject-depth placement, so it must always survive (unlike ST,
    // which lets users drop it). Verify it is present despite no toggle.
    expect(layerIds).toContain("recent_history");
    expect(result.finalPayload.messages.some((message) => message.messageId === "m1")).toBe(true);
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
        advancedMode: true,
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
        advancedMode: true,
        customInjections: [{
          identifier: "custom_relative",
          name: "Custom Relative",
          content: "custom relative text",
          role: "user",
        }],
        promptOrder: [
          { identifier: "scenario", enabled: true, order: 0, zone: "before_chat", depth: null, kind: "built_in" },
          { identifier: "main", enabled: true, order: 1, zone: "before_chat", depth: null, kind: "built_in" },
          { identifier: "charDescription", enabled: true, order: 2, zone: "before_chat", depth: null, kind: "built_in" },
          { identifier: "custom_relative", enabled: true, order: 3, zone: "before_chat", depth: null, kind: "custom" },
          { identifier: "chatHistory", enabled: true, order: 4, zone: "after_chat", depth: null, kind: "built_in" },
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
        advancedMode: true,
        customInjections: [{
          identifier: "custom_after",
          name: "Custom After",
          content: "after chat text",
          role: "assistant",
        }],
        promptOrder: [
          { identifier: "main", enabled: true, order: 0, zone: "before_chat", depth: null, kind: "built_in" },
          { identifier: "chatHistory", enabled: true, order: 1, zone: "after_chat", depth: null, kind: "built_in" },
          { identifier: "custom_after", enabled: true, order: 2, zone: "after_chat", depth: null, kind: "custom" },
        ],
      },
    });

    const historyIndex = result.finalPayload.messages.findIndex((message) => message.messageId === "m1");
    const customIndex = result.finalPayload.messages.findIndex((message) => message.layerId === "preset_injection_custom_after");
    expect(customIndex).toBe(historyIndex + 1);
    expect(result.finalPayload.messages[customIndex]!.role).toBe("assistant");
  });

  // ── canvas depth drag: in_chat zone + depth → injectionDepth ───────────

  it("applies a canvas entry's depth as the layer injectionDepth (depth drag)", () => {
    // The whole point of the canvas depth handle: a user drags an in_chat slot
    // to depth 3 and the assembled layer must land at injectionDepth 3.
    // advanced-resolver.ts:33 maps entry.depth → layer.injectionDepth.
    const result = assemblePrompt({
      identity: { chatId: "chat_1" },
      chat: { recentMessages: [{ id: "m1", role: "user", content: "hello" }] },
      character: { id: "char_1", name: "Aria", description: "A mage." },
      preset: {
        id: "preset_1",
        text: "system prompt",
        advancedMode: true,
        customInjections: [{
          identifier: "custom_inchat",
          name: "In-chat",
          content: "dragged to depth 3",
          role: "system",
        }],
        promptOrder: [
          { identifier: "main", enabled: true, order: 0, zone: "before_chat", depth: null, kind: "built_in" },
          { identifier: "chatHistory", enabled: true, order: 1, zone: "after_chat", depth: null, kind: "built_in" },
          // depth: 3 is the drag position the user set on the canvas.
          { identifier: "custom_inchat", enabled: true, order: 2, zone: "in_chat", depth: 3, kind: "custom" },
        ],
      },
    });

    const layer = result.layers.find((l) => l.id === "preset_injection_custom_inchat");
    expect(layer).toBeTruthy();
    expect(layer.position).toBe("in_chat");
    expect(layer.injectionDepth).toBe(3);
  });

  it("defaults an in_chat canvas entry with no depth to injectionDepth 0", () => {
    // depth omitted (or null) on an in_chat entry → injected at the top of chat.
    const result = assemblePrompt({
      identity: { chatId: "chat_1" },
      chat: { recentMessages: [{ id: "m1", role: "user", content: "hello" }] },
      character: { id: "char_1", name: "Aria", description: "A mage." },
      preset: {
        id: "preset_1",
        text: "system prompt",
        advancedMode: true,
        customInjections: [{
          identifier: "custom_inchat",
          name: "In-chat",
          content: "top of chat",
          role: "system",
        }],
        promptOrder: [
          { identifier: "main", enabled: true, order: 0, zone: "before_chat", depth: null, kind: "built_in" },
          { identifier: "chatHistory", enabled: true, order: 1, zone: "after_chat", depth: null, kind: "built_in" },
          { identifier: "custom_inchat", enabled: true, order: 2, zone: "in_chat", depth: null, kind: "custom" },
        ],
      },
    });

    const layer = result.layers.find((l) => l.id === "preset_injection_custom_inchat");
    expect(layer).toBeTruthy();
    expect(layer.injectionDepth).toBe(0);
  });

  // ── simple mode: custom injections are not assembled ──────────────────

  it("does not assemble custom injections when advancedMode is off (simple mode)", () => {
    // SimpleResolver.includeCustomInjections is false — the preset still stores
    // customInjections (for 2-in-1 switching) but they must not appear in the
    // prompt. Guards the simple/advanced seam documented in position-resolver.ts.
    const result = assemblePrompt({
      identity: { chatId: "chat_1" },
      chat: { recentMessages: [{ id: "m1", role: "user", content: "hello" }] },
      character: { id: "char_1", name: "Aria", description: "A mage." },
      preset: {
        id: "preset_1",
        text: "system prompt",
        advancedMode: false, // simple mode — canvas is not authoritative
        customInjections: [{
          identifier: "custom_dropped",
          name: "Should Be Dropped",
          content: "must not appear",
          role: "system",
        }],
        // promptOrder present but ignored in simple mode (guard already covered);
        // included to prove it is advancedMode, not promptOrder's absence, that gates this.
        promptOrder: [
          { identifier: "main", enabled: true, order: 0, zone: "before_chat", depth: null, kind: "built_in" },
          { identifier: "custom_dropped", enabled: true, order: 1, zone: "before_chat", depth: null, kind: "custom" },
        ],
      },
    });

    const custom = result.layers.find((l) => l.id === "preset_injection_custom_dropped");
    expect(custom).toBeUndefined();
    const ids = result.finalPayload.messages.map((m) => m.layerId ?? m.messageId);
    expect(ids).not.toContain("preset_injection_custom_dropped");
  });
});
