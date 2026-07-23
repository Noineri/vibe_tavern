import { describe, it, expect } from "bun:test";
import { assemblePrompt } from "../src/assemble.ts";
import { getAiAssistantAssembler } from "../src/ai-assistant/ai-assistant-assemblers.ts";
import { getSummaryStrategy } from "../src/summary/summary-strategies.ts";
import { setTokenCountFn } from "../src/compaction.ts";
import type { PromptAssemblyContext } from "../src/types.ts";
import { brandId, type DiceRollSnapshot, type DiceRollId, type MessageId } from "@vibe-tavern/domain";

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

    // ── at_depth: in-chat injection at a specific depth (TEST 5 from stress lorebook) ──

    it("places an at_depth lore entry into the chat at its configured depth", () => {
      // Ported from stress-test lorebook TEST 5: position at_depth + depth 2
      // means the lore layer is interleaved into chat history, not stacked
      // before/after it. assemble.ts:720 maps this to in_chat + injectionDepth.
      const result = assemblePrompt(baseContext({
        lore: [
          { id: "at_d2", title: "Depth", content: "Injected at depth 2.", priority: 10, position: "at_depth", depth: 2 },
        ],
      }));
      const lore = result.layers.find((l) => l.id === "lore_at_d2");
      expect(lore).toBeTruthy();
      expect(lore.position).toBe("in_chat");
      expect(lore.injectionDepth).toBe(2);
    });

    it("defaults at_depth injection to depth 4 when the entry omits depth (ST default)", () => {
      // assemble.ts:721 — `loreEntry.depth ?? 4` matches the SillyTavern default.
      const result = assemblePrompt(baseContext({
        lore: [
          { id: "at_default", title: "Depth", content: "No depth set.", priority: 10, position: "at_depth" },
        ],
      }));
      const lore = result.layers.find((l) => l.id === "lore_at_default");
      expect(lore).toBeTruthy();
      expect(lore.position).toBe("in_chat");
      expect(lore.injectionDepth).toBe(4);
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

  // ─── Wave B5 / DICE-B13: Dice prompt projection ───────────────────
  //
  // The pipeline derives effective message content ONCE (macro-resolved prose
  // + compact Dice block) so Dice text is token-counted before compaction,
  // trace-visible in the history layer, and present in the final payload
  // exactly once — without mutating visible prose. Absence (no diceRolls) is
  // a byte-for-byte no-op.
  describe("Dice prompt projection (Wave B5 / DICE-B13)", () => {
    function makeRoll(overrides: Partial<DiceRollSnapshot> = {}): DiceRollSnapshot {
      return {
        rollId: brandId<DiceRollId>("roll_1"),
        requestId: "req_1",
        actor: { actorType: "character", actorId: "char_1", actorLabel: "Theron" },
        scriptId: "script_1",
        scriptLabel: "Combat",
        scriptRevision: 1,
        checkId: "check_1",
        checkLabel: "Stealth Check",
        notation: "2d6+1",
        faceShape: "d6",
        resolution: "strict",
        mode: "normal",
        included: true,
        finalAttemptId: "att_1",
        attempts: [
          { attemptId: "att_1", faces: [3, 5], modifier: 1, subtotal: 8, total: 9 },
        ],
        final: { total: 9, outcome: "success", degree: "hard", constraint: "must remain unseen" },
        boundMessageId: brandId<MessageId>("msg_1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
      };
    }

    it("absence of diceRolls is byte-for-byte no-op (identical payload)", () => {
      const noDice = assemblePrompt(baseContext());
      const emptyDice = assemblePrompt(baseContext({
        chat: {
          recentMessages: [
            { id: "msg_1", role: "user", content: "Hello.", diceRolls: [] },
            { id: "msg_2", role: "assistant", content: "Hi there." },
          ],
        },
      }));
      expect(JSON.stringify(emptyDice.finalPayload)).toBe(JSON.stringify(noDice.finalPayload));
      expect(JSON.stringify(emptyDice.layers)).toBe(JSON.stringify(noDice.layers));
    });

    it("projects a strict roll block into the user message in the final payload", () => {
      const result = assemblePrompt(baseContext({
        chat: {
          recentMessages: [
            { id: "msg_1", role: "user", content: "I sneak past the guards.", diceRolls: [makeRoll()] },
            { id: "msg_2", role: "assistant", content: "..." },
          ],
        },
      }));
      const userMsg = result.finalPayload.messages.find((m) => m.messageId === "msg_1");
      expect(userMsg).toBeDefined();
      expect(userMsg!.content).toContain("I sneak past the guards.");
      expect(userMsg!.content).toContain("[Dice]");
      expect(userMsg!.content).toContain("Stealth Check");
      expect(userMsg!.content).toContain("Adjudication: success (hard).");
      expect(userMsg!.content).toContain("Binding constraint: must remain unseen.");
    });

    it("omits adjudication for narrative rolls (mechanical facts only)", () => {
      const narrativeRoll = makeRoll({
        checkLabel: "Athletics",
        notation: "d20",
        faceShape: "d20",
        resolution: "narrative",
        attempts: [{ attemptId: "att_1", faces: [14], modifier: 0, subtotal: 14, total: 14 }],
        final: undefined,
      });
      const result = assemblePrompt(baseContext({
        chat: {
          recentMessages: [
            { id: "msg_1", role: "user", content: "I leap the gap.", diceRolls: [narrativeRoll] },
            { id: "msg_2", role: "assistant", content: "..." },
          ],
        },
      }));
      const userMsg = result.finalPayload.messages.find((m) => m.messageId === "msg_1");
      expect(userMsg!.content).toContain("[Dice]");
      expect(userMsg!.content).toContain("Athletics");
      expect(userMsg!.content).toContain("[14] = 14");
      expect(userMsg!.content).not.toContain("Adjudication");
      expect(userMsg!.content).not.toContain("Binding constraint");
    });

    it("projects multiple checks on one message in order", () => {
      const result = assemblePrompt(baseContext({
        chat: {
          recentMessages: [
            {
              id: "msg_1",
              role: "user",
              content: "I attack and hide.",
              diceRolls: [
                makeRoll({ checkLabel: "Attack", notation: "d20+3", attempts: [{ attemptId: "att_1", faces: [12], modifier: 3, subtotal: 12, total: 15 }] }),
                makeRoll({ checkLabel: "Stealth Check" }),
              ],
            },
            { id: "msg_2", role: "assistant", content: "..." },
          ],
        },
      }));
      const userMsg = result.finalPayload.messages.find((m) => m.messageId === "msg_1");
      const content = userMsg!.content;
      const attackIdx = content.indexOf("Attack");
      const stealthIdx = content.indexOf("Stealth Check");
      expect(attackIdx).toBeGreaterThan(-1);
      expect(stealthIdx).toBeGreaterThan(-1);
      expect(attackIdx).toBeLessThan(stealthIdx);
    });

    it("appends the Dice block exactly once (not duplicated in the payload)", () => {
      const result = assemblePrompt(baseContext({
        chat: {
          recentMessages: [
            { id: "msg_1", role: "user", content: "Sneak.", diceRolls: [makeRoll()] },
            { id: "msg_2", role: "assistant", content: "..." },
          ],
        },
      }));
      const payloadStr = JSON.stringify(result.finalPayload);
      const blockCount = (payloadStr.match(/\[Dice\]/g) ?? []).length;
      expect(blockCount).toBe(1);
    });

    it("Dice block participates in the history layer text (trace-visible)", () => {
      const result = assemblePrompt(baseContext({
        chat: {
          recentMessages: [
            { id: "msg_1", role: "user", content: "Sneak.", diceRolls: [makeRoll()] },
            { id: "msg_2", role: "assistant", content: "..." },
          ],
        },
      }));
      const hist = result.layers.find((l) => l.id === "recent_history");
      expect(hist).toBeTruthy();
      expect(hist!.text).toContain("[Dice]");
      expect(hist!.text).toContain("Stealth Check");
    });

    it("Dice text is fully token-counted before compaction (not undercounted)", () => {
      // Use char-length token counting so we can reason about budgets precisely.
      setTokenCountFn((text) => text.length);

      const withoutDice = assemblePrompt(baseContext({
        chat: {
          recentMessages: [
            { id: "msg_1", role: "user", content: "I sneak past the guards." },
            { id: "msg_2", role: "assistant", content: "..." },
          ],
        },
      }));
      const withDice = assemblePrompt(baseContext({
        chat: {
          recentMessages: [
            { id: "msg_1", role: "user", content: "I sneak past the guards.", diceRolls: [makeRoll()] },
            { id: "msg_2", role: "assistant", content: "..." },
          ],
        },
      }));

      // The Dice block adds tokens to the history layer — it must be counted.
      const histWithout = withoutDice.layers.find((l) => l.id === "recent_history");
      const histWith = withDice.layers.find((l) => l.id === "recent_history");
      expect(histWith!.tokenCount).toBeGreaterThan(histWithout!.tokenCount);

      // Reset the global token fn so other tests are unaffected.
      setTokenCountFn(() => 0);
    });

    it("low-budget compaction accounts for Dice text (keeps recent pair, drops old)", () => {
      setTokenCountFn((text) => text.length);

      const messages = [
        { id: "old_1", role: "user" as const, content: "A".repeat(100) },
        { id: "old_2", role: "assistant" as const, content: "B".repeat(100) },
        {
          id: "msg_3",
          role: "user" as const,
          content: "I sneak.",
          diceRolls: [makeRoll()],
        },
        { id: "msg_4", role: "assistant" as const, content: "C" },
      ];

      // Budget tight enough to trigger compaction. The Dice block on msg_3
      // adds ~100 chars of text; if it were undercounted, the budget calc
      // would be wrong. The compaction summary must exist and the recent
      // pair (msg_3 with Dice + msg_4) must survive.
      const unbounded = assemblePrompt(baseContext({ chat: { recentMessages: messages } }));
      const result = assemblePrompt(baseContext({
        chat: { recentMessages: messages },
        config: { contextBudget: unbounded.totalTokenEstimate - 50 },
      }));

      expect(result.compactionSummary).toBeDefined();
      const hist = result.layers.find((l) => l.id === "recent_history");
      expect(hist!.text).toContain("[Dice]");
      expect(hist!.text).toContain("Stealth Check");
      expect(hist!.text).not.toContain("A".repeat(50));

      setTokenCountFn(() => 0);
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

  // ─── Wave B: same-depth inject ordering + jailbreak label ────────────
  //
  // Two custom injections sharing a depth must emit in canvas (ascending
  // `order`) order. Historically the same-depth tiebreaker sorted DESCENDING
  // to compensate for a (wrongly assumed) fixed splice index — but the
  // index is recomputed as history grows, so the compensation inverted the
  // payload. The jailbreak layer was also labeled with the preset's name
  // instead of the honest "Post-History Instructions".
  describe("assembly registry characterization (AR-1a)", () => {
    const characterSystem = { id: "character_system_prompt", text: "Character system.", position: "in_prompt" };
    const persona = { id: "persona", text: "User persona (Alex, they/them): Journalist.", position: "in_prompt" };
    const characterBase = { id: "character_base", text: "Character: Nora\nDetective.", position: "in_prompt" };
    const recentHistory = { id: "recent_history", text: "USER: Where is the file?\n\nASSISTANT: In the drawer.", position: "in_prompt" };
    const historyMessages = [
      { role: "user", content: "Where is the file?", messageId: "msg_mode_1" },
      { role: "assistant", content: "In the drawer.", messageId: "msg_mode_2" },
    ];

    function registryContext() {
      return {
        identity: { chatId: "chat_mode" },
        character: { id: "char_mode", name: "Nora", description: "Detective.", systemPrompt: "Character system." },
        persona: { id: "persona_mode", name: "Alex", description: "Journalist.", pronouns: "they/them" },
        preset: { id: "preset_mode", name: "Mode preset", summary: "Summarize the case." },
        instructions: { toolInstructions: "Tool instruction." },
        chat: {
          recentMessages: [
            { id: "msg_mode_1", role: "user", content: "Where is the file?" },
            { id: "msg_mode_2", role: "assistant", content: "In the drawer." },
          ],
        },
        aiAssistant: {
          mode: "script" as const,
          enabledLayers: ["character_base", "persona"],
          systemPrompt: "Assistant system.",
          instruction: "Write a helper.",
        },
      };
    }

    function projectAssembly(result: ReturnType<typeof assemblePrompt>) {
      return {
        layers: result.layers.map(({ id, text, position, role }) => ({ id, text, position, ...(role ? { role } : {}) })),
        messages: result.finalPayload.messages,
      };
    }

    const chatExpected = {
      layers: [characterSystem, persona, characterBase, recentHistory, { id: "tool_instructions", text: "Tool instruction.", position: "in_prompt" }],
      messages: [
        { role: "system", content: "Character system.", layerId: "character_system_prompt" },
        { role: "system", content: "User persona (Alex, they/them): Journalist.", layerId: "persona" },
        { role: "system", content: "Character: Nora\nDetective.", layerId: "character_base" },
        { role: "system", content: "Tool instruction.", layerId: "tool_instructions" },
        ...historyMessages,
      ],
    };

    it("pins the complete chat assembly under both simple and canvas resolvers", () => {
      expect(projectAssembly(assemblePrompt(registryContext()))).toEqual(chatExpected);
      expect(projectAssembly(assemblePrompt({
        ...registryContext(),
        preset: { ...registryContext().preset, advancedMode: true, promptOrder: [] },
      }))).toEqual(chatExpected);
    });

    it("pins the summary assembly", () => {
      expect(projectAssembly(getSummaryStrategy().assemble(registryContext()))).toEqual({
        layers: [
          characterSystem,
          persona,
          characterBase,
          recentHistory,
          { id: "prompt_preset_summary", text: "Summarize the case.", position: "in_prompt" },
        ],
        messages: [
          { role: "system", content: "Character system.", layerId: "character_system_prompt" },
          { role: "system", content: "User persona (Alex, they/them): Journalist.", layerId: "persona" },
          { role: "system", content: "Character: Nora\nDetective.", layerId: "character_base" },
          { role: "system", content: "Summarize the case.", layerId: "prompt_preset_summary" },
          ...historyMessages,
        ],
      });
    });

    it("pins the AI assistant assembly", () => {
      expect(projectAssembly(getAiAssistantAssembler("script").assemble(registryContext()))).toEqual({
        layers: [
          { id: "ai_assistant_system", text: "Assistant system.", position: "in_prompt" },
          characterBase,
          persona,
          { id: "ai_assistant_instruction", text: "Write a helper.", position: "in_prompt" },
        ],
        messages: [
          { role: "system", content: "Assistant system.", layerId: "ai_assistant_system" },
          { role: "system", content: "Character: Nora\nDetective.", layerId: "character_base" },
          { role: "system", content: "User persona (Alex, they/them): Journalist.", layerId: "persona" },
          { role: "user", content: "Write a helper.", layerId: "ai_assistant_instruction" },
        ],
      });
    });

  });

  describe("same-depth inject order + jailbreak label (Wave B)", () => {
    function twoInjectionContext(zone: "after_chat" | "in_chat", depth: number | null) {
      return {
        identity: { chatId: "chat_1" },
        chat: {
          recentMessages: [
            { id: "m1", role: "user", content: "first" },
            { id: "m2", role: "assistant", content: "second" },
          ],
        },
        character: { id: "char_1", name: "Aria", description: "mage", scenario: "tower", systemPrompt: null },
        preset: {
          id: "preset_1",
          name: "Charming",
          text: "sys",
          advancedMode: true,
          customInjections: [
            { identifier: "injA", name: "Inject A", content: "AAA_MARKER", role: "system" },
            { identifier: "injB", name: "Inject B", content: "BBB_MARKER", role: "system" },
          ],
          promptOrder: [
            { identifier: "injA", enabled: true, zone, depth, order: 10, kind: "custom" as const },
            { identifier: "injB", enabled: true, zone, depth, order: 20, kind: "custom" as const },
          ],
        },
      };
    }

    it("emits same-depth after_chat injects in ascending canvas order", () => {
      const result = assemblePrompt(twoInjectionContext("after_chat", null));
      const order = result.finalPayload.messages
        .map((m) => m.layerId)
        .filter((id) => id === "preset_injection_injA" || id === "preset_injection_injB");
      // Fixed: canvas order injA(10) → injB(20) is preserved in the payload.
      expect(order).toEqual(["preset_injection_injA", "preset_injection_injB"]);
    });

    it("emits same-depth in_chat injects in ascending canvas order", () => {
      const result = assemblePrompt(twoInjectionContext("in_chat", 1));
      const order = result.finalPayload.messages
        .map((m) => m.layerId)
        .filter((id) => id === "preset_injection_injA" || id === "preset_injection_injB");
      // Fixed: canvas order injA(10) → injB(20) is preserved in the payload.
      expect(order).toEqual(["preset_injection_injA", "preset_injection_injB"]);
    });

    it("labels a preset-sourced jailbreak as 'Post-History Instructions'", () => {
      const result = assemblePrompt({
        identity: { chatId: "chat_1" },
        chat: { recentMessages: [{ id: "m1", role: "user", content: "x" }] },
        character: { id: "char_1", name: "Aria", description: "mage", scenario: "tower", systemPrompt: null, postHistoryInstructions: null },
        preset: { id: "preset_1", name: "Charming", text: "sys", jailbreak: "JB_CONTENT", advancedMode: false },
      });
      const jailbreak = result.layers.find((l) => l.id === "prompt_preset_jailbreak");
      expect(jailbreak).toBeTruthy();
      // Fixed: honest field name, not the preset's display name.
      expect(jailbreak!.sourceName).toBe("Post-History Instructions");
    });

    it("still labels a character-override jailbreak with the character name", () => {
      const result = assemblePrompt({
        identity: { chatId: "chat_1" },
        chat: { recentMessages: [{ id: "m1", role: "user", content: "x" }] },
        character: { id: "char_1", name: "Aria", description: "mage", scenario: "tower", systemPrompt: null, postHistoryInstructions: "CHAR_OVERRIDE_JB" },
        preset: { id: "preset_1", name: "Charming", text: "sys", advancedMode: false },
      });
      const jailbreak = result.layers.find((l) => l.id === "prompt_preset_jailbreak");
      expect(jailbreak).toBeTruthy();
      // Override branch is unchanged: labeled with the character's name.
      expect(jailbreak!.sourceName).toBe("Aria (Post-History Override)");
    });
  });

  // ─── SUMMARY_PRIOR_CONTEXT_PLAN W1 (SPC-1) ─────────────────────────
  //
  // Characterization net for the summary path WITHOUT priorSummaries. The
  // `prior_summaries_context` layer (added in SPC-2) is gated on non-empty
  // priors, so a summary context that omits them still emits exactly the 11
  // pre-SPC-2 layer ids. This manifest is the regression net for "no priors →
  // no prior-context layer", and also documents that the summary filter is
  // strict (drops jailbreak / authorsNote) where the chat-turn path keeps them.
  describe("summary layer membership characterization (SPC-1)", () => {
    function richSummaryContext(): PromptAssemblyContext {
      return {
        identity: { chatId: "chat_spc" },
        character: {
          id: "char_spc",
          name: "Nora",
          description: "Detective.",
          scenario: "The tower burns.",
          systemPrompt: "You are Nora.",
          personality: "Stoic.",
          mesExample: "<START>\n{{user}}: hi\n{{char}}: hello",
          mesExampleMode: "always",
          avatarDescription: "Raven hair, grey coat.",
          includeAvatarInPrompt: true,
          gallery: [{ caption: "badge", description: "A brass badge." }],
          includeGalleryInPrompt: true,
          postHistoryInstructions: "Stay in character.",
        },
        persona: {
          id: "persona_spc",
          name: "Alex",
          description: "Journalist.",
          pronouns: "they/them",
          avatarDescription: "Trench coat.",
          includeAvatarInPrompt: true,
        },
        preset: {
          id: "preset_spc",
          text: "Global sys.",
          summary: "Summarize the case.",
          jailbreak: "JB.",
          authorsNote: "Note.",
          authorsNotePosition: "in_prompt",
        },
        chat: {
          recentMessages: [
            { id: "m1", role: "user", content: "Where is the file?" },
            { id: "m2", role: "assistant", content: "In the drawer." },
          ],
        },
      };
    }

    // The exact membership of SUMMARY_LAYER_IDS. When W2 adds
    // `prior_summaries_context` to this set, update this manifest in the same
    // change — that is the intended, visible delta this pin exists to force.
    const SUMMARY_LAYER_MANIFEST = new Set([
      "prompt_preset_summary",
      "character_system_prompt",
      "character_base",
      "character_scenario",
      "character_personality",
      "character_avatar",
      "character_gallery",
      "persona",
      "persona_avatar",
      "mes_example",
      "recent_history",
    ]);

    it("emits exactly the 11 pre-SPC-2 summary layers when priorSummaries is absent", () => {
      const result = getSummaryStrategy().assemble(richSummaryContext());
      expect(new Set(result.layers.map((l) => l.id))).toEqual(SUMMARY_LAYER_MANIFEST);
    });

    it("does not emit prior_summaries_context when priorSummaries is absent", () => {
      const result = getSummaryStrategy().assemble(richSummaryContext());
      expect(result.layers.find((l) => l.id === "prior_summaries_context")).toBeUndefined();
    });

    it("filters out jailbreak and authorsNote from the summary path", () => {
      const result = getSummaryStrategy().assemble(richSummaryContext());
      expect(result.layers.find((l) => l.id === "prompt_preset_jailbreak")).toBeUndefined();
      expect(result.layers.find((l) => l.id === "prompt_preset_authors_note")).toBeUndefined();
    });

    it("keeps jailbreak and authorsNote on the chat-turn path (summary filter is summary-only)", () => {
      const result = assemblePrompt(richSummaryContext());
      expect(result.layers.find((l) => l.id === "prompt_preset_jailbreak")).toBeTruthy();
      expect(result.layers.find((l) => l.id === "prompt_preset_authors_note")).toBeTruthy();
    });
  });

  // ─── SUMMARY_PRIOR_CONTEXT_PLAN W2 (SPC-2): prior_summaries_context layer ──
  //
  // Isolated pins for the new read-only continuity layer. It is emitted ONLY
  // under `config.summary` (the summary path) with non-empty `priorSummaries`.
  // The chat-turn path is immune even if a caller accidentally sets priors,
  // because the gate checks `config.summary` (assemblePrompt never sets it).
  describe("prior_summaries_context layer (SPC-2)", () => {
    function contextWithPriors(overrides: Partial<PromptAssemblyContext> = {}): PromptAssemblyContext {
      return {
        identity: { chatId: "chat_spc2" },
        character: { id: "char_spc2", name: "Aria", description: "A mage." },
        preset: { id: "preset_spc2", text: "", summary: "Summarize the case." },
        chat: {
          recentMessages: [
            { id: "m1", role: "user", content: "Hi." },
            { id: "m2", role: "assistant", content: "Hello." },
          ],
        },
        config: { summary: true },
        priorSummaries: [
          { id: "prior_1", label: "Chapter 1", content: "They met at the inn." },
          { id: "prior_2", label: "Chapter 2", content: "They fought the boss." },
        ],
        ...overrides,
      };
    }

    it("emits a prior_summaries_context layer when config.summary is on and priors are present", () => {
      const result = getSummaryStrategy().assemble(contextWithPriors());
      const layer = result.layers.find((l) => l.id === "prior_summaries_context");
      expect(layer).toBeTruthy();
      expect(layer!.position).toBe("in_prompt");
      expect(layer!.sourceType).toBe("prior_summaries");
    });

    it("frames the block as read-only continuity (no re-summarize) and lists priors oldest→newest with labels", () => {
      const result = getSummaryStrategy().assemble(contextWithPriors());
      const layer = result.layers.find((l) => l.id === "prior_summaries_context")!;
      expect(layer.text).toContain("[Prior summaries — read-only continuity");
      expect(layer.text).toContain("Do NOT repeat or re-summarize");
      // oldest→newest order preserved (caller hands them in that order)
      const ch1 = layer.text.indexOf("Chapter 1");
      const ch2 = layer.text.indexOf("Chapter 2");
      expect(ch1).toBeGreaterThan(-1);
      expect(ch1).toBeLessThan(ch2);
      expect(layer.text).toContain("They met at the inn.");
      expect(layer.text).toContain("They fought the boss.");
    });

    it("includes prior_summaries_context alongside the other summary layers", () => {
      const result = getSummaryStrategy().assemble(contextWithPriors());
      expect(new Set(result.layers.map((l) => l.id))).toEqual(new Set([
        "character_base",
        "recent_history",
        "prompt_preset_summary",
        "prior_summaries_context",
      ]));
    });

    it("does NOT emit the layer on the chat-turn path even if priorSummaries is set (config.summary gate)", () => {
      // assemblePrompt does not force config.summary=true (only assembleSummaryPrompt does),
      // so the gate is false and the layer is absent regardless of priorSummaries.
      const result = assemblePrompt(contextWithPriors({ config: { summary: false } }));
      expect(result.layers.find((l) => l.id === "prior_summaries_context")).toBeUndefined();
    });

    it("does NOT emit the layer when priorSummaries is empty", () => {
      const result = getSummaryStrategy().assemble(contextWithPriors({ priorSummaries: [] }));
      expect(result.layers.find((l) => l.id === "prior_summaries_context")).toBeUndefined();
    });

    it("falls back to 'Prior summary' label when label is absent", () => {
      const result = getSummaryStrategy().assemble(contextWithPriors({
        priorSummaries: [{ id: "p", content: "No label body." }],
      }));
      const layer = result.layers.find((l) => l.id === "prior_summaries_context")!;
      expect(layer.text).toContain("Prior summary:\nNo label body.");
    });
  });
});
