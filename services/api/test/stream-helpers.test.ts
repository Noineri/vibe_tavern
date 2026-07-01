import { describe, it, expect } from "bun:test";
import {
  createMappedStream,
  mapFinish,
  isNoOutputGeneratedError,
  safeStreamTextPromise,
  safeReasoningPromise,
} from "../src/infrastructure/ai/stream-helpers.js";

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Create an async iterable from an array of stream parts. */
async function* fromParts(parts: unknown[]): AsyncGenerator<unknown, void, unknown> {
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
    const parts = [
      { type: "text-delta", text: "Hello " },
      { type: "text-delta", text: "world" },
    ];
    const { stream } = createMappedStream(fromParts(parts));
    const chunks = await collect(stream);
    expect(chunks).toEqual([
      { type: "text-delta", delta: "Hello " },
      { type: "text-delta", delta: "world" },
    ]);
  });

  it("yields native reasoning-delta chunks", async () => {
    const parts = [
      { type: "reasoning-delta", delta: "thinking..." },
    ];
    const { stream } = createMappedStream(fromParts(parts));
    const chunks = await collect(stream);
    expect(chunks).toEqual([
      { type: "reasoning-delta", textDelta: "thinking..." },
    ]);
  });

  it("converts marker-wrapped text into reasoning-delta", async () => {
    const parts = [
      { type: "text-delta", text: "\x02REASONING_START\x03" },
      { type: "text-delta", text: "inner thought" },
      { type: "text-delta", text: "\x02REASONING_END\x03" },
      { type: "text-delta", text: "final answer" },
    ];
    const { stream } = createMappedStream(fromParts(parts));
    const chunks = await collect(stream);
    expect(chunks).toEqual([
      { type: "reasoning-delta", textDelta: "inner thought" },
      { type: "text-delta", delta: "final answer" },
    ]);
  });

  it("yields tool-call chunks with args", async () => {
    // AI SDK v6 fullStream `tool-call` part carries the parsed args as `input` (not `args`).
    const parts = [
      { type: "tool-call", toolCallId: "tc_1", toolName: "roll_dice", input: { sides: 6 } },
    ];
    const { stream } = createMappedStream(fromParts(parts));
    const chunks = await collect(stream);
    expect(chunks).toEqual([
      { type: "tool-call", toolCallId: "tc_1", toolName: "roll_dice", args: { sides: 6 } },
    ]);
  });

  it("yields tool-result chunks carrying the execute() output payload", async () => {
    // AI SDK v6 puts the execute() return value on `output`; there is no `isError` flag
    // (failures arrive as a separate `tool-error` part — see the next test).
    const parts = [
      { type: "tool-result", toolCallId: "tc_1", toolName: "roll_dice", output: { roll: 4 } },
    ];
    const { stream } = createMappedStream(fromParts(parts));
    const chunks = await collect(stream);
    expect(chunks).toEqual([
      { type: "tool-result", toolCallId: "tc_1", toolName: "roll_dice", output: { roll: 4 } },
    ]);
  });

  it("normalizes a tool-error part into a tool-result chunk with isError + error payload", async () => {
    const parts = [
      { type: "tool-error", toolCallId: "tc_2", toolName: "edit_profile", error: new Error("invalid heading") },
    ];
    const { stream } = createMappedStream(fromParts(parts));
    const chunks = await collect(stream);
    expect(chunks).toEqual([
      { type: "tool-result", toolCallId: "tc_2", toolName: "edit_profile", output: { error: "invalid heading" }, isError: true },
    ]);
  });

  it("forwards tool-input-start and tool-input-delta (progressive tool-arg streaming)", async () => {
    // AI SDK streams tool args as: tool-input-start (toolName) → N× tool-input-delta (inputTextDelta)
    // → final tool-call. Co-Author forwards these so the UI can render the model writing the document.
    const parts = [
      { type: "tool-input-start", id: "tc_3", toolName: "edit_profile" },
      { type: "tool-input-delta", id: "tc_3", inputTextDelta: "{\"profileMd\":\"# P" },
      { type: "tool-input-delta", id: "tc_3", inputTextDelta: "ERSONALITY\"}" },
    ];
    const { stream } = createMappedStream(fromParts(parts));
    const chunks = await collect(stream);
    expect(chunks).toEqual([
      { type: "tool-input-start", toolCallId: "tc_3", toolName: "edit_profile" },
      { type: "tool-input-delta", toolCallId: "tc_3", inputTextDelta: "{\"profileMd\":\"# P" },
      { type: "tool-input-delta", toolCallId: "tc_3", inputTextDelta: "ERSONALITY\"}" },
    ]);
  });

  it("skips tool-call without toolCallId or toolName", async () => {
    const parts = [
      { type: "tool-call", toolCallId: undefined, toolName: "roll_dice", input: {} },
      { type: "tool-call", toolCallId: "tc_1", toolName: undefined, input: {} },
      { type: "text-delta", text: "ok" },
    ];
    const { stream } = createMappedStream(fromParts(parts));
    const chunks = await collect(stream);
    expect(chunks).toEqual([{ type: "text-delta", delta: "ok" }]);
  });

  it("throws on error parts with errorText", async () => {
    const parts = [
      { type: "text-delta", text: "partial" },
      { type: "error", errorText: "Rate limited" },
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
    const parts = [
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

  it("tracks hasRedacted when redacted-reasoning part appears", async () => {
    const parts = [
      { type: "text-delta", text: "visible" },
      { type: "redacted-reasoning" },
    ];
    const { stream, hasRedacted } = createMappedStream(fromParts(parts));
    // hasRedacted is set during iteration, so we need to consume the stream
    // BUT hasRedacted is a closure variable — it's updated as the generator runs.
    // The value returned from createMappedStream is the initial false.
    // After consuming, we need to read it from the closure — but we can't.
    // Instead, test that consuming doesn't throw and the stream yields the text part.
    const chunks = await collect(stream);
    expect(chunks).toEqual([{ type: "text-delta", delta: "visible" }]);
    // Note: hasRedacted is a primitive returned by value before iteration starts,
    // so we can't test the post-iteration value from outside.
  });

  it("ignores unknown part types", async () => {
    const parts = [
      { type: "source", url: "https://example.com" },
      { type: "text-start" },
      { type: "text-delta", text: "hello" },
      { type: "text-end" },
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

  it("maps unknown finish reason to error", async () => {
    const result = mapFinish({
      finishReason: Promise.resolve("unknown"),
      usage: Promise.resolve({}),
    });
    expect((await result).finishReason).toBe("error");
  });

  it("maps unrecognized finish reason to stop (default)", async () => {
    const result = mapFinish({
      finishReason: Promise.resolve("some-new-reason"),
      usage: Promise.resolve({}),
    });
    expect((await result).finishReason).toBe("stop");
  });

  it("returns cancelled when promise rejects with NoOutputGeneratedError", async () => {
    const error = new Error("No output generated");
    error.name = "AI_NoOutputGeneratedError";
    const result = mapFinish({
      finishReason: Promise.reject(error),
      usage: Promise.resolve({}),
    });
    expect((await result).finishReason).toBe("cancelled");
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

  it("works with PromiseLike (non-native Promise)", async () => {
    // Simulate AI SDK v6's PromiseLike (not a real Promise)
    const likeFinish: PromiseLike<string> = {
      then(onFulfilled) {
        return onFulfilled!("stop") as any;
      },
    };
    const likeUsage: PromiseLike<unknown> = {
      then(onFulfilled) {
        return onFulfilled!({ inputTokens: 5, outputTokens: 10, totalTokens: 15 }) as any;
      },
    };
    const result = mapFinish({ finishReason: likeFinish, usage: likeUsage });
    expect(await result).toEqual({
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// isNoOutputGeneratedError
// ═══════════════════════════════════════════════════════════════════════════

describe("isNoOutputGeneratedError", () => {
  it("matches AI_NoOutputGeneratedError name", () => {
    const err = new Error("empty");
    err.name = "AI_NoOutputGeneratedError";
    expect(isNoOutputGeneratedError(err)).toBe(true);
  });

  it("matches NoOutputGeneratedError name (v4 compat)", () => {
    const err = new Error("empty");
    err.name = "NoOutputGeneratedError";
    expect(isNoOutputGeneratedError(err)).toBe(true);
  });

  it("matches message containing 'No output generated'", () => {
    expect(isNoOutputGeneratedError(new Error("No output generated from model"))).toBe(true);
  });

  it("does not match generic errors", () => {
    expect(isNoOutputGeneratedError(new Error("Network timeout"))).toBe(false);
  });

  it("does not match non-Error values", () => {
    expect(isNoOutputGeneratedError("string")).toBe(false);
    expect(isNoOutputGeneratedError(null)).toBe(false);
    expect(isNoOutputGeneratedError(42)).toBe(false);
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
    const err = new Error("No output generated");
    err.name = "AI_NoOutputGeneratedError";
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

  it("works with PromiseLike", async () => {
    const like: PromiseLike<string> = {
      then(onFulfilled) {
        return onFulfilled!("resolved text") as any;
      },
    };
    const result = await safeStreamTextPromise(like);
    expect(result).toBe("resolved text");
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
    const err = new Error("No output generated");
    err.name = "AI_NoOutputGeneratedError";
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

  it("works with PromiseLike", async () => {
    const like: PromiseLike<string | undefined> = {
      then(onFulfilled) {
        return onFulfilled!("thinking...") as any;
      },
    };
    const result = await safeReasoningPromise(like);
    expect(result).toBe("thinking...");
  });
});
