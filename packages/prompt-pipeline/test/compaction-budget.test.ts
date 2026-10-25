import { beforeEach, describe, expect, it } from "bun:test";
import { assemblePrompt } from "../src/assemble.ts";
import { findSafeCompactionBoundary, planHistoryCompaction, setTokenCountFn } from "../src/compaction.ts";
import type { Attachment } from "@vibe-tavern/domain";
import type { RecentMessage } from "../src/types.js";

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

describe("file history budget characterization (CA-1c)", () => {
  it("pins every layer count, history text and payload for attachment-free history", () => {
    const result = assemblePrompt(baseContext());
    const characterText = "Character: Aria\nA fire mage.";
    const historyText = "USER: Old user message.\n\nASSISTANT: Old assistant message.\n\nUSER: Recent user message.\n\nASSISTANT: Recent assistant message.";
    expect(result.layers.map(({ id, tokenCount, text }) => ({ id, tokenCount, text }))).toEqual([
      { id: "character_base", tokenCount: characterText.length, text: characterText },
      { id: "recent_history", tokenCount: historyText.length, text: historyText },
    ]);
    expect(result.totalTokenEstimate).toBe(characterText.length + historyText.length);
    expect(result.compactionSummary).toBeNull();
    expect(result.finalPayload.messages).toEqual([
      { role: "system", content: characterText, layerId: "character_base" },
      ...history.map(({ id, role, content }) => ({ messageId: id, role, content })),
    ]);
    expect(assemblePrompt(baseContext({ config: { contextBudget: result.totalTokenEstimate } }))).toEqual(result);
  });
});

describe("attached files in the RP history budget (CA-1c)", () => {
  const file: Attachment = {
    id: "file_1", assetId: "asset_file_1", type: "file", name: "notes.md",
    mimeType: "text/markdown", sizeBytes: 10, tokenCount: 400_000,
  };

  function messagesWithFile(attachment = file): RecentMessage[] {
    return history.map((message) => message.id === "msg_3"
      ? { ...message, attachments: [attachment] }
      : message);
  }

  it("an over-budget recent file drops older messages but preserves the full recent pair and truthful count", () => {
    const unbounded = assemblePrompt(baseContext());
    const config = { contextBudget: unbounded.totalTokenEstimate + 10 };
    const withoutFile = assemblePrompt(baseContext({ config }));
    const withFile = assemblePrompt(baseContext({ config, chat: { recentMessages: messagesWithFile() } }));
    expect(withoutFile).toEqual(unbounded);
    expect(withFile.compactionSummary).not.toBeNull();
    expect(withFile.finalPayload.messages.length).toBeLessThan(withoutFile.finalPayload.messages.length);
    expect(withFile.finalPayload.messages.slice(1)).toEqual([
      { messageId: "msg_3", role: "user", content: "Recent user message.", attachments: [file] },
      { messageId: "msg_4", role: "assistant", content: "Recent assistant message." },
    ]);
    const text = "USER: Recent user message.\n\nASSISTANT: Recent assistant message.";
    expect(historyLayer(withFile).text).toBe(text);
    expect(historyLayer(withFile).tokenCount).toBe(text.length + 400_000);
    expect(withFile.totalTokenEstimate).toBeGreaterThan(config.contextBudget);
  });

  it("the meter's history layer adds the file weight without changing any text or non-history layer", () => {
    const withoutFile = assemblePrompt(baseContext());
    const withFile = assemblePrompt(baseContext({ chat: { recentMessages: messagesWithFile() } }));
    expect(withFile.layers).toEqual(withoutFile.layers.map((layer) => layer.id === "recent_history"
      ? { ...layer, tokenCount: layer.tokenCount + 400_000 }
      : layer));
    expect(withFile.totalTokenEstimate).toBe(withoutFile.totalTokenEstimate + 400_000);
    expect(withFile.finalPayload.messages).toEqual([
      withoutFile.finalPayload.messages[0],
      ...messagesWithFile().map(({ id, role, content, attachments }) => ({
        messageId: id, role, content, ...(attachments ? { attachments } : {}),
      })),
    ]);
  });

  it("summaries use their own stored or estimated weight in the history layer", () => {
    const baseline = historyLayer(assemblePrompt(baseContext())).tokenCount;
    for (const [attachment, weight] of [
      [{ ...file, description: "Summary", summaryTokenCount: 9 }, 9],
      [{ ...file, description: "  Summary\n" }, "  Summary\n".length],
      [{ ...file, description: " \t\n", summaryTokenCount: 9 }, 400_000],
      [{ ...file, tokenCount: undefined }, 0],
      [{ ...file, type: "image", mimeType: "image/png", description: "An image" }, 0],
    ] as const) {
      const result = assemblePrompt(baseContext({ chat: { recentMessages: messagesWithFile(attachment) } }));
      expect(historyLayer(result).tokenCount).toBe(baseline + weight);
    }
  });

  it("summary weights drive compaction too, while a small summary restores the original window", () => {
    const withoutFile = assemblePrompt(baseContext());
    const config = { contextBudget: withoutFile.totalTokenEstimate + 10 };
    for (const attachment of [
      { ...file, tokenCount: 1, description: "Large summary", summaryTokenCount: 400_000 },
      { ...file, tokenCount: 1, description: "s".repeat(400_000) },
    ]) {
      const result = assemblePrompt(baseContext({ config, chat: { recentMessages: messagesWithFile(attachment) } }));
      expect(result.compactionSummary).not.toBeNull();
      expect(historyLayer(result).text).not.toContain("Old user message.");
      expect(historyLayer(result).tokenCount).toBe(historyLayer(result).text.length + 400_000);
    }
    const small = assemblePrompt(baseContext({
      config, chat: { recentMessages: messagesWithFile({ ...file, description: "Small", summaryTokenCount: 5 }) },
    }));
    expect(small.compactionSummary).toBeNull();
    expect(historyLayer(small).text).toBe(historyLayer(withoutFile).text);
    expect(historyLayer(small).tokenCount).toBe(historyLayer(withoutFile).tokenCount + 5);
  });

  it("prepending messages never reduces suffix cost, including empty messages and mixed attachment weights", () => {
    const messages: RecentMessage[] = [
      ...messagesWithFile(),
      { id: "empty", role: "user", content: "", attachments: [{ ...file, tokenCount: 0 }] },
      { id: "summary", role: "user", content: "Summary turn", attachments: [{ ...file, description: "Summary" }] },
    ];
    let previous = 0;
    for (let start = messages.length - 1; start >= 0; start -= 1) {
      const suffix = messages.slice(start);
      const result = assemblePrompt(baseContext({ chat: { recentMessages: suffix } }));
      const count = historyLayer(result).tokenCount;
      expect(count).toBeGreaterThanOrEqual(previous);
      previous = count;
    }
  });
});
