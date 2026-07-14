/**
 * InsightsAssembler registry + assembly (INSIGHTS_PLAN INS-3c).
 *
 * Two layers:
 *  1. MANIFEST — every `InsightsKind` resolves via `getInsightsAssembler`, and
 *     the registry's `satisfies Record<InsightsKind, InsightsAssembler>` guard
 *     is reflected in its key set (so adding a kind without registering is a
 *     compile error, not a silent hole).
 *  2. BEHAVIOR — the insight prompt is the chat's full RP world context
 *     (character / persona / activated lorebook / recent window) PLUS the
 *     instruction as the final user message, with the insight self-injection
 *     layers (`objectiveTask` / `sceneState`) stripped (they would duplicate the
 *     instruction / add scene noise to the model judging them). `mes_example`
 *     follows the chat's own toggle (resolver / `mesExampleMode`) — no
 *     insight-specific visibility policy.
 *
 * Pure pipeline test: no DB, no LLM, no I/O.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { getInsightsAssembler, INSIGHTS_ASSEMBLERS } from "../src/insights/insights-assemblers.ts";
import { setTokenCountFn } from "../src/compaction.ts";
import type { PromptAssemblyContext, InsightsKind } from "../src/types.ts";

function messagesOf(result: ReturnType<ReturnType<typeof getInsightsAssembler>["assemble"]>) {
  return result.finalPayload.messages as Array<{ role: string; content: string; layerId?: string }>;
}

beforeEach(() => {
  setTokenCountFn((text) => text.length);
});

function makeContext(overrides: Partial<PromptAssemblyContext> = {}): PromptAssemblyContext {
  return {
    identity: { chatId: "chat_1" },
    character: {
      id: "char_1",
      name: "Aria",
      description: "A fire mage.",
      personality: "Bold.",
      scenario: "A burning tower.",
      mesExample: "[Example]\nAria: Feel my fire!",
    },
    persona: { id: "persona_1", name: "Mira", description: "A scholar." },
    lore: [{ id: "lore_1", title: "Ember", content: "Fire magic is forbidden.", priority: 100 }],
    chat: {
      recentMessages: [
        { id: "m1", role: "user", content: "I draw my sword." },
        { id: "m2", role: "assistant", content: "The warlord sneers." },
      ],
    },
    ...overrides,
  } as PromptAssemblyContext;
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
  it("includes the RP world context the main model sees (character / persona / lore)", () => {
    const result = getInsightsAssembler("objective").assemble(makeContext(), "Is the task done?");
    const ids = result.layers.map((l) => l.id);
    expect(ids).toContain("character_base");
    expect(ids).toContain("persona");
    expect(ids.some((id) => id.startsWith("lore_"))).toBe(true);
  });

  it("appends the instruction as the FINAL user message after the recent window", () => {
    const result = getInsightsAssembler("scene").assemble(makeContext({
      character: {
        ...makeContext().character,
        postHistoryInstructions: "Continue the roleplay.",
      },
      chat: {
        ...makeContext().chat,
        scriptInjections: [{ role: "system", content: "Script depth-zero injection." }],
      },
    }), "Produce the scene JSON.");
    const msgs = messagesOf(result);
    expect(msgs.at(-1)).toEqual({ role: "user", content: "Produce the scene JSON.", layerId: "insights_instruction" });
    // The recent window and other depth-zero injections remain before the instruction.
    expect(msgs.some((m) => m.content === "I draw my sword." && m.role === "user")).toBe(true);
    expect(msgs.some((m) => m.content === "The warlord sneers." && m.role === "assistant")).toBe(true);
    expect(msgs.findIndex((m) => m.content === "Continue the roleplay.")).toBeLessThan(msgs.length - 1);
    expect(msgs.findIndex((m) => m.content === "Script depth-zero injection.")).toBeLessThan(msgs.length - 1);
  });

  it("budgets a long instruction before compaction and reports truthful layer tokens", () => {
    const recentMessages = Array.from({ length: 8 }, (_, index) => ({
      id: `m${index + 1}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `History turn ${index + 1}: ${"h".repeat(40)}`,
    }));
    const context = makeContext({ chat: { recentMessages } });
    const shortInstruction = "Check.";
    const shortUnbounded = getInsightsAssembler("objective").assemble(context, shortInstruction);
    const contextBudget = shortUnbounded.totalTokenEstimate;
    const shortBounded = getInsightsAssembler("objective").assemble({
      ...context,
      config: { contextBudget },
    }, shortInstruction);
    const longBounded = getInsightsAssembler("scene").assemble({
      ...context,
      config: { contextBudget },
    }, `Produce JSON using this schema: ${"s".repeat(180)}`);

    expect(shortBounded.compactionSummary).toBeNull();
    expect(longBounded.compactionSummary).not.toBeNull();
    expect(longBounded.layers.find((layer) => layer.id === "insights_instruction")).toMatchObject({
      role: "user",
      position: "in_chat",
      injectionDepth: 0,
    });
    expect(longBounded.totalTokenEstimate).toBe(
      longBounded.layers.reduce((sum, layer) => sum + layer.tokenCount, 0),
    );
    expect(longBounded.totalTokenEstimate).toBeLessThanOrEqual(contextBudget);
    expect(messagesOf(longBounded).at(-1)?.layerId).toBe("insights_instruction");
  });

  it("strips the insight self-injection layers even when the context carries them (no duplication/noise)", () => {
    const ctx = makeContext({
      objectiveTask: { description: "Pick the lock", injectPrompt: "", injectionDepth: 1 },
      sceneState: { text: "Tavern, dusk" },
    });
    const result = getInsightsAssembler("objective").assemble(ctx, "Is the active task done?");
    const ids = result.layers.map((l) => l.id);
    expect(ids).not.toContain("objective_task");
    expect(ids).not.toContain("scene_state");
  });

  it("mes_example follows the chat's toggle — included by default, absent when mesExampleMode=disabled", () => {
    const on = getInsightsAssembler("objective").assemble(makeContext(), "x");
    expect(on.layers.map((l) => l.id)).toContain("mes_example");

    const off = getInsightsAssembler("objective").assemble(
      makeContext({ character: { ...makeContext().character, mesExampleMode: "disabled" } }),
      "x",
    );
    expect(off.layers.map((l) => l.id)).not.toContain("mes_example");
  });

  it("emits no instruction message when the instruction is blank", () => {
    const result = getInsightsAssembler("objective").assemble(makeContext(), "   ");
    expect(messagesOf(result).at(-1)?.layerId).not.toBe("insights_instruction");
  });

  it("returns a clean PromptAssemblyResult (activated lore surfaced, null prefill when none)", () => {
    const result = getInsightsAssembler("objective").assemble(makeContext(), "Do it.");
    expect(result.activatedLoreEntries).toContain("lore_1");
    expect(result.droppedLayers).toEqual([]);
    expect(result.prefill).toBeNull();
    expect(result.layers.length).toBeGreaterThan(0);
  });
});
