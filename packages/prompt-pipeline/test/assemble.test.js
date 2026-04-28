import { describe, it, expect } from "bun:test";
import { assemblePrompt } from "../dist/assemble.js";

function baseContext(overrides = {}) {
  return {
    chatId: "chat_1",
    character: {
      id: "char_1",
      name: "Aria",
      description: "A fire mage.",
      scenario: "The tower burns.",
      systemPrompt: null,
    },
    recentMessages: [
      { id: "msg_1", role: "user", content: "Hello." },
      { id: "msg_2", role: "assistant", content: "Hi there." },
    ],
    ...overrides,
  };
}

describe("assemblePrompt", () => {
  describe("character layers", () => {
    it("includes character_base layer with name, description, scenario", () => {
      const result = assemblePrompt(baseContext());
      const base = result.layers.find((l) => l.id === "character_base");
      expect(base).toBeTruthy();
      expect(base.text).toContain("Character: Aria");
      expect(base.text).toContain("A fire mage.");
      expect(base.text).toContain("Scenario: The tower burns.");
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

    it("omits scenario from character_base when not provided", () => {
      const result = assemblePrompt(baseContext({
        character: { id: "char_1", name: "Aria", description: "A mage." },
      }));
      const base = result.layers.find((l) => l.id === "character_base");
      expect(base).toBeTruthy();
      expect(base.text).not.toContain("Scenario");
    });
  });

  describe("prompt preset", () => {
    it("includes prompt_preset layer when provided", () => {
      const result = assemblePrompt(baseContext({
        promptPreset: { id: "preset_1", text: "Global system instructions." },
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
        activeLoreEntries: [
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
        activeLoreEntries: [
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
        activeLoreEntries: [
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
        activeLoreEntries: [
          { id: "lore_pos", title: "T", content: "C.", priority: 10, position: "before_prompt" },
        ],
      }));
      const lore = result.layers.find((l) => l.id === "lore_lore_pos");
      expect(lore).toBeTruthy();
      expect(lore.position).toBe("before_prompt");
    });
  });

  describe("memory", () => {
    it("includes summary memory layers", () => {
      const result = assemblePrompt(baseContext({
        summaryMemory: [
          { id: "sum_1", kind: "chapter", summary: "They met at the inn." },
        ],
      }));
      const mem = result.layers.find((l) => l.id === "summary_sum_1");
      expect(mem).toBeTruthy();
      expect(mem.text).toContain("[chapter]");
      expect(mem.text).toContain("They met at the inn.");
    });

    it("includes retrieval memory layers sorted by score", () => {
      const result = assemblePrompt(baseContext({
        retrievalMemory: [
          { id: "ret_low", sourceType: "dialogue", content: "Low score.", score: 0.3 },
          { id: "ret_high", sourceType: "event", content: "High score.", score: 0.9 },
        ],
      }));
      const retLayers = result.layers.filter((l) => l.sourceType === "retrieval_memory");
      expect(retLayers[0].id).toBe("retrieval_ret_high");
      expect(retLayers[1].id).toBe("retrieval_ret_low");
    });
  });

  describe("tool instructions", () => {
    it("includes tool_instructions layer when provided", () => {
      const result = assemblePrompt(baseContext({
        toolInstructions: "Use the search tool when needed.",
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
      const result = assemblePrompt(baseContext({ recentMessages: [] }));
      const hist = result.layers.find((l) => l.id === "recent_history");
      expect(hist).toBeUndefined();
    });
  });

  describe("layer ordering", () => {
    it("layers are sorted by position then priority descending", () => {
      const result = assemblePrompt(baseContext({
        systemPreset: { id: "p1", text: "Preset." },
        activeLoreEntries: [
          { id: "l1", title: "Lore", content: "Lore text.", priority: 10 },
        ],
      }));
      const ids = result.layers.map((l) => l.id);
      const presetIdx = ids.indexOf("system_preset");
      const baseIdx = ids.indexOf("character_base");
      const loreIdx = ids.indexOf("lore_l1");
      const histIdx = ids.indexOf("recent_history");
      expect(presetIdx).toBeLessThan(baseIdx);
      expect(baseIdx).toBeLessThan(loreIdx);
      expect(histIdx).toBeLessThan(loreIdx);
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
        activeLoreEntries: [
          { id: "l1", title: "T", content: "C.", priority: 5 },
          { id: "l2", title: "T", content: "C.", priority: 5 },
        ],
      }));
      expect(result.activatedLoreEntries).toEqual(["l1", "l2"]);
    });

    it("usedMemoryBlocks combines summary and retrieval IDs", () => {
      const result = assemblePrompt(baseContext({
        summaryMemory: [{ id: "s1", kind: "chapter", summary: "text." }],
        retrievalMemory: [{ id: "r1", sourceType: "event", content: "text.", score: 0.5 }],
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
