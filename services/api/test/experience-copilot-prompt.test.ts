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
import { createHash } from "node:crypto";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import type { ToolCallPart, ToolResultPart } from "ai";
import type { CopilotProfile } from "@vibe-tavern/api-contracts";
import {
  assembleExperienceCopilotPrompt,
  resolveDigestBoundary,
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
    expect(result.tokenAccounting.history).toBe(0);
    expect(result.tokenAccounting.digest).toBe(0);
    expect(result.tokenAccounting.total).toBe(result.tokenAccounting.system);
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
    expect(result.tokenAccounting.history).toBeGreaterThan(0);
    expect(result.tokenAccounting.total).toBe(
      result.tokenAccounting.system + result.tokenAccounting.digest + result.tokenAccounting.history,
    );
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

// ─── (e) User-flow doc + Russian UI labels (2026-08-17) ─────────────────────────────────────────────

describe("assembleExperienceCopilotPrompt — user-flow doc + RU labels", () => {
  test("the human-side flow doc is always present (profile-independent tail section)", async () => {
    const result = await assembleExperienceCopilotPrompt({
      history: [{ role: "user", content: "Hello" }],
      rules: VALID_RULES,
      step: "rules",
    });
    expect(result.systemMessage).toContain("# How the user builds and tests (the human side)");
    // The sandbox launch parameters the user can configure are named so the
    // model can walk the user through the Try-it panel.
    expect(result.systemMessage).toContain("Random start");
    expect(result.systemMessage).toContain("Which seat you play");
    expect(result.systemMessage).toContain("Participants & launch settings");
  });

  test("a Russian-voice history appends the RU↔EN label map; an English one does not", async () => {
    const ru = await assembleExperienceCopilotPrompt({
      history: [
        { role: "user", content: "Привет, давай сделаем дурака" },
        { role: "assistant", content: "Привет! Начнём с правил." },
      ],
      rules: VALID_RULES,
      step: "rules",
    });
    expect(ru.systemMessage).toContain("# UI labels — Russian ↔ English");
    expect(ru.systemMessage).toContain("«Проверить и создать»");

    const en = await assembleExperienceCopilotPrompt({
      history: [
        { role: "user", content: "Hi, let us build a durak game" },
        { role: "assistant", content: "Hi! Starting with rules." },
      ],
      rules: VALID_RULES,
      step: "rules",
    });
    expect(en.systemMessage).not.toContain("# UI labels — Russian ↔ English");
  });

  test("Cyrillic in tool parts alone does NOT trigger the RU map", async () => {
    // Tool payloads are code/JSON — stray Cyrillic there (a flavor string in
    // the rules) says nothing about the user's voice.
    const result = await assembleExperienceCopilotPrompt({
      history: [
        { role: "user", content: "make it russian-flavored" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ toolCallId: "c1", toolName: "write_buffer", input: { buffer: "rules", content: "const s = \"Дурак\";" } }],
        },
      ],
      rules: VALID_RULES,
      step: "rules",
    });
    expect(result.systemMessage).not.toContain("# UI labels — Russian ↔ English");
  });
});

// ─── (d) Digest messages (CM-3) ──────────────────────────────────────────────

describe("assembleExperienceCopilotPrompt — digest (CM-3)", () => {
  test("zero-digest assembly is byte-identical to the pre-CM-3 assembly", async () => {
    const result = await assembleExperienceCopilotPrompt({
      history: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi! I can help author your experience." },
      ],
      rules: VALID_RULES,
      step: "rules",
    });
    // SHA-256 of the system message — pins that lifting digest messages out
    // of the history flow changed nothing for a thread that never compacted
    // (zero behavior change without a digest). Re-captured after the
    // experience-authoring skill DESCRIPTION changed (commit ad893b75) and
    // again after the human-side user-flow doc (experience-copilot/
    // user-flow.md) became an always-on tail section (2026-08-17) — an
    // intentional system-prompt content change, not drift.
    expect(createHash("sha256").update(result.systemMessage).digest("hex"))
      .toBe("65aa170588bad615c8b3d6c5fecd2c6677e66b4e52b9e8132d450add1b9637d8");
    expect(result.messages).toHaveLength(3);
  });

  test("the LAST digest renders as a system-level JSON section and leaves the history flow", async () => {
    const result = await assembleExperienceCopilotPrompt({
      history: [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
        { role: "digest", content: "Earlier context was compacted." },
        { role: "user", content: "Second question" },
        { role: "assistant", content: "Second answer" },
      ],
      rules: VALID_RULES,
      step: "rules",
    });

    // The digest is injected as a system-level JSON section, NOT a history message.
    expect(result.systemMessage).toContain("# Compacted context (digest)");
    expect(result.systemMessage).toContain('{"digest":"Earlier context was compacted."}');
    // system + the 4 non-digest turns only (the digest is not a message).
    expect(result.messages).toHaveLength(5);
    expect(result.messages.some((m) => m.role === "digest")).toBe(false);
    // Segmented accounting: digest > 0 and total is the sum.
    expect(result.tokenAccounting.digest).toBeGreaterThan(0);
    expect(result.tokenAccounting.total).toBe(
      result.tokenAccounting.system + result.tokenAccounting.digest + result.tokenAccounting.history,
    );
  });

  test("older digests are dropped entirely — only the last digest's text survives", async () => {
    const result = await assembleExperienceCopilotPrompt({
      history: [
        { role: "digest", content: "OLD DIGEST TEXT SHOULD BE DROPPED" },
        { role: "user", content: "question" },
        { role: "digest", content: "NEW DIGEST TEXT SURVIVES" },
        { role: "assistant", content: "answer" },
      ],
      rules: VALID_RULES,
      step: "rules",
    });

    expect(result.systemMessage).toContain('{"digest":"NEW DIGEST TEXT SURVIVES"}');
    expect(result.systemMessage).not.toContain("OLD DIGEST TEXT SHOULD BE DROPPED");
  });
});

// ─── (e) Digest boundary resolution (CM-5) ────────────────────────────────────

describe("resolveDigestBoundary (CM-5)", () => {
  test("no digest → everything is kept, nothing covered", () => {
    const messages = [
      { id: "m1", role: "user", content: "a", toolCallId: null },
      { id: "m2", role: "assistant", content: "b", toolCallId: null },
    ];
    expect(resolveDigestBoundary(messages)).toEqual({
      lastDigest: null,
      covered: [],
      kept: messages,
    });
  });

  test("anchor found → splits at the anchor (covered = strictly before, kept = anchor onward)", () => {
    const messages = [
      { id: "m1", role: "user", content: "a", toolCallId: null },
      { id: "m2", role: "assistant", content: "b", toolCallId: null },
      { id: "d1", role: "digest", content: "summary", toolCallId: "m3" },
      { id: "m3", role: "user", content: "c", toolCallId: null },
      { id: "m4", role: "assistant", content: "d", toolCallId: null },
    ];
    const result = resolveDigestBoundary(messages);
    expect(result.lastDigest?.id).toBe("d1");
    expect(result.covered.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(result.kept.map((m) => m.id)).toEqual(["m3", "m4"]);
  });

  test("dangling anchor → degrades to no-drop (kept = all non-digest, covered empty)", () => {
    const messages = [
      { id: "m1", role: "user", content: "a", toolCallId: null },
      { id: "m2", role: "assistant", content: "b", toolCallId: null },
      // The anchor points at a message that no longer exists in the loaded set.
      { id: "d1", role: "digest", content: "summary", toolCallId: "gone" },
      { id: "m3", role: "user", content: "c", toolCallId: null },
    ];
    const result = resolveDigestBoundary(messages);
    expect(result.lastDigest?.id).toBe("d1");
    expect(result.covered).toEqual([]);
    expect(result.kept.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  test("older digests are part of the covered prefix, never kept", () => {
    const messages = [
      { id: "m1", role: "user", content: "a", toolCallId: null },
      { id: "d0", role: "digest", content: "old summary", toolCallId: "m1" },
      { id: "m2", role: "assistant", content: "b", toolCallId: null },
      { id: "d1", role: "digest", content: "new summary", toolCallId: "m3" },
      { id: "m3", role: "user", content: "c", toolCallId: null },
    ];
    const result = resolveDigestBoundary(messages);
    expect(result.lastDigest?.id).toBe("d1");
    // d0 (older digest) sits before the anchor and is dropped with the covered prefix.
    expect(result.covered.map((m) => m.id)).toEqual(["m1", "d0", "m2"]);
    expect(result.kept.map((m) => m.id)).toEqual(["m3"]);
  });
});
