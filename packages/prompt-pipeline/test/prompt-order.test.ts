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

// ── Toggle matrix: every standard slot × {on, off} ──────────────────────────
// APC-1. Verifies the advanced-mode resolver honours `enabled` for EVERY
// built-in identifier (nsfw/enhanceDefinitions were previously untested). Each
// case builds a maximal context (all content sources populated) and toggles
// exactly one identifier: the corresponding layer MUST be present when enabled
// and absent when disabled. chatHistory is always-enabled by design; assistantPrefill
// is not a layer (it surfaces as `result.prefill`). worldInfoBefore/After gate
// lore entries (position before_char/after_char), so they assert on the lore layer.
describe("Prompt pipeline: promptOrder toggle matrix (every standard slot)", () => {
  function ctxWith(toggle: { identifier: string; enabled: boolean }) {
    return {
      identity: { chatId: "chat_1" },
      chat: { recentMessages: [{ id: "m1", role: "user", content: "hello" }] },
      character: {
        id: "char_1",
        name: "Aria",
        description: "A mage.",
        scenario: "The tower burns.",
        personality: "Careful.",
        mesExample: "<START>\n{{user}}: hi\n{{char}}: hello",
        mesExampleMode: "always",
        avatarDescription: "pale skin, silver eyes",
        includeAvatarInPrompt: true,
        gallery: [{ caption: "ref", description: "a cloak" }],
      },
      persona: {
        id: "persona_1",
        name: "Olya",
        description: "A scholar.",
        avatarDescription: "dark hair",
        includeAvatarInPrompt: true,
      },
      lore: [
        { id: "Lbefore", title: "Before", content: "before-lore body", priority: 100, position: "before_char" },
        { id: "Lafter", title: "After", content: "after-lore body", priority: 100, position: "after_char" },
      ],
      preset: {
        id: "preset_1",
        text: "system prompt",
        jailbreak: "post history",
        authorsNote: "author note",
        nsfw: "nsfw block",
        enhanceDefinitions: "enhance block",
        prefill: "prefill text",
        advancedMode: true,
        promptOrder: [toggle],
      },
    };
  }

  const cases: Array<{ identifier: string; layerId: string }> = [
    { identifier: "main", layerId: "prompt_preset_system" },
    { identifier: "jailbreak", layerId: "prompt_preset_jailbreak" },
    { identifier: "authorsNote", layerId: "prompt_preset_authors_note" },
    { identifier: "enhanceDefinitions", layerId: "prompt_preset_enhance_definitions" },
    { identifier: "nsfw", layerId: "prompt_preset_nsfw" },
    { identifier: "charDescription", layerId: "character_base" },
    { identifier: "charPersonality", layerId: "character_personality" },
    { identifier: "scenario", layerId: "character_scenario" },
    { identifier: "characterAvatar", layerId: "character_avatar" },
    { identifier: "characterGallery", layerId: "character_gallery" },
    { identifier: "personaDescription", layerId: "persona" },
    { identifier: "personaAvatar", layerId: "persona_avatar" },
    { identifier: "dialogueExamples", layerId: "mes_example" },
    { identifier: "worldInfoBefore", layerId: "lore_Lbefore" },
    { identifier: "worldInfoAfter", layerId: "lore_Lafter" },
  ];

  for (const { identifier, layerId } of cases) {
    it(`toggles ${identifier}: layer present when enabled, absent when disabled`, () => {
      const enabled = assemblePrompt(ctxWith({ identifier, enabled: true }));
      const disabled = assemblePrompt(ctxWith({ identifier, enabled: false }));
      const enabledIds = enabled.layers.map((l) => l.id);
      const disabledIds = disabled.layers.map((l) => l.id);
      expect(enabledIds).toContain(layerId);
      expect(disabledIds).not.toContain(layerId);
    });
  }

  it("chatHistory cannot be disabled (always enabled — carries depth markup)", () => {
    const disabled = assemblePrompt(ctxWith({ identifier: "chatHistory", enabled: false }));
    expect(disabled.layers.map((l) => l.id)).toContain("recent_history");
  });

  it("assistantPrefill toggle controls result.prefill (not a layer)", () => {
    const enabled = assemblePrompt(ctxWith({ identifier: "assistantPrefill", enabled: true }));
    const disabled = assemblePrompt(ctxWith({ identifier: "assistantPrefill", enabled: false }));
    expect(enabled.prefill).toBe("prefill text");
    expect(disabled.prefill).toBeNull();
  });
});

// ── Canvas entry role overrides built-in layer role (APC-2c) ────────────────
// A `role` on a built-in canvas entry overrides the layer's hardcoded default
// (most built-ins → system). Absent role keeps the default (backward compat).
// The override is advanced-mode only: simple resolver's entryFor() is always
// undefined, so simple mode is unaffected (canvas is not authoritative).
describe("Prompt pipeline: canvas entry role overrides built-in layer role", () => {
  it("main with role:user → system-prompt message role is user", () => {
    const result = assemblePrompt({
      identity: { chatId: "chat_1" },
      chat: { recentMessages: [] },
      character: { id: "char_1", name: "Aria" },
      preset: {
        id: "preset_1",
        text: "system prompt",
        advancedMode: true,
        promptOrder: [{ identifier: "main", enabled: true, role: "user" }],
      },
    });
    const sysMsg = result.finalPayload.messages.find((m) => m.layerId === "prompt_preset_system");
    expect(sysMsg).toBeTruthy();
    expect(sysMsg!.role).toBe("user");
  });

  it("main without role → defaults to system (backward compat)", () => {
    const result = assemblePrompt({
      identity: { chatId: "chat_1" },
      chat: { recentMessages: [] },
      character: { id: "char_1", name: "Aria" },
      preset: {
        id: "preset_1",
        text: "system prompt",
        advancedMode: true,
        promptOrder: [{ identifier: "main", enabled: true }],
      },
    });
    const sysMsg = result.finalPayload.messages.find((m) => m.layerId === "prompt_preset_system");
    expect(sysMsg!.role).toBe("system");
  });

  it("jailbreak with role:assistant → post-history message role is assistant", () => {
    const result = assemblePrompt({
      identity: { chatId: "chat_1" },
      chat: { recentMessages: [] },
      character: { id: "char_1", name: "Aria" },
      preset: {
        id: "preset_1",
        jailbreak: "post history",
        advancedMode: true,
        promptOrder: [{ identifier: "jailbreak", enabled: true, role: "assistant" }],
      },
    });
    const jbMsg = result.finalPayload.messages.find((m) => m.layerId === "prompt_preset_jailbreak");
    expect(jbMsg!.role).toBe("assistant");
  });

  it("role override is ignored in simple mode (canvas not authoritative)", () => {
    // SimpleResolver.entryFor() is always undefined → built-in layers use their
    // hardcoded defaults even if an entry carries role:user.
    const result = assemblePrompt({
      identity: { chatId: "chat_1" },
      chat: { recentMessages: [] },
      character: { id: "char_1", name: "Aria" },
      preset: {
        id: "preset_1",
        text: "system prompt",
        advancedMode: false, // simple mode — canvas ignored
        promptOrder: [{ identifier: "main", enabled: true, role: "user" }],
      },
    });
    const sysMsg = result.finalPayload.messages.find((m) => m.layerId === "prompt_preset_system");
    expect(sysMsg!.role).toBe("system");
  });
});
