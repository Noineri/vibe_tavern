import { beforeEach, describe, expect, it } from "bun:test";
import { assemblePrompt } from "../src/assemble.ts";
import { findSafeCompactionBoundary, planHistoryCompaction, setTokenCountFn } from "../src/compaction.ts";

const history = [
  { id: "msg_1", role: "user" as const, content: "Old user message." },
  { id: "msg_2", role: "assistant" as const, content: "Old assistant message." },
  { id: "msg_3", role: "user" as const, content: "Recent user message." },
  { id: "msg_4", role: "assistant" as const, content: "Recent assistant message." },
];

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    identity: { chatId: "chat_1" },
    character: {
      id: "char_1",
      name: "Aria",
      description: "A fire mage.",
      systemPrompt: null,
    },
    chat: { recentMessages: history },
    ...overrides,
  };
}

function historyLayer(result: ReturnType<typeof assemblePrompt>) {
  const layer = result.layers.find((candidate) => candidate.id === "recent_history");
  if (!layer) throw new Error("Expected a recent-history layer.");
  return layer;
}

beforeEach(() => {
  setTokenCountFn((text) => text.length);
});

describe("history compaction budget", () => {
  it("finds the largest fitting suffix without rescanning a long history quadratically", () => {
    const messages = Array.from({ length: 1_000 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index}`,
    }));
    let countCalls = 0;

    const plan = planHistoryCompaction({
      messages,
      nonHistoryTokens: 0,
      contextBudget: 101,
      countHistoryTokens: (candidate) => {
        countCalls += 1;
        return candidate.length;
      },
    });

    expect(plan?.messages).toHaveLength(101);
    expect(plan?.messages[0]?.content).toBe("message-899");
    expect(plan?.preservedHistoryTokens).toBe(101);
    expect(countCalls).toBeLessThanOrEqual(14);
  });

  it("does not tokenize the full history when a smaller suffix already proves overflow", () => {
    const messages = Array.from({ length: 1_000 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index}`,
    }));
    const countedLengths: number[] = [];

    const plan = planHistoryCompaction({
      messages,
      nonHistoryTokens: 0,
      contextBudget: 664,
      countHistoryTokens: (candidate) => {
        countedLengths.push(candidate.length);
        return candidate.length;
      },
    });

    expect(plan?.messages).toHaveLength(664);
    expect(countedLengths).not.toContain(messages.length);
  });

  it("compacts when response reserve makes an otherwise fitting prompt exceed context", () => {
    const unbounded = assemblePrompt(baseContext());
    const result = assemblePrompt(baseContext({
      config: {
        contextBudget: unbounded.totalTokenEstimate + 5,
        responseReserve: 10,
      },
    }));

    expect(result.compactionSummary).toBeDefined();
    expect(historyLayer(result).text).not.toContain("Old user message.");
  });

  it("counts dialogue examples, character depth, and script injections before planning history", () => {
    const withLateLayers = baseContext({
      character: {
        id: "char_1",
        name: "Aria",
        description: "A fire mage.",
        mesExample: "Example dialogue.".repeat(20),
        depthPrompt: "Character depth instruction.".repeat(20),
      },
      chat: {
        recentMessages: history,
        scriptInjections: [{ role: "system" as const, content: "Script instruction.".repeat(20) }],
      },
    });
    const unbounded = assemblePrompt(withLateLayers);
    const lateLayerTokens = unbounded.layers
      .filter((layer) => ["mes_example", "character_depth_prompt", "script_injection_0"].includes(layer.id))
      .reduce((total, layer) => total + layer.tokenCount, 0);
    const result = assemblePrompt({
      ...withLateLayers,
      config: { contextBudget: unbounded.totalTokenEstimate - lateLayerTokens },
    });

    expect(result.compactionSummary).toBeDefined();
    expect(historyLayer(result).text).not.toContain("Old user message.");
  });

  it("uses formatted history token cost rather than individually tokenized messages", () => {
    const unbounded = assemblePrompt(baseContext());
    const individuallyFormattedTokens = history.reduce(
      (total, message) => total + `${message.role.toUpperCase()}: ${message.content}`.length,
      0,
    );
    const result = assemblePrompt(baseContext({
      config: {
        contextBudget: unbounded.totalTokenEstimate - historyLayer(unbounded).tokenCount + individuallyFormattedTokens,
      },
    }));

    expect(result.compactionSummary).toBeDefined();
    expect(historyLayer(result).text).not.toContain("Old user message.");
  });

  it("keeps an assistant tool call with its first preserved tool result", () => {
    const toolHistory = [
      { id: "msg_1", role: "user" as const, content: "Old message.".repeat(20) },
      { id: "msg_2", role: "assistant" as const, content: "Calling a tool." },
      { id: "msg_3", role: "tool" as const, content: "Tool result." },
      { id: "msg_4", role: "user" as const, content: "What happened?" },
      { id: "msg_5", role: "assistant" as const, content: "Here is the result." },
    ];
    const unbounded = assemblePrompt(baseContext({ chat: { recentMessages: toolHistory } }));
    const nonHistoryTokens = unbounded.totalTokenEstimate - historyLayer(unbounded).tokenCount;
    const result = assemblePrompt(baseContext({
      chat: { recentMessages: toolHistory },
      config: { contextBudget: nonHistoryTokens + 100 },
    }));

    expect(result.compactionSummary).toBeDefined();
    const text = historyLayer(result).text;
    expect(text).toContain("ASSISTANT: Calling a tool.");
    expect(text).toContain("TOOL: Tool result.");
    expect(text).not.toContain("Old message.");
  });

  it("never starts the preserved block with an assistant message carrying tool calls", () => {
    // Regression (experience copilot × Gemini-style upstreams): the budget trim
    // could cut away the user request and leave the assistant tool-call run as
    // the first preserved message — functionCall-after-user providers then 400
    // the whole request. The boundary must step back to the triggering user.
    const toolHistory = [
      { role: "user" as const, content: "Build me a grid starter." },
      { role: "assistant" as const, content: "", toolCalls: [{ toolCallId: "tc_1" }] },
      { role: "tool" as const, content: "skill body" },
      { role: "user" as const, content: "Now polish it." },
      { role: "assistant" as const, content: "Done." },
    ];
    // Direct boundary unit: preserving the last 3 messages would land the cut
    // on the assistant-with-calls row; the walk must return the user index.
    expect(findSafeCompactionBoundary(toolHistory, 3)).toBe(0);

    // And through the planner: compaction under a tight budget either keeps a
    // user head or declines to compact — never emits a tool-call assistant head.
    const plan = planHistoryCompaction({
      messages: toolHistory,
      nonHistoryTokens: 0,
      contextBudget: 1,
      countHistoryTokens: () => 1,
    });
    const preserved = plan?.messages ?? toolHistory;
    const head = preserved[0];
    const headCarriesCalls = head.role === "assistant" && Array.isArray((head as { toolCalls?: unknown[] }).toolCalls) && ((head as { toolCalls?: unknown[] }).toolCalls?.length ?? 0) > 0;
    expect(headCarriesCalls).toBe(false);
  });
});
