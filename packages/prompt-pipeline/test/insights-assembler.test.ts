/**
 * InsightsAssembler registry + assembly (INSIGHTS_PLAN INS-3c).
 *
 * Two layers:
 *  1. MANIFEST — every `InsightsKind` resolves via `getInsightsAssembler`, and
 *     the registry's `satisfies Record<InsightsKind, InsightsAssembler>` guard
 *     is reflected in its key set (so adding a kind without registering is a
 *     compile error, not a silent hole).
 *  2. BEHAVIOR — the assembler builds the recent window as REAL role-tagged
 *     turns + the instruction as the FINAL user message, with NO RP stack (no
 *     character / lore / authorsNote / the insight layers themselves). This is
 *     the boundary `withObjectiveInstructionAsFinalUserMessage` used to pin at
 *     the service level (INS-3b) — relocated here because the assembler now
 *     owns it (the service just passes the resolved instruction string).
 *
 * Pure pipeline test: no DB, no LLM, no I/O.
 */
import { describe, expect, it } from "bun:test";
import { getInsightsAssembler, INSIGHTS_ASSEMBLERS } from "../src/insights/insights-assemblers.ts";
import type { InsightsKind } from "../src/insights/insights-assembler.ts";

function messagesOf(result: ReturnType<ReturnType<typeof getInsightsAssembler>["assemble"]>) {
  return result.finalPayload.messages as Array<{ role: string; content: string }>;
}

describe("InsightsAssembler registry (INS-3c manifest)", () => {
  it("registers an assembler for every InsightsKind (no silent holes)", () => {
    const kinds: InsightsKind[] = ["objective", "scene"];
    for (const kind of kinds) {
      expect(INSIGHTS_ASSEMBLERS[kind]).toBeDefined();
      expect(getInsightsAssembler(kind)).toBe(INSIGHTS_ASSEMBLERS[kind]);
    }
  });

  it("both kinds currently share the DefaultInsightsAssembler", () => {
    expect(INSIGHTS_ASSEMBLERS.objective).toBe(INSIGHTS_ASSEMBLERS.scene);
  });
});

describe("assembleInsights (INS-3c behavior)", () => {
  it("emits the recent window as real role-tagged turns + the instruction as the final user message", () => {
    const result = getInsightsAssembler("objective").assemble({
      kind: "objective",
      recentMessages: [
        { role: "user", content: "I draw my sword." },
        { role: "assistant", content: "The warlord sneers." },
      ],
      instruction: "Is the active task done? Reply DONE or PENDING.",
    });
    const msgs = messagesOf(result);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual({ role: "user", content: "I draw my sword." });
    expect(msgs[1]).toEqual({ role: "assistant", content: "The warlord sneers." });
    expect(msgs[2]).toEqual({ role: "user", content: "Is the active task done? Reply DONE or PENDING." });
  });

  it("never includes any RP-stack layer (no character / lore / authorsNote / insight layers)", () => {
    const rpIds = new Set([
      "character_base", "character_personality", "character_scenario", "character_system_prompt",
      "persona", "lore_entry", "authors_note", "objective_task", "scene_state",
    ]);
    const result = getInsightsAssembler("scene").assemble({
      kind: "scene",
      recentMessages: [{ role: "user", content: "We enter the tavern." }],
      instruction: "Produce the scene JSON.",
    });
    for (const layer of result.layers) {
      expect(rpIds.has(layer.id)).toBe(false);
      expect(layer.sourceType).toBe("insights"); // only insights-source layers
    }
    expect(result.layers.map((l) => l.id).sort()).toEqual(["insights_context", "insights_instruction"]);
  });

  it("drops empty turns so they never produce blank messages", () => {
    const result = getInsightsAssembler("objective").assemble({
      kind: "objective",
      recentMessages: [
        { role: "user", content: "   " },
        { role: "assistant", content: "Real reply." },
      ],
      instruction: "Check.",
    });
    const msgs = messagesOf(result);
    expect(msgs).toEqual([
      { role: "assistant", content: "Real reply." },
      { role: "user", content: "Check." },
    ]);
  });

  it("still emits the instruction as the final user message when the window is empty", () => {
    const result = getInsightsAssembler("objective").assemble({
      kind: "objective",
      recentMessages: [],
      instruction: "Break this objective into tasks.",
    });
    const msgs = messagesOf(result);
    expect(msgs).toEqual([{ role: "user", content: "Break this objective into tasks." }]);
    // No context layer when the window is empty; only the instruction layer.
    expect(result.layers.map((l) => l.id)).toEqual(["insights_instruction"]);
  });

  it("emits no instruction message/layer when the instruction is blank", () => {
    const result = getInsightsAssembler("scene").assemble({
      kind: "scene",
      recentMessages: [{ role: "user", content: "Hello." }],
      instruction: "   ",
    });
    expect(messagesOf(result)).toEqual([{ role: "user", content: "Hello." }]);
    expect(result.layers.map((l) => l.id)).toEqual(["insights_context"]);
  });

  it("returns a clean PromptAssemblyResult (empty lore/memory, no dropped layers, null prefill)", () => {
    const result = getInsightsAssembler("objective").assemble({
      kind: "objective",
      recentMessages: [{ role: "user", content: "Hi." }],
      instruction: "Do it.",
    });
    expect(result.activatedLoreEntries).toEqual([]);
    expect(result.usedMemoryBlocks).toEqual([]);
    expect(result.droppedLayers).toEqual([]);
    expect(result.prefill).toBeNull();
    expect(result.compactionSummary).toBeNull();
    expect(result.layers.length).toBeGreaterThan(0);
  });
});
