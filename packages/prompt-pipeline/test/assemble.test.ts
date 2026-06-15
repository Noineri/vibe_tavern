import { describe, it, expect } from "bun:test";
import { assemblePrompt } from "../src/assemble.ts";

function baseContext(overrides = {}) {
  return {
    identity: {
      chatId: "chat_1",
    },
    chat: {
      recentMessages: [
        { id: "msg_1", role: "user", content: "Hello." },
        { id: "msg_2", role: "assistant", content: "Hi there." },
      ],
    },
    character: {
      id: "char_1",
      name: "Aria",
      description: "A fire mage.",
      scenario: "The tower burns.",
      systemPrompt: null,
    },
    ...overrides,
  };
}

describe("assemblePrompt", () => {
  describe("character layers", () => {
    it("includes character description and scenario as separate prompt-order slots", () => {
      const result = assemblePrompt(baseContext());
      const base = result.layers.find((l) => l.id === "character_base");
      const scenario = result.layers.find((l) => l.id === "character_scenario");
      expect(base).toBeTruthy();
      expect(base.text).toContain("Character: Aria");
      expect(base.text).toContain("A fire mage.");
      expect(base.text).not.toContain("Scenario:");
      expect(scenario).toBeTruthy();
      expect(scenario.text).toContain("Scenario: The tower burns.");
    });

    it("includes character_system_prompt layer when provided", () => {
      const result = assemblePrompt(baseContext({
        character: {
          id: "char_1",
          name: "Aria",
          description: "A mage.",
          systemPrompt: "You are a helpful assistant.",
        },
      }));
      const sys = result.layers.find((l) => l.id === "character_system_prompt");
      expect(sys).toBeTruthy();
      expect(sys.text).toBe("You are a helpful assistant.");
    });

    it("omits character_system_prompt when null/empty", () => {
      const result = assemblePrompt(baseContext());
      const sys = result.layers.find((l) => l.id === "character_system_prompt");
      expect(sys).toBeUndefined();
    });

    it("omits character_scenario when not provided", () => {
      const result = assemblePrompt(baseContext({
        character: { id: "char_1", name: "Aria", description: "A mage." },
      }));
      const base = result.layers.find((l) => l.id === "character_base");
      const scenario = result.layers.find((l) => l.id === "character_scenario");
      expect(base).toBeTruthy();
      expect(base.text).not.toContain("Scenario");
      expect(scenario).toBeUndefined();
    });
  });

  describe("prompt preset", () => {
    it("includes prompt_preset layer when provided", () => {
      const result = assemblePrompt(baseContext({
        preset: { id: "preset_1", text: "Global system instructions." },
      }));
      const preset = result.layers.find((l) => l.id === "prompt_preset_system");
      expect(preset).toBeTruthy();
      expect(preset.text).toBe("Global system instructions.");
      expect(preset.sourceType).toBe("prompt_preset");
    });

    it("omits prompt_preset when not provided", () => {
      const result = assemblePrompt(baseContext());
      const preset = result.layers.find((l) => l.id === "prompt_preset_system");
      expect(preset).toBeUndefined();
    });

    it("uses the configured Author's Note role", () => {
      const result = assemblePrompt(baseContext({
        preset: {
          id: "preset_1",
          authorsNote: "Respond strictly in English.",
          authorsNoteDepth: 1,
          authorsNotePosition: "in_chat",
          authorsNoteRole: "user",
        },
      }));

      const layer = result.layers.find((l) => l.id === "prompt_preset_authors_note");
      const payloadMessage = result.finalPayload.messages.find((m) => m.layerId === "prompt_preset_authors_note");
      expect(layer?.role).toBe("user");
      expect(payloadMessage?.role).toBe("user");
    });
  });

  describe("author's note placement (simple mode — flat fields are authoritative)", () => {
    it("places the note in_prompt when authorsNotePosition is in_prompt", () => {
      const result = assemblePrompt(baseContext({
        preset: {
          id: "preset_1",
          authorsNote: "Strict mode.",
          authorsNotePosition: "in_prompt",
        },
      }));
      const layer = result.layers.find((l) => l.id === "prompt_preset_authors_note");
      expect(layer?.position).toBe("in_prompt");
      expect(layer?.injectionDepth).toBeUndefined();
    });

    it("places the note at in_chat depth 0 when authorsNotePosition is after_chat", () => {
      // Regression guard: previously the after_chat branch called
      // resolver.position(), which in simple mode forced the note back into
      // in_prompt (DEFAULT_PROMPT_ORDER.authorsNote=60 < chatHistory=100),
      // silently dropping the user's after_chat placement.
      const result = assemblePrompt(baseContext({
        preset: {
          id: "preset_1",
          authorsNote: "After chat note.",
          authorsNotePosition: "after_chat",
        },
      }));
      const layer = result.layers.find((l) => l.id === "prompt_preset_authors_note");
      expect(layer?.position).toBe("in_chat");
      expect(layer?.injectionDepth).toBe(0);
    });

    it("places the note at the configured depth when authorsNotePosition is in_chat", () => {
      const result = assemblePrompt(baseContext({
        preset: {
          id: "preset_1",
          authorsNote: "Depth note.",
          authorsNotePosition: "in_chat",
          authorsNoteDepth: 3,
        },
      }));
      const layer = result.layers.find((l) => l.id === "prompt_preset_authors_note");
      expect(layer?.position).toBe("in_chat");
      expect(layer?.injectionDepth).toBe(3);
    });
  });

  describe("author's note placement (advanced mode — canvas is authoritative)", () => {
    it("uses the canvas zone/depth even when flat authorsNotePosition disagrees (in_chat)", () => {
      const result = assemblePrompt(baseContext({
        preset: {
          id: "preset_1",
          authorsNote: "Canvas-placed note.",
          // Flat fields disagree (after_chat @ depth 0) — must be ignored in advanced mode.
          authorsNotePosition: "after_chat",
          authorsNoteDepth: 0,
          advancedMode: true,
          promptOrder: [
            { identifier: "authorsNote", order: 60, enabled: true, zone: "in_chat", depth: 2 },
          ],
        },
      }));
      const layer = result.layers.find((l) => l.id === "prompt_preset_authors_note");
      expect(layer?.position).toBe("in_chat");
      expect(layer?.injectionDepth).toBe(2);
    });

    it("uses canvas after_chat even when flat authorsNotePosition is in_prompt", () => {
      const result = assemblePrompt(baseContext({
        preset: {
          id: "preset_1",
          authorsNote: "Canvas-placed note.",
          authorsNotePosition: "in_prompt",
          advancedMode: true,
          promptOrder: [
            { identifier: "authorsNote", order: 60, enabled: true, zone: "after_chat" },
          ],
        },
      }));
      const layer = result.layers.find((l) => l.id === "prompt_preset_authors_note");
      expect(layer?.position).toBe("in_chat");
      expect(layer?.injectionDepth).toBe(0);
    });

    it("uses canvas before_chat even when flat authorsNotePosition is in_chat at depth", () => {
      const result = assemblePrompt(baseContext({
        preset: {
          id: "preset_1",
          authorsNote: "Canvas-placed note.",
          authorsNotePosition: "in_chat",
          authorsNoteDepth: 3,
          advancedMode: true,
          promptOrder: [
            { identifier: "authorsNote", order: 60, enabled: true, zone: "before_chat" },
          ],
        },
      }));
      const layer = result.layers.find((l) => l.id === "prompt_preset_authors_note");
      expect(layer?.position).toBe("in_prompt");
      expect(layer?.injectionDepth).toBeUndefined();
    });

    it("still respects the flat fields when advancedMode is off (canvas entry ignored)", () => {
      // Guard: canvas entry present but advancedMode is false → simple mode,
      // flat fields must still win (mirrors the simple-mode describe above).
      const result = assemblePrompt(baseContext({
        preset: {
          id: "preset_1",
          authorsNote: "Simple-placed note.",
          authorsNotePosition: "after_chat",
          advancedMode: false,
          promptOrder: [
            { identifier: "authorsNote", order: 60, enabled: true, zone: "in_chat", depth: 2 },
          ],
        },
      }));
      const layer = result.layers.find((l) => l.id === "prompt_preset_authors_note");
      expect(layer?.position).toBe("in_chat");
      expect(layer?.injectionDepth).toBe(0);
    });
  });

  describe("persona", () => {
    it("includes persona layer when provided", () => {
      const result = assemblePrompt(baseContext({
        persona: { id: "persona_1", name: "Olya", description: "A scholar." },
      }));
      const persona = result.layers.find((l) => l.id === "persona");
      expect(persona).toBeTruthy();
      expect(persona.text).toContain("User persona (Olya)");
      expect(persona.text).toContain("A scholar.");
    });
  });

  describe("lore entries", () => {
    it("includes activated lore entries as layers", () => {
      const result = assemblePrompt(baseContext({
        lore: [
          { id: "lore_1", title: "Dragons", content: "Fire-breathing creatures.", priority: 10 },
        ],
      }));
      const lore = result.layers.find((l) => l.id === "lore_lore_1");
      expect(lore).toBeTruthy();
      expect(lore.text).toContain("Lore: Dragons");
      expect(lore.text).toContain("Fire-breathing creatures.");
    });

    it("drops lore entries with empty content", () => {
      const result = assemblePrompt(baseContext({
        lore: [
          { id: "lore_empty", title: "Empty", content: "   ", priority: 10 },
        ],
      }));
      const lore = result.layers.find((l) => l.id === "lore_lore_empty");
      expect(lore).toBeUndefined();
      expect(result.droppedLayers.length).toBe(1);
      expect(result.droppedLayers[0].id).toBe("lore_empty");
    });

    it("sorts lore entries by priority descending", () => {
      const result = assemblePrompt(baseContext({
        lore: [
          { id: "low", title: "Low", content: "Low priority.", priority: 5 },
          { id: "high", title: "High", content: "High priority.", priority: 50 },
        ],
      }));
      const loreLayers = result.layers.filter((l) => l.sourceType === "lore_entry");
      expect(loreLayers[0].id).toBe("lore_high");
      expect(loreLayers[1].id).toBe("lore_low");
    });

    it("passes lore position through to layer", () => {
      const result = assemblePrompt(baseContext({
        lore: [
          { id: "lore_pos", title: "T", content: "C.", priority: 10, position: "before_prompt" },
        ],
      }));
      const lore = result.layers.find((l) => l.id === "lore_lore_pos");
      expect(lore).toBeTruthy();
      expect(lore.position).toBe("before_prompt");
    });

    it("follows ST prompt-order marker placement for after_char lore", () => {
      const result = assemblePrompt(baseContext({
        preset: {
          id: "preset_1",
          text: "Global system instructions.",
          advancedMode: true,
          promptOrder: [
            { identifier: "main", order: 0, enabled: true },
            { identifier: "worldInfoAfter", order: 10, enabled: true },
            { identifier: "charDescription", order: 20, enabled: true },
            { identifier: "charPersonality", order: 30, enabled: true },
            { identifier: "scenario", order: 40, enabled: true },
            { identifier: "personaDescription", order: 50, enabled: true },
            { identifier: "chatHistory", order: 100, enabled: true },
          ],
        },
        character: {
          id: "char_1",
          name: "Aria",
          description: "A fire mage.",
          personality: "Careful.",
          scenario: "The tower burns.",
          systemPrompt: null,
        },
        persona: { id: "persona_1", name: "User", description: "An archivist." },
        lore: [
          { id: "after_char", title: "After", content: "After character lore.", priority: 10, position: "after_char" },
        ],
      }));

      const ids = result.finalPayload.messages.map((message) => message.layerId);
      const loreIndex = ids.indexOf("lore_after_char");
      expect(loreIndex).toBeLessThan(ids.indexOf("character_base"));
      expect(loreIndex).toBeLessThan(ids.indexOf("character_personality"));
      expect(loreIndex).toBeLessThan(ids.indexOf("character_scenario"));
      expect(loreIndex).toBeLessThan(ids.indexOf("persona"));
    });

    it("orders ST world info entries by per-entry insertion order, not input lorebook order", () => {
      const result = assemblePrompt(baseContext({
        preset: {
          id: "preset_1",
          text: "Global system instructions.",
          promptOrder: [
            { identifier: "main", order: 0, enabled: true },
            { identifier: "worldInfoAfter", order: 10, enabled: true },
            { identifier: "chatHistory", order: 100, enabled: true },
          ],
        },
        lore: [
          { id: "book_b_late", title: "Late", content: "Late lore.", priority: 999, sortOrder: 200, position: "after_char" },
          { id: "book_a_early", title: "Early", content: "Early lore.", priority: 1, sortOrder: 10, position: "after_char" },
          { id: "book_c_middle", title: "Middle", content: "Middle lore.", priority: 500, sortOrder: 100, position: "after_char" },
        ],
      }));

      const loreIds = result.finalPayload.messages
        .map((message) => message.layerId)
        .filter((id) => typeof id === "string" && id.startsWith("lore_"));
      expect(loreIds).toEqual(["lore_book_a_early", "lore_book_c_middle", "lore_book_b_late"]);
    });
  });

  describe("memory", () => {
    it("includes summary memory layers", () => {
      const result = assemblePrompt(baseContext({
        memory: {
          summary: [
            { id: "sum_1", kind: "chapter", summary: "They met at the inn." },
          ],
        },
      }));
      const mem = result.layers.find((l) => l.id === "summary_sum_1");
      expect(mem).toBeTruthy();
      expect(mem.text).toContain("[chapter]");
      expect(mem.text).toContain("They met at the inn.");
    });

    it("includes retrieval memory layers sorted by score", () => {
      const result = assemblePrompt(baseContext({
        memory: {
          retrieval: [
            { id: "ret_low", sourceType: "dialogue", content: "Low score.", score: 0.3 },
            { id: "ret_high", sourceType: "event", content: "High score.", score: 0.9 },
          ],
        },
      }));
      const retLayers = result.layers.filter((l) => l.sourceType === "retrieval_memory");
      expect(retLayers[0].id).toBe("retrieval_ret_high");
      expect(retLayers[1].id).toBe("retrieval_ret_low");
    });
  });

  describe("tool instructions", () => {
    it("includes tool_instructions layer when provided", () => {
      const result = assemblePrompt(baseContext({
        instructions: { toolInstructions: "Use the search tool when needed." },
      }));
      const tool = result.layers.find((l) => l.id === "tool_instructions");
      expect(tool).toBeTruthy();
      expect(tool.text).toBe("Use the search tool when needed.");
    });
  });

  describe("chat history", () => {
    it("includes recent_history layer from messages", () => {
      const result = assemblePrompt(baseContext());
      const hist = result.layers.find((l) => l.id === "recent_history");
      expect(hist).toBeTruthy();
      expect(hist.text).toContain("USER: Hello.");
      expect(hist.text).toContain("ASSISTANT: Hi there.");
    });

    it("omits recent_history when no messages", () => {
      const result = assemblePrompt(baseContext({ chat: { recentMessages: [] } }));
      const hist = result.layers.find((l) => l.id === "recent_history");
      expect(hist).toBeUndefined();
    });
  });

  describe("layer ordering", () => {
    it("uses ST-compatible default prompt order for worldInfoAfter before chat history", () => {
      const result = assemblePrompt(baseContext({
        preset: { id: "p1", text: "Preset." },
        lore: [
          { id: "l1", title: "Lore", content: "Lore text.", priority: 10, position: "after_char" },
        ],
      }));
      const ids = result.layers.map((l) => l.id);
      const presetIdx = ids.indexOf("prompt_preset_system");
      const baseIdx = ids.indexOf("character_base");
      const loreIdx = ids.indexOf("lore_l1");
      const histIdx = ids.indexOf("recent_history");
      expect(presetIdx).toBeLessThan(baseIdx);
      expect(baseIdx).toBeLessThan(loreIdx);
      expect(loreIdx).toBeLessThan(histIdx);
    });

    it("places world info after chat when the ST prompt-order marker is after chatHistory", () => {
      const result = assemblePrompt(baseContext({
        preset: {
          id: "p1",
          text: "Preset.",
          advancedMode: true,
          promptOrder: [
            { identifier: "main", order: 0, enabled: true },
            { identifier: "charDescription", order: 10, enabled: true },
            { identifier: "chatHistory", order: 20, enabled: true },
            { identifier: "worldInfoAfter", order: 30, enabled: true, zone: "after_chat" },
          ],
        },
        lore: [
          { id: "l1", title: "Lore", content: "Lore text.", priority: 10, position: "after_char" },
        ],
      }));

      const ids = result.finalPayload.messages.map((message) => message.layerId ?? message.messageId);
      expect(ids.indexOf("msg_2")).toBeLessThan(ids.indexOf("lore_l1"));
    });
  });

  describe("finalPayload", () => {
    it("puts non-history layers as system messages, history as user/assistant", () => {
      const result = assemblePrompt(baseContext());
      const msgs = result.finalPayload.messages;
      const systemMsgs = msgs.filter((m) => m.role === "system");
      const chatMsgs = msgs.filter((m) => m.role !== "system");
      expect(systemMsgs.length).toBeGreaterThanOrEqual(1);
      expect(chatMsgs.length).toBe(2);
      expect(chatMsgs[0].role).toBe("user");
      expect(chatMsgs[0].content).toBe("Hello.");
      expect(chatMsgs[1].role).toBe("assistant");
      expect(chatMsgs[1].content).toBe("Hi there.");
    });

    it("chat history messages carry messageId, layers carry layerId", () => {
      const result = assemblePrompt(baseContext());
      const msgs = result.finalPayload.messages;
      for (const m of msgs) {
        if (m.role === "system") {
          expect(m.layerId).toBeTruthy();
        } else {
          expect(m.messageId).toBeTruthy();
        }
      }
    });
  });

  describe("result metadata", () => {
    it("totalTokenEstimate is sum of layer token counts", () => {
      const result = assemblePrompt(baseContext());
      const manualSum = result.layers.reduce((s, l) => s + l.tokenCount, 0);
      expect(result.totalTokenEstimate).toBe(manualSum);
    });

    it("activatedLoreEntries lists lore IDs", () => {
      const result = assemblePrompt(baseContext({
        lore: [
          { id: "l1", title: "T", content: "C.", priority: 5 },
          { id: "l2", title: "T", content: "C.", priority: 5 },
        ],
      }));
      expect(result.activatedLoreEntries).toEqual(["l1", "l2"]);
    });

    it("usedMemoryBlocks combines summary and retrieval IDs", () => {
      const result = assemblePrompt(baseContext({
        memory: {
          summary: [{ id: "s1", kind: "chapter", summary: "text." }],
          retrieval: [{ id: "r1", sourceType: "event", content: "text.", score: 0.5 }],
        },
      }));
      expect(result.usedMemoryBlocks).toEqual(["s1", "r1"]);
    });
  });

  describe("empty context", () => {
    it("produces minimal result with just character and history", () => {
      const result = assemblePrompt(baseContext());
      expect(result.layers.length).toBeGreaterThanOrEqual(2);
      expect(result.droppedLayers.length).toBe(0);
    });
  });
});
