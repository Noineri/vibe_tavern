/**
 * Experience-copilot prompt assembly characterization (ER-5).
 *
 * Pins what the model sees each turn: the system message carries role framing +
 * the context package (rules/visual/bound-visuals/contract/test-feedback/step) +
 * the canonical experience SDK API reference; history is windowed to
 * HISTORY_LIMIT (20) and budget-trimmed while preserving tool-call/tool-result
 * pairs. Pure — no store; history and context come in as function input.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import type { ToolCallPart, ToolResultPart } from "ai";
import type { CopilotProfile } from "@vibe-tavern/api-contracts";
import {
  assembleExperienceCopilotPrompt,
  type ExperienceCopilotHistoryMessage,
} from "../src/domain/interactive/copilot/experience-copilot-prompt.js";
import { resolveBuiltinCopilotProfile } from "../src/domain/interactive/copilot/experience-copilot-module.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** A minimal valid experience (the "Counter" shape from the SDK examples). */
const VALID_RULES = `context.experience.register({
  apiVersion: 1,
  manifest: { id: "counter", name: "Counter" },
  capabilities: [],
  create() { return { count: 0 }; },
  project(context) { return { count: context.state.count }; },
  actions() { return [{ type: "increment" }]; },
  reduce(context, action) {
    if (action.type === "increment") return { state: { count: context.state.count + 1 }, status: "active", events: [] };
    return { state: context.state, status: "active", events: [] };
  }
});`;

/** Rules that fail discovery (syntax/runtime error). */
const BROKEN_RULES = "this is not valid JavaScript for an experience definition";

function makeMessages(count: number): ExperienceCopilotHistoryMessage[] {
  const messages: ExperienceCopilotHistoryMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}: some content for testing the compaction window.`,
    });
  }
  return messages;
}

beforeEach(() => {
  // Char-length heuristic so estimateTokens returns a realistic number in tests.
  setTokenCountFn((text: string) => text.length);
});

// ─── (a) Shape: system message + context-package fields + API reference ─────

describe("assembleExperienceCopilotPrompt — shape", () => {
  test("system message carries role framing, context, and the SDK API reference", async () => {
    const result = await assembleExperienceCopilotPrompt({
      history: [],
      rules: VALID_RULES,
      step: "rules",
    });

    // Role framing
    expect(result.systemMessage).toContain("EXPERIENCE ASSISTANT");
    expect(result.systemMessage).toContain("write_buffer");
    expect(result.systemMessage).toContain("edit_buffer");

    // Context-package fields surface
    expect(result.systemMessage).toContain("Authoring step: **rules**");
    expect(result.systemMessage).toContain("Current rules buffer");
    expect(result.systemMessage).toContain("counter"); // rules source is present

    // Contract (discovered definition) surfaces from valid rules
    expect(result.systemMessage).toContain("Discovered experience definition");
    expect(result.systemMessage).toContain("Counter"); // manifest name
    expect(result.systemMessage).toContain("choose method: absent");

    // API references baked in (rules register DSL + visual host bridge)
    expect(result.systemMessage).toContain("context.experience.register");
    expect(result.systemMessage).toContain("apiVersion");
    expect(result.systemMessage).toContain("VibeExperience"); // visual bridge contract is now included

    // Messages array starts with the system message
    expect(result.messages.length).toBe(1);
    expect(result.messages[0].role).toBe("system");
    expect(result.tokenAccounting.recentHistory).toBe(0);
  });

  test("system message carries the skill catalog and result exposes skill roots (ER-16)", async () => {
    const result = await assembleExperienceCopilotPrompt({
      history: [],
      rules: VALID_RULES,
      step: "rules",
    });

    // The module's base prompt is loaded from the base.md asset (ER-16) — the
    // role framing now lives there, not inline, but the content is unchanged.
    expect(result.systemMessage).toContain("EXPERIENCE ASSISTANT");
    expect(result.systemMessage).toContain("read_skill_file");

    // The resolved skill catalog is injected as an on-demand "Available skills"
    // section so the model knows what it can read via read_skill_file.
    expect(result.systemMessage).toContain("Available skills");
    expect(result.systemMessage).toContain("experience-authoring");
    expect(result.systemMessage).toContain("experience-authoring/SKILL.md");

    // Skill roots are derived from the catalog so read_skill_file resolves
    // against the same root the catalog was built from (forwarded to the tool
    // builder by the stream).
    expect(result.skillRoots.length).toBeGreaterThanOrEqual(1);
    expect(result.skillRoots[0]).toContain("experience-copilot");
    expect(result.skillRoots[0]).toContain("skills");
  });

  test("contract is omitted when rules discovery fails (broken rules)", async () => {
    const result = await assembleExperienceCopilotPrompt({
      history: [],
      rules: BROKEN_RULES,
      step: "rules",
    });
    expect(result.systemMessage).toContain("discovery failed");
  });

  test("contract is omitted when rules are empty", async () => {
    const result = await assembleExperienceCopilotPrompt({
      history: [],
      rules: "",
      step: "rules",
    });
    expect(result.systemMessage).toContain("discovery failed");
  });

  test("visual, bound visuals, and test feedback surface when present", async () => {
    const result = await assembleExperienceCopilotPrompt({
      history: [],
      rules: VALID_RULES,
      step: "test",
      visual: "// some visual source\ncanvas.text('hello')",
      boundVisuals: [{ id: "vis_1", name: "Card Layout", kind: "card" }],
      testFeedback: { ok: true, status: "active", revision: 0, legalActionTypes: ["increment"] },
    });

    expect(result.systemMessage).toContain("Current visual buffer");
    expect(result.systemMessage).toContain("canvas.text");
    expect(result.systemMessage).toContain("Card Layout");
    expect(result.systemMessage).toContain("vis_1");
    expect(result.systemMessage).toContain("test feedback");
    expect(result.systemMessage).toContain("increment"); // from the digest
  });

  test("explicit built-in profile is byte-identical to the default (CP-7 zero behavior change)", async () => {
    const builtin = await resolveBuiltinCopilotProfile();
    const defaultResult = await assembleExperienceCopilotPrompt({ history: [], rules: VALID_RULES, step: "rules" });
    const explicitResult = await assembleExperienceCopilotPrompt({
      history: [],
      rules: VALID_RULES,
      step: "rules",
      profile: builtin,
    });
    expect(explicitResult.systemMessage).toBe(defaultResult.systemMessage);
    expect(explicitResult.skillRoots).toEqual(defaultResult.skillRoots);
  });

  test("a custom profile overrides the base prompt and gates the skill catalog", async () => {
    const custom: CopilotProfile = {
      id: "custom",
      name: "Custom",
      isBuiltIn: false,
      basePrompt: "CUSTOM SYSTEM PROMPT MARKER",
      skillIds: [],
      toolSet: {},
      maxSteps: 5,
    };
    const result = await assembleExperienceCopilotPrompt({
      history: [],
      rules: VALID_RULES,
      step: "rules",
      profile: custom,
    });
    expect(result.systemMessage).toContain("CUSTOM SYSTEM PROMPT MARKER");
    expect(result.systemMessage).not.toContain("EXPERIENCE ASSISTANT");
    // No enabled skills → no "Available skills" section and no skill roots.
    expect(result.systemMessage).not.toContain("Available skills");
    expect(result.skillRoots).toEqual([]);
  });
});

// ─── (b) History > 20 compacts ───────────────────────────────────────────────

describe("assembleExperienceCopilotPrompt — history compaction", () => {
  test("history > HISTORY_LIMIT is windowed to at most 20 messages", async () => {
    const messages = makeMessages(30);
    const result = await assembleExperienceCopilotPrompt({
      history: messages,
      rules: VALID_RULES,
      step: "rules",
    });

    const historyCount = result.messages.length - 1; // subtract system
    expect(historyCount).toBeLessThanOrEqual(20);
    expect(historyCount).toBeLessThan(30);
    expect(result.compactionSummary).toBeDefined();
    expect(result.compactionSummary).toContain("windowed");
    expect(result.tokenAccounting.recentHistory).toBe(historyCount);
  });

  test("history <= HISTORY_LIMIT is not windowed (no summary)", async () => {
    const messages = makeMessages(15);
    const result = await assembleExperienceCopilotPrompt({
      history: messages,
      rules: VALID_RULES,
      step: "rules",
    });

    const historyCount = result.messages.length - 1;
    expect(historyCount).toBe(15);
    expect(result.compactionSummary).toBeUndefined();
  });

  test("budget-based compaction further trims within the window", async () => {
    const messages = makeMessages(15);
    // Baseline (no budget): all 15 messages kept.
    const baseline = await assembleExperienceCopilotPrompt({
      history: messages,
      rules: VALID_RULES,
      step: "rules",
    });
    // Tight budget + response reserve forces trimming.
    const result = await assembleExperienceCopilotPrompt({
      history: messages,
      rules: VALID_RULES,
      step: "rules",
      contextBudget: baseline.tokenAccounting.total + 5,
      responseReserve: 200,
    });

    const historyCount = result.messages.length - 1;
    expect(historyCount).toBeLessThan(15);
    expect(result.compactionSummary).toBeDefined();
    expect(result.compactionSummary).toContain("budget");
  });
});

// ─── (c) Tool-call/tool-result pairs preserved across compaction ─────────────

describe("assembleExperienceCopilotPrompt — tool-pair safety", () => {
  test("tool-call/tool-result pair within the window is preserved", async () => {
    const messages: ExperienceCopilotHistoryMessage[] = [];
    for (let i = 0; i < 18; i++) {
      messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}` });
    }
    const toolCall: ToolCallPart = {
      type: "tool-call",
      toolCallId: "call_pair",
      toolName: "run_test",
      input: {},
    };
    const toolResult: ToolResultPart = {
      type: "tool-result",
      toolCallId: "call_pair",
      toolName: "run_test",
      output: { type: "text", value: "ok" },
    };
    messages.push({ role: "assistant", content: "Let me test this.", toolCalls: [toolCall] });
    messages.push({ role: "tool", content: [toolResult] });
    messages.push({ role: "user", content: "Nice." });
    messages.push({ role: "assistant", content: "Great." });
    // Total: 22 messages; window keeps last 20; pair at indices 18-19 is inside.

    const result = await assembleExperienceCopilotPrompt({
      history: messages,
      rules: VALID_RULES,
      step: "test",
    });

    const historyMessages = result.messages.slice(1);
    const hasToolCall = historyMessages.some(
      (m) =>
        m.role === "assistant" &&
        m.toolCalls !== undefined &&
        m.toolCalls.some((tc) => tc.toolCallId === "call_pair"),
    );
    const hasToolResult = historyMessages.some(
      (m) => m.role === "tool" && m.content.some((tr) => tr.toolCallId === "call_pair"),
    );
    expect(hasToolCall).toBe(true);
    expect(hasToolResult).toBe(true);
  });

  test("pair straddling the window boundary is preserved (boundary walks back)", async () => {
    // Construct 21 messages where the raw window boundary (index 1) falls on a
    // tool result; findSafeCompactionBoundary must walk back to include the
    // parent assistant (index 0), keeping all 21 instead of splitting the pair.
    const messages: ExperienceCopilotHistoryMessage[] = [];
    messages.push({
      role: "assistant",
      content: "Running a test.",
      toolCalls: [{
        type: "tool-call",
        toolCallId: "call_boundary",
        toolName: "run_test",
        input: {},
      }],
    });
    messages.push({
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "call_boundary",
        toolName: "run_test",
        output: { type: "text", value: "ok" },
      }],
    });
    for (let i = 2; i < 21; i++) {
      messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}` });
    }
    // Total: 21 messages; raw window of 20 starts at index 1 (the tool result).

    const result = await assembleExperienceCopilotPrompt({
      history: messages,
      rules: VALID_RULES,
      step: "test",
    });

    const historyMessages = result.messages.slice(1);
    // Both the assistant and tool result must be present (pair not split).
    const hasToolCall = historyMessages.some(
      (m) =>
        m.role === "assistant" &&
        m.toolCalls !== undefined &&
        m.toolCalls.some((tc) => tc.toolCallId === "call_boundary"),
    );
    const hasToolResult = historyMessages.some(
      (m) => m.role === "tool" && m.content.some((tr) => tr.toolCallId === "call_boundary"),
    );
    expect(hasToolCall).toBe(true);
    expect(hasToolResult).toBe(true);
    // 21 preserved (not 20) because boundary safety pulled in the parent assistant.
    expect(historyMessages.length).toBe(21);
  });
});
