/**
 * Turn-reasoning persistence in the generic agent loop (AGENT_SHELL_POLISH,
 * AP-28). Drives the REAL `streamAgentTurn` with fake seams (store,
 * `streamText`, and the loop's `nowMs` clock — no sleeps, no `mock.module`)
 * and pins:
 * - reasoning deltas persist onto the FIRST assistant row the turn writes —
 *   the text row on a text-first turn, the tool-call row on a tool-first turn;
 * - several bursts in one turn join in arrival order with a blank line, and
 *   the duration sums each burst's first-delta → first-non-reasoning-chunk
 *   elapsed time (an unterminated burst counts its elapsed so far);
 * - a turn without reasoning persists nulls;
 * - the row order/count is unchanged (a reasoning-only turn with no
 *   persistable text writes no assistant row — reasoning is dropped, never
 *   force-fit onto an invented row);
 * - HISTORY IDENTITY (the core safety property): a stored row WITH reasoning
 *   builds byte-identical model history to the same row WITHOUT it — the
 *   store fold, the prompt formatter's token estimate, and the digest
 *   boundary split all ignore both columns.
 */
import { describe, expect, it } from "bun:test";
import type { LanguageModel } from "ai";
import type { ProviderProfile } from "@vibe-tavern/db";
import type { ExperienceCopilotMessage } from "@vibe-tavern/db";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import {
  streamAgentTurn,
  storeMessagesToHistory,
  type AgentStreamDeps,
  type AgentStreamSeams,
  type AgentStreamThread,
} from "../src/domain/agent/agent-stream.js";
import { estimateHistoryTokens, resolveDigestBoundary, type AgentFlowMessage } from "../src/domain/agent/agent-prompt.js";
import { brandId, type ExperienceCopilotMessageId, type ExperienceCopilotThreadId } from "@vibe-tavern/domain";

// ─── Fakes ───────────────────────────────────────────────────────────────────

/** One recorded appendMessage call — the persisted-row log under test. */
interface RecordedRow {
  role: string;
  content: string;
  toolCallsJson: string | null;
  toolCallId: string | null;
  reasoning: string | null;
  reasoningDurationMs: number | null;
}

function createFakeStore() {
  const rows: RecordedRow[] = [];
  const thread: AgentStreamThread = { id: "thread_1", scriptId: "script_1", contextLinks: [] };
  const store = {
    async getById() {
      return thread;
    },
    async listMessages() {
      return [] as const;
    },
    async appendMessage(_threadId: string, input: Record<string, unknown>) {
      rows.push({
        role: String(input.role),
        content: String(input.content ?? ""),
        toolCallsJson: (input.toolCallsJson as string | null) ?? null,
        toolCallId: (input.toolCallId as string | null) ?? null,
        reasoning: (input.reasoning as string | null) ?? null,
        reasoningDurationMs: (input.reasoningDurationMs as number | null) ?? null,
      });
    },
    async setToolResultOutput() {},
    async updateContextMetrics() {},
  };
  return { rows, store };
}

/** The injected clock (AP-28): the fake streamText generator advances it
 *  before each yielded part, so per-chunk timings are deterministic. */
let clockNow = 0;

function makeFakeStreamText(
  parts: Array<() => unknown>,
  opts: { lateUsageTick?: number } = {},
): ReturnType<typeof import("ai").streamText> {
  const usage =
    opts.lateUsageTick !== undefined
      ? // A thenable that advances the clock BEFORE resolving — a deterministic
        // stand-in for "time passed between the last chunk and the persist"
        // (parked-promise discipline, never a sleep).
        {
          then(onFulfilled: (v: unknown) => unknown) {
            clockNow = opts.lateUsageTick!;
            return Promise.resolve().then(() => onFulfilled(undefined));
          },
        }
      : Promise.resolve(undefined);
  return (() => {
    async function* gen(): AsyncGenerator<unknown, void, unknown> {
      for (const part of parts) yield part();
    }
    return {
      stream: gen(),
      finishReason: Promise.resolve("stop"),
      usage,
    };
  }) as unknown as ReturnType<typeof import("ai").streamText>;
}

function makeProviderProfile(): ProviderProfile {
  return {
    id: "prov_1",
    providerPreset: "openai",
    endpoint: "http://test",
    apiKey: "key",
    defaultModel: "test-model",
    proxyMode: "inherit",
    proxyId: null,
  } as unknown as ProviderProfile;
}

function makeDeps(
  store: ReturnType<typeof createFakeStore>["store"],
  streamText: ReturnType<typeof makeFakeStreamText>,
): AgentStreamDeps {
  const profile = makeProviderProfile();
  return {
    store,
    getProviderProfile: async () => profile,
    getEffectiveProviderProfile: async () => profile,
    resolveModel: () => ({}) as LanguageModel,
    streamText,
    nowMs: () => clockNow,
  };
}

function makeSeams(): AgentStreamSeams {
  return {
    logChannelPrefix: "test.agent-stream",
    threadLabel: "Agent thread",
    limits: { contextBudgetTokens: 100_000, responseReserveTokens: 4_000, toolLoopCeiling: 20 },
    loadContext: async () => null,
    resolveProfile: async () => ({}),
    assemble: async () => ({
      systemMessage: "sys",
      messages: [],
      tokenAccounting: { system: 1, digest: 0, history: 0, attached: 0, total: 1 },
    }),
    buildTools: () => ({}),
  };
}

async function runTurn(streamText: ReturnType<typeof makeFakeStreamText>) {
  const fake = createFakeStore();
  const events: string[] = [];
  for await (const chunk of streamAgentTurn(
    { threadId: "thread_1", content: "hi", providerProfileId: "prov_1" },
    makeDeps(fake.store, streamText),
    makeSeams(),
  )) {
    events.push(chunk.event);
  }
  return { rows: fake.rows, events };
}

// Raw fullStream part builders (createMappedStream maps these to the loop's
// ProviderStreamChunk vocabulary).
const reasoning = (t: number, text: string) => () => {
  clockNow = t;
  return { type: "reasoning-delta", text };
};
const text = (t: number, s: string) => () => {
  clockNow = t;
  return { type: "text-delta", text: s };
};
const toolCall = (t: number, toolCallId: string) => () => {
  clockNow = t;
  return { type: "tool-call", toolCallId, toolName: "write_buffer", input: { target: "rules" } };
};
const toolResult = (t: number, toolCallId: string) => () => {
  clockNow = t;
  return { type: "tool-result", toolCallId, toolName: "write_buffer", output: { ok: true } };
};

/** The turn's rows minus the content-mode user row. */
function assistantRows(rows: RecordedRow[]): RecordedRow[] {
  return rows.filter((r) => r.role !== "user");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("streamAgentTurn - reasoning persistence (AP-28)", () => {
  it("a text-first turn pins the reasoning on its (first) text row", async () => {
    const { rows, events } = await runTurn(
      makeFakeStreamText([reasoning(1_000, "Let me think..."), text(4_000, "Answer")]),
    );

    expect(events).toContain("finish");
    // Row order/count: exactly ONE assistant text row (plus the user row).
    expect(assistantRows(rows)).toHaveLength(1);
    const [textRow] = assistantRows(rows);
    expect(textRow.role).toBe("assistant");
    expect(textRow.content).toBe("Answer");
    expect(textRow.reasoning).toBe("Let me think...");
    expect(textRow.reasoningDurationMs).toBe(3_000);
  });

  it("a tool-first turn pins the reasoning on the tool-call row (the first row written)", async () => {
    const { rows } = await runTurn(
      makeFakeStreamText([
        reasoning(1_000, "I should edit the buffer first"),
        toolCall(2_500, "tc_1"),
        toolResult(3_000, "tc_1"),
        text(3_500, "Done editing"),
      ]),
    );

    // Row order/count: tool-call carrier, tool result, then the text row.
    expect(assistantRows(rows).map((r) => r.role)).toEqual(["assistant", "tool", "assistant"]);
    const [carrierRow, , textRow] = assistantRows(rows);
    expect(carrierRow.toolCallsJson).toContain("tc_1");
    expect(carrierRow.reasoning).toBe("I should edit the buffer first");
    expect(carrierRow.reasoningDurationMs).toBe(1_500);
    // The turn's LATER rows carry no reasoning — the pair rides the first
    // assistant row only.
    expect(textRow.reasoning).toBeNull();
    expect(textRow.reasoningDurationMs).toBeNull();
  });

  it("several bursts join in arrival order with a blank line; the duration sums per-burst elapsed", async () => {
    const { rows } = await runTurn(
      makeFakeStreamText([
        reasoning(1_000, "burst one"),
        text(3_000, "interlude"),
        reasoning(5_000, "burst two"),
        toolCall(7_000, "tc_2"),
        toolResult(7_500, "tc_2"),
        text(8_000, "final"),
      ]),
    );

    // Rows: text("interlude") first, then the tool-call carrier, tool result,
    // and the final text row — the first assistant row is the interlude text.
    expect(assistantRows(rows).map((r) => r.content)).toEqual([
      "interlude",
      "",
      JSON.stringify({ toolName: "write_buffer", output: { ok: true } }),
      "final",
    ]);
    const [firstRow] = assistantRows(rows);
    expect(firstRow.reasoning).toBe("burst one\n\nburst two");
    // Burst 1: 1000→3000; burst 2: 5000→7000 (closed by the tool-call chunk).
    expect(firstRow.reasoningDurationMs).toBe(4_000);
    expect(assistantRows(rows).slice(1).every((r) => r.reasoning === null)).toBe(true);
  });

  it("a turn without reasoning persists nulls (no reasoning anywhere)", async () => {
    const { rows } = await runTurn(makeFakeStreamText([text(1_000, "plain answer")]));

    expect(assistantRows(rows)).toHaveLength(1);
    expect(assistantRows(rows)[0].reasoning).toBeNull();
    expect(assistantRows(rows)[0].reasoningDurationMs).toBeNull();
  });

  it("a burst still open when the turn ends counts its elapsed so far", async () => {
    // The reasoning burst opens at t=2_000 and the stream simply ENDS — the
    // finish's usage thenable advances the clock to t=6_000 before the loop
    // persists, so the open burst's finalized elapsed is 4_000 ms.
    const { rows } = await runTurn(
      makeFakeStreamText([text(1_000, "partial"), reasoning(2_000, "cut off mid")], {
        lateUsageTick: 6_000,
      }),
    );

    const [textRow] = assistantRows(rows);
    expect(textRow.content).toBe("partial");
    expect(textRow.reasoning).toBe("cut off mid");
    expect(textRow.reasoningDurationMs).toBe(4_000);
  });

  it("reasoning with no persistable row writes NO assistant row — rows are never invented for reasoning", async () => {
    const { rows, events } = await runTurn(makeFakeStreamText([reasoning(1_000, "thinking")]));

    // The turn produced only reasoning (no text, no tools) → the same zero
    // assistant rows as before AP-28 (row order/count unchanged) and a CLEAN
    // finish — the reasoning is dropped with no row to pin it on.
    expect(assistantRows(rows)).toHaveLength(0);
    expect(events).toContain("finish");
  });
});

// ─── History identity (the core safety property, AP-28) ──────────────────────

/** A stored row shaped like the store's projection. */
function storedRow(over: Partial<ExperienceCopilotMessage>): ExperienceCopilotMessage {
  return {
    id: brandId<ExperienceCopilotMessageId>("m1"),
    threadId: brandId<ExperienceCopilotThreadId>("thread_1"),
    role: "assistant",
    content: "answer",
    toolCallsJson: null,
    toolCallId: null,
    reasoning: null,
    reasoningDurationMs: null,
    seq: null,
    createdAt: "2026-10-25T00:00:00.000Z",
    ...over,
  };
}

describe("reasoning is never sent back to the model (AP-28 history identity)", () => {
  // One thread-shaped row set: user ask, assistant tool-call carrier, tool
  // result, assistant text — the full role variety the fold handles.
  const rowsWithout = [
    storedRow({ id: brandId<ExperienceCopilotMessageId>("u1"), role: "user", content: "tweak it" }),
    storedRow({
      id: brandId<ExperienceCopilotMessageId>("a1"),
      content: "",
      toolCallsJson: JSON.stringify([{ type: "tool-call", toolCallId: "tc_1", toolName: "write_buffer", input: { target: "rules" } }]),
    }),
    storedRow({
      id: brandId<ExperienceCopilotMessageId>("t1"),
      role: "tool",
      content: JSON.stringify({ toolName: "write_buffer", output: { ok: true } }),
      toolCallId: "tc_1",
    }),
    storedRow({ id: brandId<ExperienceCopilotMessageId>("a2"), content: "edited" }),
  ];
  // The SAME rows carrying the reasoning pair on the first assistant row —
  // exactly what the loop persists after AP-28.
  const rowsWith = rowsWithout.map((row, i) =>
    i === 1 ? { ...row, reasoning: "burst one\n\nburst two", reasoningDurationMs: 4_000 } : row,
  );

  it("the store fold (storeMessagesToHistory) is identical with and without reasoning", () => {
    expect(storeMessagesToHistory(rowsWith)).toEqual(storeMessagesToHistory(rowsWithout));
  });

  it("the prompt formatter's token estimate (metrics/compaction input) is identical", () => {
    // Install a real (char-length) counter for the duration so the equality
    // is non-vacuous — the formatted history actually renders, and leaked
    // reasoning would change the count. Restored to the unset-equivalent
    // (fn returning 0) because estimateTokens is process-global under
    // bun:test (same discipline as experience-copilot-stream.test.ts).
    setTokenCountFn((text: string) => text.length);
    try {
      const flowWith = storeMessagesToHistory(rowsWith).filter((m): m is AgentFlowMessage => m.role !== "digest");
      const flowWithout = storeMessagesToHistory(rowsWithout).filter((m): m is AgentFlowMessage => m.role !== "digest");
      expect(estimateHistoryTokens(flowWith)).toBeGreaterThan(0);
      expect(estimateHistoryTokens(flowWith)).toBe(estimateHistoryTokens(flowWithout));
    } finally {
      setTokenCountFn(() => 0);
    }
  });

  it("the digest-boundary split feeds the fold identical keep-windows", () => {
    const withBoundary = resolveDigestBoundary(rowsWith);
    const withoutBoundary = resolveDigestBoundary(rowsWithout);
    expect(storeMessagesToHistory(withBoundary.kept)).toEqual(storeMessagesToHistory(withoutBoundary.kept));
    expect(storeMessagesToHistory(withBoundary.covered)).toEqual(storeMessagesToHistory(withoutBoundary.covered));
  });
});
