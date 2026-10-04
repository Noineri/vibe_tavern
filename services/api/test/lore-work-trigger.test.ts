/**
 * COAUTHOR_LORE_FULL_SETTINGS step 6 — the lore-work trigger.
 *
 * Pins three contracts:
 *  1. Trigger semantics — `isLoreWorkActive` reads the persisted chat history
 *     (state the backend already has at assembly time): lore work is active
 *     iff the model's most recent working segment contains a lore tool call.
 *     The just-sent user turn must not mask the previous segment's work.
 *  2. Flag wiring — `buildCoauthorTools({ loreWorkActive })` flips the lore
 *     tools between the basic (outside lore work) and full (in lore work)
 *     parameter views; an ABSENT flag keeps the full view (today's behavior,
 *     so callers that predate the trigger are unchanged).
 *  3. Tool-name source — `LORE_TOOL_NAMES` is exactly the lore tool set
 *     `buildLoreTools` returns, so the trigger can never miss a lore tool.
 */
import { describe, expect, test } from "bun:test";
import { buildCoauthorTools } from "../src/domain/chat/coauthor-tools.js";
import { buildLoreTools, LORE_TOOL_NAMES } from "../src/domain/coauthor/lore/lore-tools.js";
import {
  isLoreWorkActive,
  type LoreWorkHistoryMessage,
} from "../src/domain/coauthor/lore/lore-work-trigger.js";

/** Minimal view of a built tool exposing its zod input schema for direct
 *  validation assertions (same probe pattern as experience-copilot-tools.test.ts
 *  — the AI SDK validates `inputSchema` at tool-call time, so view membership
 *  is asserted against the schema, not through execute). */
interface ToolSchemaProbe {
  inputSchema: {
    safeParse(value: unknown): { success: boolean };
    shape: Record<string, unknown>;
  };
}

/** History row with an assistant tool call (`name` = persisted toolCallsJson shape). */
function assistantWithCalls(toolNames: string[]): LoreWorkHistoryMessage {
  return { role: "assistant", content: "", toolCalls: toolNames.map((toolName, i) => ({ toolName, id: `tc_${i}` })) };
}

describe("isLoreWorkActive: most-recent-working-segment trigger", () => {
  test("empty history → not active", () => {
    expect(isLoreWorkActive([])).toBe(false);
  });

  test("a lore tool call in the last assistant segment → active", () => {
    expect(
      isLoreWorkActive([
        { role: "user", content: "make lore" },
        assistantWithCalls(["create_lorebook"]),
      ]),
    ).toBe(true);
  });

  test("trailing user messages are skipped — the just-sent turn must not mask the previous segment's lore work", () => {
    // Whether the current user message is already persisted at assembly time
    // differs by flow; the trigger must be active in both orders.
    expect(
      isLoreWorkActive([
        { role: "user", content: "make lore" },
        assistantWithCalls(["create_lorebook"]),
        { role: "user", content: "continue" },
      ]),
    ).toBe(true);
  });

  test("non-lore tool calls do not trigger", () => {
    expect(
      isLoreWorkActive([
        { role: "user", content: "rewrite the profile" },
        assistantWithCalls(["write_profile", "edit_greeting"]),
        { role: "user", content: "more" },
      ]),
    ).toBe(false);
  });

  test("older lore work followed by a non-lore segment → not active (flips back once the model moves on)", () => {
    expect(
      isLoreWorkActive([
        { role: "user", content: "make lore" },
        assistantWithCalls(["create_lorebook"]),
        { role: "user", content: "now the profile" },
        assistantWithCalls(["edit_personality"]),
        { role: "user", content: "thanks" },
      ]),
    ).toBe(false);
  });

  test("every lore tool name flips the trigger", () => {
    for (const name of LORE_TOOL_NAMES) {
      expect(
        isLoreWorkActive([{ role: "user", content: "go" }, assistantWithCalls([name])]),
        `${name} must count as lore work`,
      ).toBe(true);
    }
  });

  test("tool-result rows inside the segment are scanned past, not mistaken for calls", () => {
    // A multi-step segment: assistant(call) → tool result → assistant(final).
    expect(
      isLoreWorkActive([
        { role: "user", content: "make lore" },
        assistantWithCalls(["ai_generate_lore_keys"]),
        { role: "tool", content: [] },
        { role: "assistant", content: "done" },
        { role: "user", content: "next" },
      ]),
    ).toBe(true);
    // The same shape without the lore call stays inactive.
    expect(
      isLoreWorkActive([
        { role: "user", content: "hello" },
        assistantWithCalls(["search_context"]),
        { role: "tool", content: [] },
        { role: "assistant", content: "done" },
      ]),
    ).toBe(false);
  });
});

describe("lore-work flag wiring through buildCoauthorTools", () => {
  test("outside lore work: advanced settings fields are rejected, basics accepted", () => {
    const tools = buildCoauthorTools({ loreWorkActive: false }) as unknown as {
      create_lore_entry: ToolSchemaProbe;
      edit_lorebook: ToolSchemaProbe;
    };
    // Membership first: the advanced fields are OFF the tool block entirely
    // (they would otherwise cost the per-turn schema bytes step 6 removes).
    expect(Object.keys(tools.create_lore_entry.inputSchema.shape)).not.toContain("stickyWindow");
    expect(Object.keys(tools.create_lore_entry.inputSchema.shape)).not.toContain("probability");
    expect(Object.keys(tools.edit_lorebook.inputSchema.shape)).not.toContain("tokenBudgetPercent");
    // And strict: a model sending an advanced field anyway gets a named
    // tool-error (no silent key-stripping settings loss), while basics pass.
    expect(
      tools.create_lore_entry.inputSchema.safeParse({ lorebookId: "lb", stickyWindow: 3, summary: "s" }).success,
    ).toBe(false);
    expect(
      tools.create_lore_entry.inputSchema.safeParse({
        lorebookId: "lb",
        title: "T",
        constant: true,
        position: "at_depth",
        depth: 4,
        logic: "and_all",
        enabled: true,
        summary: "s",
      }).success,
    ).toBe(true);
    expect(
      tools.edit_lorebook.inputSchema.safeParse({ lorebookId: "lb", tokenBudgetPercent: 25, summary: "s" }).success,
    ).toBe(false);
    expect(
      tools.edit_lorebook.inputSchema.safeParse({ lorebookId: "lb", scanDepth: 8, tokenBudget: 500, summary: "s" }).success,
    ).toBe(true);
  });

  test("inside lore work: the full settings surface is accepted", () => {
    const tools = buildCoauthorTools({ loreWorkActive: true }) as unknown as {
      create_lore_entry: ToolSchemaProbe;
      edit_lorebook: ToolSchemaProbe;
    };
    expect(
      tools.create_lore_entry.inputSchema.safeParse({ lorebookId: "lb", stickyWindow: 3, cooldownWindow: 2, summary: "s" }).success,
    ).toBe(true);
    expect(
      tools.edit_lorebook.inputSchema.safeParse({ lorebookId: "lb", tokenBudgetPercent: 25, matchWholeWords: true, summary: "s" }).success,
    ).toBe(true);
  });

  test("an ABSENT flag keeps the full view (callers predating the trigger are unchanged)", () => {
    const tools = buildCoauthorTools() as unknown as { create_lore_entry: ToolSchemaProbe };
    expect(
      tools.create_lore_entry.inputSchema.safeParse({ lorebookId: "lb", stickyWindow: 3, probability: 50, summary: "s" }).success,
    ).toBe(true);
  });

  test("the delegate and activation tools stay call-shaped in BOTH views", () => {
    for (const loreWorkActive of [false, true]) {
      const tools = buildCoauthorTools({ loreWorkActive }) as unknown as {
        set_lore_activation: ToolSchemaProbe;
        ai_generate_lore_keys: ToolSchemaProbe;
        ai_write_lore_entry: ToolSchemaProbe;
      };
      expect(
        tools.set_lore_activation.inputSchema.safeParse({ entryId: "e", constant: true, summary: "s" }).success,
        `set_lore_activation (loreWorkActive=${loreWorkActive})`,
      ).toBe(true);
      expect(
        tools.ai_write_lore_entry.inputSchema.safeParse({ entryId: "e", instruction: "write it", summary: "s" }).success,
        `ai_write_lore_entry (loreWorkActive=${loreWorkActive})`,
      ).toBe(true);
      expect(
        tools.ai_generate_lore_keys.inputSchema.safeParse({ entryId: "e", keyTarget: "primary", summary: "s" }).success,
        `ai_generate_lore_keys (loreWorkActive=${loreWorkActive})`,
      ).toBe(true);
    }
  });
});

describe("LORE_TOOL_NAMES (trigger source of truth)", () => {
  test("is exactly the tool set buildLoreTools returns, in definition order", () => {
    const tools = buildLoreTools({ getWorkingProfileMd: () => undefined });
    expect(Object.keys(tools)).toEqual([...LORE_TOOL_NAMES]);
  });
});
