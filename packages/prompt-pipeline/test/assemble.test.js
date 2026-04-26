import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
      assert.ok(base);
      assert.ok(base.text.includes("Character: Aria"));
      assert.ok(base.text.includes("A fire mage."));
      assert.ok(base.text.includes("Scenario: The tower burns."));
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
      assert.ok(sys);
      assert.strictEqual(sys.text, "You are a helpful assistant.");
    });

    it("omits character_system_prompt when null/empty", () => {
      const result = assemblePrompt(baseContext());
      const sys = result.layers.find((l) => l.id === "character_system_prompt");
      assert.strictEqual(sys, undefined);
    });

    it("omits scenario from character_base when not provided", () => {
      const result = assemblePrompt(baseContext({
        character: { id: "char_1", name: "Aria", description: "A mage." },
      }));
      const base = result.layers.find((l) => l.id === "character_base");
      assert.ok(base);
      assert.ok(!base.text.includes("Scenario"));
    });
  });

  describe("system preset", () => {
    it("includes system_preset layer when provided", () => {
      const result = assemblePrompt(baseContext({
        systemPreset: { id: "preset_1", text: "Global system instructions." },
      }));
      const preset = result.layers.find((l) => l.id === "system_preset");
      assert.ok(preset);
      assert.strictEqual(preset.text, "Global system instructions.");
      assert.strictEqual(preset.sourceType, "system_preset");
    });

    it("omits system_preset when not provided", () => {
      const result = assemblePrompt(baseContext());
      const preset = result.layers.find((l) => l.id === "system_preset");
      assert.strictEqual(preset, undefined);
    });
  });

  describe("persona", () => {
    it("includes persona layer when provided", () => {
      const result = assemblePrompt(baseContext({
        persona: { id: "persona_1", name: "Olya", description: "A scholar." },
      }));
      const persona = result.layers.find((l) => l.id === "persona");
      assert.ok(persona);
      assert.ok(persona.text.includes("User persona (Olya)"));
      assert.ok(persona.text.includes("A scholar."));
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
      assert.ok(lore);
      assert.ok(lore.text.includes("Lore: Dragons"));
      assert.ok(lore.text.includes("Fire-breathing creatures."));
    });

    it("drops lore entries with empty content", () => {
      const result = assemblePrompt(baseContext({
        activeLoreEntries: [
          { id: "lore_empty", title: "Empty", content: "   ", priority: 10 },
        ],
      }));
      const lore = result.layers.find((l) => l.id === "lore_lore_empty");
      assert.strictEqual(lore, undefined);
      assert.strictEqual(result.droppedLayers.length, 1);
      assert.strictEqual(result.droppedLayers[0].id, "lore_empty");
    });

    it("sorts lore entries by priority descending", () => {
      const result = assemblePrompt(baseContext({
        activeLoreEntries: [
          { id: "low", title: "Low", content: "Low priority.", priority: 5 },
          { id: "high", title: "High", content: "High priority.", priority: 50 },
        ],
      }));
      const loreLayers = result.layers.filter((l) => l.sourceType === "lore_entry");
      assert.strictEqual(loreLayers[0].id, "lore_high");
      assert.strictEqual(loreLayers[1].id, "lore_low");
    });

    it("passes lore position through to layer", () => {
      const result = assemblePrompt(baseContext({
        activeLoreEntries: [
          { id: "lore_pos", title: "T", content: "C.", priority: 10, position: "before_prompt" },
        ],
      }));
      const lore = result.layers.find((l) => l.id === "lore_lore_pos");
      assert.ok(lore);
      assert.strictEqual(lore.position, "before_prompt");
    });
  });

  describe("generation rules", () => {
    it("includes generation rules as layers", () => {
      const result = assemblePrompt(baseContext({
        generationRules: [
          { id: "rule_1", title: "Style", content: "Write in third person.", priority: 5 },
        ],
      }));
      const rule = result.layers.find((l) => l.id === "rule_rule_1");
      assert.ok(rule);
      assert.ok(rule.text.includes("Rule: Style"));
      assert.ok(rule.text.includes("Write in third person."));
    });

    it("drops generation rules with empty content", () => {
      const result = assemblePrompt(baseContext({
        generationRules: [
          { id: "rule_empty", title: "Empty", content: "", priority: 5 },
        ],
      }));
      const rule = result.layers.find((l) => l.id === "rule_rule_empty");
      assert.strictEqual(rule, undefined);
      assert.strictEqual(result.droppedLayers.length, 1);
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
      assert.ok(mem);
      assert.ok(mem.text.includes("[chapter]"));
      assert.ok(mem.text.includes("They met at the inn."));
    });

    it("includes retrieval memory layers sorted by score", () => {
      const result = assemblePrompt(baseContext({
        retrievalMemory: [
          { id: "ret_low", sourceType: "dialogue", content: "Low score.", score: 0.3 },
          { id: "ret_high", sourceType: "event", content: "High score.", score: 0.9 },
        ],
      }));
      const retLayers = result.layers.filter((l) => l.sourceType === "retrieval_memory");
      assert.strictEqual(retLayers[0].id, "retrieval_ret_high");
      assert.strictEqual(retLayers[1].id, "retrieval_ret_low");
    });
  });

  describe("tool instructions and output constraints", () => {
    it("includes tool_instructions layer when provided", () => {
      const result = assemblePrompt(baseContext({
        toolInstructions: "Use the search tool when needed.",
      }));
      const tool = result.layers.find((l) => l.id === "tool_instructions");
      assert.ok(tool);
      assert.strictEqual(tool.text, "Use the search tool when needed.");
    });

    it("includes output_constraints layer when provided", () => {
      const result = assemblePrompt(baseContext({
        outputConstraints: "Keep responses under 200 words.",
      }));
      const oc = result.layers.find((l) => l.id === "output_constraints");
      assert.ok(oc);
      assert.strictEqual(oc.text, "Keep responses under 200 words.");
    });
  });

  describe("chat history", () => {
    it("includes recent_history layer from messages", () => {
      const result = assemblePrompt(baseContext());
      const hist = result.layers.find((l) => l.id === "recent_history");
      assert.ok(hist);
      assert.ok(hist.text.includes("USER: Hello."));
      assert.ok(hist.text.includes("ASSISTANT: Hi there."));
    });

    it("omits recent_history when no messages", () => {
      const result = assemblePrompt(baseContext({ recentMessages: [] }));
      const hist = result.layers.find((l) => l.id === "recent_history");
      assert.strictEqual(hist, undefined);
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
      assert.ok(presetIdx < baseIdx, "system_preset (prio 1000) before character_base (prio 900)");
      assert.ok(baseIdx < loreIdx, "character_base (prio 900) before lore (prio 10)");
      assert.ok(histIdx < loreIdx, "history (prio 100) before lore (prio 10)");
    });
  });

  describe("finalPayload", () => {
    it("puts non-history layers as system messages, history as user/assistant", () => {
      const result = assemblePrompt(baseContext());
      const msgs = result.finalPayload.messages;
      const systemMsgs = msgs.filter((m) => m.role === "system");
      const chatMsgs = msgs.filter((m) => m.role !== "system");
      assert.ok(systemMsgs.length >= 1, "at least one system layer");
      assert.strictEqual(chatMsgs.length, 2);
      assert.strictEqual(chatMsgs[0].role, "user");
      assert.strictEqual(chatMsgs[0].content, "Hello.");
      assert.strictEqual(chatMsgs[1].role, "assistant");
      assert.strictEqual(chatMsgs[1].content, "Hi there.");
    });

    it("chat history messages carry messageId, layers carry layerId", () => {
      const result = assemblePrompt(baseContext());
      const msgs = result.finalPayload.messages;
      for (const m of msgs) {
        if (m.role === "system") {
          assert.ok(m.layerId, "system message has layerId");
        } else {
          assert.ok(m.messageId, "chat message has messageId");
        }
      }
    });
  });

  describe("result metadata", () => {
    it("totalTokenEstimate is sum of layer token counts", () => {
      const result = assemblePrompt(baseContext());
      const manualSum = result.layers.reduce((s, l) => s + l.tokenCount, 0);
      assert.strictEqual(result.totalTokenEstimate, manualSum);
    });

    it("activatedLoreEntries lists lore IDs", () => {
      const result = assemblePrompt(baseContext({
        activeLoreEntries: [
          { id: "l1", title: "T", content: "C.", priority: 5 },
          { id: "l2", title: "T", content: "C.", priority: 5 },
        ],
      }));
      assert.deepStrictEqual(result.activatedLoreEntries, ["l1", "l2"]);
    });

    it("usedMemoryBlocks combines summary and retrieval IDs", () => {
      const result = assemblePrompt(baseContext({
        summaryMemory: [{ id: "s1", kind: "chapter", summary: "text." }],
        retrievalMemory: [{ id: "r1", sourceType: "event", content: "text.", score: 0.5 }],
      }));
      assert.deepStrictEqual(result.usedMemoryBlocks, ["s1", "r1"]);
    });
  });

  describe("empty context", () => {
    it("produces minimal result with just character and history", () => {
      const result = assemblePrompt(baseContext());
      assert.ok(result.layers.length >= 2, "at least character_base + recent_history");
      assert.strictEqual(result.droppedLayers.length, 0);
    });
  });
});
