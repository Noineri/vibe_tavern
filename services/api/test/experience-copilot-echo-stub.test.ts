/**
 * Context-economy tests (#16): historical tool-echo stubbing + cache-friendly
 * system-message order.
 *
 * The echo problem, pinned: an authoring session re-sends the FULL buffer in
 * every old write_buffer/edit_buffer exchange (args AND result echo) while the
 * current buffer already rides in the system context — measured ~40k tokens of
 * pure echo after 10 edit turns on a ~2k-token buffer. These tests pin the
 * model-window transform (Claude Code microcompaction / OpenCode v2 tail
 * pruning shape): old exchanges stubbed, pairs intact, summaries kept, the
 * last skill read verbatim, the current turn untouched; and that the system
 * message puts the stable sections (role/catalog/refs) BEFORE the volatile
 * context package so a prefix-cache provider hits on the stable block.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import type { ToolCallPart } from "ai";
import {
  assembleExperienceCopilotPrompt,
  estimateHistoryTokens,
  stubHistoricalToolEchoes,
  BUFFER_ECHO_STUB,
  SKILL_READ_STUB,
  type ExperienceCopilotHistoryMessage,
  type ExperienceCopilotFlowMessage,
} from "../src/domain/interactive/copilot/experience-copilot-prompt.js";

beforeEach(() => {
  // Char-length heuristic so estimateTokens returns a realistic number.
  setTokenCountFn((text: string) => text.length);
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BIG_BUFFER = "var x = 1;\n".repeat(400); // ~4.8k chars of buffer content

function writeCall(toolCallId: string, content: string): ToolCallPart {
  return {
    type: "tool-call",
    toolCallId,
    toolName: "write_buffer",
    input: { target: "rules", content, summary: `edit ${toolCallId}` },
  };
}

function writeResult(toolCallId: string, content: string): ExperienceCopilotFlowMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName: "write_buffer",
        output: {
          type: "text",
          value: JSON.stringify({ target: "rules", proposed: content, summary: `edit ${toolCallId}` }),
        },
      },
    ],
  };
}

function skillRead(toolCallId: string, path: string): ExperienceCopilotFlowMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName: "read_skill_file",
        output: { type: "text", value: `# skill ${path}\ncraft guidance text...` },
      },
    ],
  };
}

/** A 3-user-turn editing session:
 *  turn 1 (old): write_buffer + TWO skill reads · turn 2 (previous): write_buffer
 *  · turn 3 (current): write_buffer. The default keep-window (last 2 user
 *  turns) keeps turns 2-3 verbatim and stubs turn 1. */
function sessionHistory(): ExperienceCopilotHistoryMessage[] {
  return [
    { role: "user", content: "сделай мини-приложение" },
    { role: "assistant", content: "", toolCalls: [writeCall("tc1", BIG_BUFFER)] },
    writeResult("tc1", BIG_BUFFER),
    skillRead("sk1", "skills/experience-authoring/SKILL.md"),
    skillRead("sk2", "skills/other/SKILL.md"),
    { role: "user", content: "поправь вариант 2" },
    { role: "assistant", content: "", toolCalls: [writeCall("tc2", BIG_BUFFER)] },
    writeResult("tc2", BIG_BUFFER),
    { role: "user", content: "поправь вариант 3" },
    { role: "assistant", content: "", toolCalls: [writeCall("tc3", BIG_BUFFER)] },
    writeResult("tc3", BIG_BUFFER),
  ];
}

function outputValue(m: ExperienceCopilotFlowMessage, toolCallId: string): string {
  if (m.role !== "tool") throw new Error("not a tool message");
  const part = m.content.find((p) => p.toolCallId === toolCallId);
  if (!part || part.output.type !== "text") throw new Error("part not found");
  return part.output.value;
}

// ─── stubHistoricalToolEchoes ────────────────────────────────────────────────

describe("stubHistoricalToolEchoes (#16)", () => {
  test("stubs old buffer echoes on BOTH sides of the pair, keeps summaries and structure", () => {
    const flow = sessionHistory().filter(
      (m): m is ExperienceCopilotFlowMessage => m.role !== "digest",
    );
    const stubbed = stubHistoricalToolEchoes(flow);

    // Structure intact: same length, same roles, same toolCallIds.
    expect(stubbed).toHaveLength(flow.length);
    expect(stubbed.map((m) => m.role)).toEqual(flow.map((m) => m.role));

    // Turn-1 write_buffer: call args content stubbed, summary kept.
    const call1 = (stubbed[1] as { toolCalls?: ToolCallPart[] }).toolCalls?.[0];
    expect(call1?.input).toMatchObject({ target: "rules", content: BUFFER_ECHO_STUB, summary: "edit tc1" });
    // Turn-1 result: proposed stubbed, summary kept.
    const result1 = JSON.parse(outputValue(stubbed[2], "tc1")) as { proposed: string; summary: string };
    expect(result1.proposed).toBe(BUFFER_ECHO_STUB);
    expect(result1.summary).toBe("edit tc1");

    // Turns 2-3 (the keep-window) stay VERBATIM.
    const call2 = (stubbed[6] as { toolCalls?: ToolCallPart[] }).toolCalls?.[0];
    expect((call2?.input as { content: string }).content).toBe(BIG_BUFFER);
    expect(JSON.parse(outputValue(stubbed[7], "tc2")).proposed).toBe(BIG_BUFFER);
    expect(JSON.parse(outputValue(stubbed[10], "tc3")).proposed).toBe(BIG_BUFFER);
  });

  test("old skill reads are stubbed EXCEPT the last one, which stays verbatim", () => {
    const flow = sessionHistory().filter(
      (m): m is ExperienceCopilotFlowMessage => m.role !== "digest",
    );
    const stubbed = stubHistoricalToolEchoes(flow);
    // sk1 is older than the last read (sk2) → stubbed; sk2 is the LAST skill
    // read even though it sits in the stub region → stays verbatim.
    expect(outputValue(stubbed[3], "sk1")).toBe(SKILL_READ_STUB);
    expect(outputValue(stubbed[4], "sk2")).toContain("craft guidance text");
  });

  test("keepUserTurns: 0 stubs everything (the compaction transcript path)", () => {
    const flow = sessionHistory().filter(
      (m): m is ExperienceCopilotFlowMessage => m.role !== "digest",
    );
    const stubbed = stubHistoricalToolEchoes(flow, { keepUserTurns: 0 });
    expect(JSON.parse(outputValue(stubbed[10], "tc3")).proposed).toBe(BUFFER_ECHO_STUB);
    // The last skill read still stays verbatim (operational text rule).
    expect(outputValue(stubbed[4], "sk2")).toContain("craft guidance text");
  });

  test("the token saving is real: stubbed history is a fraction of the raw one", () => {
    const flow = sessionHistory().filter(
      (m): m is ExperienceCopilotFlowMessage => m.role !== "digest",
    );
    // keepUserTurns: 1 keeps ONLY the current turn verbatim — turns 1-2 (four
    // BIG_BUFFER copies across args+results, ~19k chars) collapse to stubs.
    const before = estimateHistoryTokens(flow);
    const after = estimateHistoryTokens(stubHistoricalToolEchoes(flow, { keepUserTurns: 1 }));
    expect(after).toBeLessThan(before / 2);
  });
});

// ─── Assembler integration ───────────────────────────────────────────────────

describe("assembleExperienceCopilotPrompt — echo stubs in the model window (#16)", () => {
  test("old echoes are stubbed in the assembled messages; the current turn is verbatim", async () => {
    const result = await assembleExperienceCopilotPrompt({
      history: sessionHistory(),
      rules: BIG_BUFFER,
      step: "rules",
    });
    const toolMsgs = result.messages.filter((m) => m.role === "tool");
    const values: string[] = [];
    for (const m of toolMsgs) {
      if (m.role !== "tool") continue;
      for (const part of m.content) {
        if (part.output.type === "text") values.push(part.output.value);
      }
    }
    // Turn-1 echo stubbed, current turn verbatim.
    expect(values.some((v) => v.includes(BUFFER_ECHO_STUB))).toBe(true);
    const escapedBuffer = BIG_BUFFER.replaceAll("\n", "\\n");
    expect(values.some((v) => v.includes(escapedBuffer))).toBe(true);
    // The stub reached the accounting: history tokens equal the estimate of
    // the same flow stubbed with the default policy (the assembler and the
    // estimator agree), and are strictly below the raw (un-stubbed) estimate.
    const flow = sessionHistory().filter(
      (m): m is ExperienceCopilotFlowMessage => m.role !== "digest",
    );
    expect(result.tokenAccounting.history).toBe(estimateHistoryTokens(stubHistoricalToolEchoes(flow)));
    expect(result.tokenAccounting.history).toBeLessThan(estimateHistoryTokens(flow));
  });

  test("cache order: stable sections precede the volatile context package", async () => {
    const result = await assembleExperienceCopilotPrompt({
      history: sessionHistory(), // Cyrillic present → RU map rendered
      rules: "var ok = 1;",
      step: "rules",
      todo: [{ title: "t", status: "active" }],
    });
    const sys = result.systemMessage;
    const ctxIdx = sys.indexOf("# Current working context");
    expect(ctxIdx).toBeGreaterThan(0);
    // Every stable section comes strictly before the context package…
    for (const marker of [
      "MINI-APP ASSISTANT", // base prompt (role)
      "# Available skills", // skill catalog
      "# UI labels", // RU map (Cyrillic history)
      "experience-copilot/user-flow".length > 0 ? "The human side" : "", // user-flow asset content marker
      "# Experience rules API reference",
      "# Experience visual API reference",
    ]) {
      if (marker) expect(sys.indexOf(marker)).toBeLessThan(ctxIdx);
    }
    // …and the volatile order is digest → todo → context (rarest-change first).
    const todoIdx = sys.indexOf("# Current step plan");
    expect(todoIdx).toBeGreaterThan(-1);
    expect(todoIdx).toBeLessThan(ctxIdx);
    // The context package sits in the tail of the system message (max
    // recency, and everything before it is cache-stable).
    expect(ctxIdx).toBeGreaterThan(sys.length * 0.8);
  });
});
