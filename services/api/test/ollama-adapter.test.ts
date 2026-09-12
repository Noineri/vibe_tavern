import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { streamText } from "ai";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { createOllamaModel, fetchOllamaModels, tokenizeOllama } from "../src/domain/providers/ollama-adapter.js";

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

function mockJson(response: unknown, status = 200) {
  mockFetch = mock(async () => new Response(JSON.stringify(response), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
  globalThis.fetch = mockFetch as typeof fetch;
}

function mockNdjson(lines: unknown[], status = 200) {
  mockFetch = mock(async () => new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", {
    status,
    headers: { "Content-Type": "application/x-ndjson" },
  }));
  globalThis.fetch = mockFetch as typeof fetch;
}

// Byte-level control over the wire: the adapter owns line reassembly and UTF-8
// decoding, and neither is exercised when the whole body arrives in one chunk.
function mockByteChunks(chunks: readonly (string | Uint8Array)[], status = 200) {
  const encoder = new TextEncoder();
  mockFetch = mock(async () => new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        }
        controller.close();
      },
    }),
    { status, headers: { "Content-Type": "application/x-ndjson" } },
  ));
  globalThis.fetch = mockFetch as typeof fetch;
}

// Splits text at a byte offset that falls INSIDE a multi-byte character, so
// each half is invalid UTF-8 on its own and only the joined pair decodes.
function splitBytes(text: string, at: number): [Uint8Array, Uint8Array] {
  const bytes = new TextEncoder().encode(text);
  return [bytes.slice(0, at), bytes.slice(at)];
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

// Restoring only in beforeEach leaves the LAST test's mock installed on
// globalThis for the rest of the process. api tests share one process, so every
// later file that makes a real request silently got this file's canned JSON.
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Ollama adapter — doGenerate", () => {
  it("posts to /api/chat and returns generated text", async () => {
    mockJson({
      model: "gemma3:4b",
      message: { role: "assistant", content: "Hello!" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 5,
      eval_count: 2,
    });

    const model = createOllamaModel({ baseURL: "http://localhost:11434", modelId: "gemma3:4b" });
    const result = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      temperature: 0.7,
      maxOutputTokens: 64,
      providerOptions: { ollama: { top_k: 40, min_p: 0.05, repeat_penalty: 1.15 } },
    });

    expect(result.content).toEqual([{ type: "text", text: "Hello!" }]);
    expect(result.finishReason.unified).toBe("stop");
    expect(result.usage.inputTokens.total).toBe(5);
    expect(result.usage.outputTokens.total).toBe(2);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:11434/api/chat");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      model: "gemma3:4b",
      stream: false,
      messages: [{ role: "user", content: "Hi" }],
      options: {
        temperature: 0.7,
        num_predict: 64,
        top_k: 40,
        min_p: 0.05,
        repeat_penalty: 1.15,
      },
    });
  });

  it("serializes system/user/assistant messages", async () => {
    mockJson({ message: { role: "assistant", content: "ok" }, done: true });
    const model = createOllamaModel({ baseURL: "http://localhost:11434/", modelId: "qwen" });

    await model.doGenerate({
      prompt: [
        { role: "system", content: "Be concise." },
        { role: "user", content: [{ type: "text", text: "Hi" }] },
        { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      ],
    });

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages).toEqual([
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]);
  });

  it("throws on HTTP errors", async () => {
    mockFetch = mock(async () => new Response("bad", { status: 500 }));
    globalThis.fetch = mockFetch as typeof fetch;
    const model = createOllamaModel({ baseURL: "http://localhost:11434", modelId: "gemma3:4b" });

    await expect(model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    })).rejects.toThrow("Ollama generate error (500): bad");
  });
});

describe("Ollama adapter — doStream", () => {
  it("converts NDJSON chunks into text deltas and finish", async () => {
    mockNdjson([
      { message: { role: "assistant", content: "Hello" }, done: false },
      { message: { role: "assistant", content: " world" }, done: false },
      { message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 2 },
    ]);

    const model = createOllamaModel({ baseURL: "http://localhost:11434", modelId: "gemma3:4b" });
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    });

    const parts: unknown[] = [];
    for await (const part of result.stream) parts.push(part);

    // Full protocol sequence: stream-start, text-start before the first delta,
    // text-end before finish. Bare deltas made the ai@7 recorder emit "text
    // part 0 not found", and stream-helpers.ts turns that error part into a
    // failed chat.
    expect(parts).toEqual([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: "Hello" },
      { type: "text-delta", id: "0", delta: " world" },
      { type: "text-end", id: "0" },
      expect.objectContaining({ type: "finish", usage: expect.objectContaining({ inputTokens: expect.objectContaining({ total: 3 }) }) }),
    ]);

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.stream).toBe(true);
  });

  it("streams through the REAL streamText recorder without protocol errors", async () => {
    // Pins the boundary the raw-parts assertions cannot see: ai@7's recorder
    // rejected bare deltas with "text part 0 not found", and
    // `infrastructure/ai/stream-helpers.ts` throws on an error part, so every
    // Ollama streamed reply failed on its first token.
    mockNdjson([
      { message: { role: "assistant", content: "Hello" }, done: false },
      { message: { role: "assistant", content: " world" }, done: false },
      { message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 2 },
    ]);
    const model = createOllamaModel({ baseURL: "http://localhost:11434", modelId: "gemma3:4b" });

    // When
    const result = streamText({ model, prompt: "Hi" });
    const errors: unknown[] = [];
    let text = "";
    for await (const part of result.fullStream) {
      if (part.type === "error") errors.push(part.error);
      if (part.type === "text-delta") text += part.text;
    }

    // Then
    expect(errors).toEqual([]);
    expect(text).toBe("Hello world");
    expect(await result.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 });
  });

  it("reassembles a JSON object split across two wire chunks", async () => {
    // Given - TCP hands the adapter arbitrary byte runs, not whole lines.
    mockByteChunks([
      '{"message":{"role":"assistant","content":"Hel',
      'lo"},"done":false}\n{"message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":3,"eval_count":2}\n',
    ]);
    const model = createOllamaModel({ baseURL: "http://localhost:11434", modelId: "gemma3:4b" });

    // When
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    });
    const parts: LanguageModelV3StreamPart[] = [];
    for await (const part of result.stream) parts.push(part);

    // Then - one delta, not two halves and not a dropped line.
    expect(parts).toEqual([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: "Hello" },
      { type: "text-end", id: "0" },
      expect.objectContaining({ type: "finish" }),
    ]);
  });

  it("joins a multi-byte character split across two wire chunks", async () => {
    // Given - the emoji's 4 UTF-8 bytes are cut in half by the chunk boundary.
    const line = '{"message":{"role":"assistant","content":"привет 😀"},"done":false}\n';
    const emojiTailOffset = new TextEncoder().encode(line).length - 21;
    mockByteChunks([
      ...splitBytes(line, emojiTailOffset),
      '{"message":{"content":""},"done":true}\n',
    ]);
    const model = createOllamaModel({ baseURL: "http://localhost:11434", modelId: "gemma3:4b" });

    // When
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    });
    const parts: LanguageModelV3StreamPart[] = [];
    for await (const part of result.stream) parts.push(part);

    // Then - no U+FFFD, no JSON parse failure that would swallow the token.
    expect(parts[2]).toEqual({ type: "text-delta", id: "0", delta: "привет 😀" });
  });

  it("skips an unparseable line and keeps streaming", async () => {
    // Given - a proxy injecting a keep-alive comment or a truncated object must
    // not end the response.
    mockByteChunks([
      '{"message":{"content":"a"},"done":false}\n',
      "<html>502</html>\n",
      '{"message":{"content":"b"},"done":false}\n',
      '{"message":{"content":""},"done":true,"prompt_eval_count":1,"eval_count":2}\n',
    ]);
    const model = createOllamaModel({ baseURL: "http://localhost:11434", modelId: "gemma3:4b" });

    // When
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    });
    const parts: LanguageModelV3StreamPart[] = [];
    for await (const part of result.stream) parts.push(part);

    // Then
    expect(parts).toEqual([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: "a" },
      { type: "text-delta", id: "0", delta: "b" },
      { type: "text-end", id: "0" },
      expect.objectContaining({
        type: "finish",
        usage: expect.objectContaining({ outputTokens: expect.objectContaining({ total: 2 }) }),
      }),
    ]);
  });

  it("uses the final line's usage even without a trailing newline", async () => {
    // Given - the done object is complete but the body ends right after it.
    mockByteChunks([
      '{"message":{"content":"hi"},"done":false}\n',
      '{"message":{"content":""},"done":true,"done_reason":"length","prompt_eval_count":7,"eval_count":9}',
    ]);
    const model = createOllamaModel({ baseURL: "http://localhost:11434", modelId: "gemma3:4b" });

    // When
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    });
    const parts: LanguageModelV3StreamPart[] = [];
    for await (const part of result.stream) parts.push(part);

    // Then - token counts and the length reason survive; dropping the tail
    // would silently report a stop with zero usage.
    const finish = parts.at(-1);
    expect(finish).toEqual(expect.objectContaining({
      type: "finish",
      finishReason: expect.objectContaining({ unified: "length" }),
      usage: expect.objectContaining({
        inputTokens: expect.objectContaining({ total: 7 }),
        outputTokens: expect.objectContaining({ total: 9 }),
      }),
    }));
  });
});

describe("fetchOllamaModels", () => {
  it("returns completion-capable model names and filters embedding-only models", async () => {
    mockJson({
      models: [
        { name: "gemma3:4b", capabilities: ["completion"] },
        { name: "embed:latest", capabilities: ["embedding"] },
        { name: "legacy-no-capabilities" },
      ],
    });

    await expect(fetchOllamaModels("http://localhost:11434")).resolves.toEqual([
      "gemma3:4b",
      "legacy-no-capabilities",
    ]);
  });
});


describe("tokenizeOllama (LS-1a)", () => {
  it("posts {model, input} to /api/tokenize and returns tokens.length", async () => {
    mockJson({ model: "gemma3:4b", tokens: [1, 2, 3, 4, 5, 6] });
    const count = await tokenizeOllama({
      baseUrl: "http://127.0.0.1:9601",
      apiKey: null,
      text: "Hello there",
      modelId: "gemma3:4b",
    });
    expect(count).toBe(6);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:9601/api/tokenize");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("gemma3:4b");
    expect(body.input).toBe("Hello there");
  });

  it("throws on an unexpected response shape (counting layer falls back)", async () => {
    mockJson({ model: "gemma3:4b" });
    await expect(tokenizeOllama({
      baseUrl: "http://127.0.0.1:9602",
      apiKey: null,
      text: "hi",
      modelId: "gemma3:4b",
    })).rejects.toThrow("tokens");
  });

  it("throws on HTTP error (counting layer falls back)", async () => {
    mockJson({ error: "nope" }, 404);
    await expect(tokenizeOllama({
      baseUrl: "http://127.0.0.1:9603",
      apiKey: null,
      text: "hi",
      modelId: "gemma3:4b",
    })).rejects.toThrow("404");
  });
});
