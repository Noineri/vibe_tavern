import { beforeEach, describe, expect, it } from "bun:test";
import { assemblePrompt } from "../src/assemble.ts";
import { setTokenCountFn } from "../src/compaction.ts";

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
});
