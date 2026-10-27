import { describe, it, expect } from "bun:test";
import { NoOutputGeneratedError, type TextStreamPart, type ToolSet } from "ai";
import {
  createMappedStream,
  mapFinish,
  safeStreamTextPromise,
  safeReasoningPromise,
} from "../src/infrastructure/ai/stream-helpers.js";

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Create an async iterable from an array of stream parts. */
async function* fromParts(parts: TextStreamPart<ToolSet>[]): AsyncGenerator<TextStreamPart<ToolSet>, void, unknown> {
  for (const p of parts) yield p;
}

/** Collect all chunks from a mapped stream. */
async function collect(stream: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// createMappedStream
// ═══════════════════════════════════════════════════════════════════════════

describe("createMappedStream", () => {
  it("yields text-delta chunks", async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "text-delta", id: "text-1", text: "Hello " },
      { type: "text-delta", id: "text-1", text: "world" },
    ];
    const { stream } = createMappedStream(fromParts(parts));
    const chunks = await collect(stream);
    expect(chunks).toEqual([
      { type: "text-delta", delta: "Hello " },
      { type: "text-delta", delta: "world" },
    ]);
  });

  it("yields native reasoning-delta chunks (v7 `text` field)", async () => {
    // AI SDK v7 TextStreamReasoningDeltaPart carries the text in `text`, NOT
    // `delta` — this regression test pins the real v7 shape (a hand-cast hid
    // the rename and silently dropped ALL reasoning).
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "reasoning-delta", id: "r1", text: "thinking..." },
    ];
    const { stream } = createMappedStream(fromParts(parts));
    const chunks = await collect(stream);
    expect(chunks).toEqual([
      { type: "reasoning-delta", textDelta: "thinking..." },
    ]);
  });


  it("yields tool-call chunks with args and replay-critical provider metadata", async () => {
    // AI SDK v6 fullStream `tool-call` carries parsed args as `input` and
    // provider-specific replay data as `providerMetadata`. Gemini 3 places its
    // thoughtSignature there; dropping it makes the next request replay the
    // functionCall without its reasoning signature.
    const parts: TextStreamPart<ToolSet>[] = [
      {
        type: "tool-call",
        toolCallId: "tc_1",
        toolName: "roll_dice",
        input: { sides: 6 },
        providerMetadata: { google: { thoughtSignature: "sig_google_1" } },
      },
    ];
    const { stream } = createMappedStream(fromParts(parts));
    const chunks = await collect(stream);
    expect(chunks).toEqual([
      {
        type: "tool-call",
        toolCallId: "tc_1",
        toolName: "roll_dice",
        args: { sides: 6 },
        providerOptions: { google: { thoughtSignature: "sig_google_1" } },
      },
    ]);
  });

  it("yields tool-result chunks carrying the execute() output payload", async () => {
    // AI SDK v6 puts the execute() return value on `output`; there is no `isError` flag
    // (failures arrive as a separate `tool-error` part — see the next test).
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "tool-result", toolCallId: "tc_1", toolName: "roll_dice", input: { sides: 6 }, output: { roll: 4 } },
    ];
    const { stream } = createMappedStream(fromParts(parts));
    const chunks = await collect(stream);
    expect(chunks).toEqual([
      { type: "tool-result", toolCallId: "tc_1", toolName: "roll_dice", output: { roll: 4 } },
    ]);
  });

  it("normalizes a tool-error part into a tool-result chunk with isError + error payload", async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "tool-error", toolCallId: "tc_2", toolName: "write_profile", input: {}, error: new Error("invalid heading") },
    ];
    const { stream } = createMappedStream(fromParts(parts));
    const chunks = await collect(stream);
    expect(chunks).toEqual([
      { type: "tool-result", toolCallId: "tc_2", toolName: "write_profile", output: { error: "invalid heading" }, isError: true },
    ]);
  });

  it("forwards tool-input-start and tool-input-delta (progressive tool-arg streaming)", async () => {
    // AI SDK streams tool args as: tool-input-start (toolName) → N× tool-input-delta (inputTextDelta)
    // → final tool-call. Co-Author forwards these so the UI can render the model writing the document.
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "tool-input-start", id: "tc_3", toolName: "write_profile" },
      { type: "tool-input-delta", id: "tc_3", delta: "{\"profileMd\":\"# P" },
      { type: "tool-input-delta", id: "tc_3", delta: "ERSONALITY\"}" },
    ];
    const { stream } = createMappedStream(fromParts(parts));
    const chunks = await collect(stream);
    expect(chunks).toEqual([
      { type: "tool-input-start", toolCallId: "tc_3", toolName: "write_profile" },
      { type: "tool-input-delta", toolCallId: "tc_3", inputTextDelta: "{\"profileMd\":\"# P" },
      { type: "tool-input-delta", toolCallId: "tc_3", inputTextDelta: "ERSONALITY\"}" },
    ]);
  });


  it("throws on error parts with errorText", async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "text-delta", id: "text-1", text: "partial" },
      { type: "error", error: new Error("Rate limited") },
    ];
    const { stream } = createMappedStream(fromParts(parts));
    try {
      await collect(stream);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("Rate limited");
    }
  });

  it("throws on error parts with nested error object", async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "error", error: { data: { error: { message: "Quota exceeded" } } } },
    ];
    const { stream } = createMappedStream(fromParts(parts));
    try {
      await collect(stream);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("Quota exceeded");
    }
  });


  it("collects raw provider chunks and response metadata per model step", async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "start-step", request: {}, warnings: [] },
      { type: "raw", rawValue: { id: "chunk_1", delta: "Hel" } },
      { type: "raw", rawValue: { id: "chunk_2", delta: "lo" } },
      {
        type: "finish-step",
        response: {
          id: "resp_1",
          timestamp: new Date("2026-07-16T12:00:00.000Z"),
          modelId: "model-a",
          headers: {
            "x-ratelimit-remaining-requests": "9",
            "set-cookie": "session=secret",
          },
        },
        usage: {
          inputTokens: 10,
          inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: undefined, cacheWriteTokens: undefined },
          outputTokens: 2,
          outputTokenDetails: { textTokens: 1, reasoningTokens: 1 },
          totalTokens: 12,
        },
        finishReason: "tool-calls",
        performance: { effectiveOutputTokensPerSecond: 0, outputTokensPerSecond: undefined, inputTokensPerSecond: undefined, effectiveTotalTokensPerSecond: 0, stepTimeMs: 0, responseTimeMs: 0, toolExecutionMs: {}, timeToFirstOutputMs: 0 },
        rawFinishReason: "tool_calls",
        providerMetadata: { google: { thoughtSignature: "sig_1" } },
      },
      { type: "start-step", request: { messages: [] }, warnings: [] },
      { type: "raw", rawValue: { id: "chunk_3", delta: "Done" } },
      {
        type: "finish-step",
        response: {
          id: "resp_2",
          timestamp: new Date("2026-07-16T12:00:01.000Z"),
          modelId: "model-a",
          headers: { "retry-after": "2" },
        },
        usage: {
          inputTokens: 20,
          inputTokenDetails: { noCacheTokens: 20, cacheReadTokens: undefined, cacheWriteTokens: undefined },
          outputTokens: 1,
          outputTokenDetails: { textTokens: 1, reasoningTokens: undefined },
          totalTokens: 21,
        },
        finishReason: "stop",
        performance: { effectiveOutputTokensPerSecond: 0, outputTokensPerSecond: undefined, inputTokensPerSecond: undefined, effectiveTotalTokensPerSecond: 0, stepTimeMs: 0, responseTimeMs: 0, toolExecutionMs: {}, timeToFirstOutputMs: 0 },
        rawFinishReason: "stop",
        providerMetadata: undefined,
      },
    ];

    const { stream, state } = createMappedStream(fromParts(parts));
    expect(await collect(stream)).toEqual([]);
    expect(state.providerResponse).toEqual({
      mode: "stream",
      steps: [
        {
          response: {
            id: "resp_1",
            timestamp: "2026-07-16T12:00:00.000Z",
            modelId: "model-a",
            headers: { "x-ratelimit-remaining-requests": "9" },
          },
          providerMetadata: { google: { thoughtSignature: "sig_1" } },
          finishReason: "tool-calls",
          rawFinishReason: "tool_calls",
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          rawChunks: [
            { id: "chunk_1", delta: "Hel" },
            { id: "chunk_2", delta: "lo" },
          ],
        },
        {
          response: {
            id: "resp_2",
            timestamp: "2026-07-16T12:00:01.000Z",
            modelId: "model-a",
            headers: { "retry-after": "2" },
          },
          finishReason: "stop",
          rawFinishReason: "stop",
          usage: { inputTokens: 20, outputTokens: 1, totalTokens: 21 },
          rawChunks: [{ id: "chunk_3", delta: "Done" }],
        },
      ],
    });
  });

  it("ignores text lifecycle parts", async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", text: "hello" },
      { type: "text-end", id: "text-1" },
    ];
    const { stream } = createMappedStream(fromParts(parts));
    const chunks = await collect(stream);
    expect(chunks).toEqual([{ type: "text-delta", delta: "hello" }]);
  });

  it("handles empty stream", async () => {
    const { stream } = createMappedStream(fromParts([]));
    const chunks = await collect(stream);
    expect(chunks).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// mapFinish
// ═══════════════════════════════════════════════════════════════════════════

describe("mapFinish", () => {
  it("maps stop finish reason", async () => {
    const result = mapFinish({
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 20, totalTokens: 30 }),
    });
    expect(await result).toEqual({
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });
  });

  it("maps length finish reason", async () => {
    const result = mapFinish({
      finishReason: Promise.resolve("length"),
      usage: Promise.resolve({}),
    });
    expect((await result).finishReason).toBe("length");
  });

  it("maps content-filter finish reason", async () => {
    const result = mapFinish({
      finishReason: Promise.resolve("content-filter"),
      usage: Promise.resolve({}),
    });
    expect((await result).finishReason).toBe("content-filter");
  });

  it("maps tool-calls finish reason", async () => {
    const result = mapFinish({
      finishReason: Promise.resolve("tool-calls"),
      usage: Promise.resolve({}),
    });
    expect((await result).finishReason).toBe("tool-calls");
  });

  it("maps error finish reason", async () => {
    const result = mapFinish({
      finishReason: Promise.resolve("error"),
      usage: Promise.resolve({}),
    });
    expect((await result).finishReason).toBe("error");
  });

  it.each(["interrupted", "other"] as const)("maps %s finish reason to error", async (reason) => {
    const result = mapFinish({
      finishReason: Promise.resolve(reason),
      usage: Promise.resolve({}),
    });
    expect((await result).finishReason).toBe("error");
  });

  it("does not mistake a failed generation for user cancellation", async () => {
    const result = mapFinish({
      finishReason: Promise.reject(new NoOutputGeneratedError()),
      usage: Promise.resolve({}),
    });
    expect((await result).finishReason).toBe("error");
  });

  it("returns cancelled when signal is aborted and promise rejects", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = mapFinish({
      finishReason: Promise.reject(new Error("abort")),
      usage: Promise.resolve({}),
    }, controller.signal);
    expect((await result).finishReason).toBe("cancelled");
  });

  it("returns error when promise rejects with non-abort, non-NoOutput error", async () => {
    const result = mapFinish({
      finishReason: Promise.reject(new Error("network failure")),
      usage: Promise.resolve({}),
    });
    expect((await result).finishReason).toBe("error");
  });

  it("handles undefined usage", async () => {
    const result = mapFinish({
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve(undefined),
    });
    expect((await result).usage).toBeUndefined();
  });

});


// ═══════════════════════════════════════════════════════════════════════════
// safeStreamTextPromise
// ═══════════════════════════════════════════════════════════════════════════

describe("safeStreamTextPromise", () => {
  it("resolves with text on success", async () => {
    const result = await safeStreamTextPromise(Promise.resolve("Hello world"));
    expect(result).toBe("Hello world");
  });

  it("returns empty string on NoOutputGeneratedError", async () => {
    const err = new NoOutputGeneratedError();
    const result = await safeStreamTextPromise(Promise.reject(err));
    expect(result).toBe("");
  });

  it("returns empty string when signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await safeStreamTextPromise(Promise.reject(new Error("abort")), controller.signal);
    expect(result).toBe("");
  });

  it("returns empty string on generic rejection", async () => {
    const result = await safeStreamTextPromise(Promise.reject(new Error("network error")));
    expect(result).toBe("");
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// safeReasoningPromise
// ═══════════════════════════════════════════════════════════════════════════

describe("safeReasoningPromise", () => {
  it("resolves with reasoning text on success", async () => {
    const result = await safeReasoningPromise(Promise.resolve("I think therefore..."));
    expect(result).toBe("I think therefore...");
  });

  it("resolves with undefined when reasoning is undefined", async () => {
    const result = await safeReasoningPromise(Promise.resolve(undefined));
    expect(result).toBeUndefined();
  });

  it("returns undefined on NoOutputGeneratedError", async () => {
    const err = new NoOutputGeneratedError();
    const result = await safeReasoningPromise(Promise.reject(err));
    expect(result).toBeUndefined();
  });

  it("returns undefined when signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await safeReasoningPromise(Promise.reject(new Error("abort")), controller.signal);
    expect(result).toBeUndefined();
  });

  it("returns undefined on generic rejection", async () => {
    const result = await safeReasoningPromise(Promise.reject(new Error("failure")));
    expect(result).toBeUndefined();
  });

});
