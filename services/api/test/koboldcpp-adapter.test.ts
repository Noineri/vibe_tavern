import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { streamText } from "ai";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import {
  createKoboldCppModel,
  fetchKoboldModel,
  tokenizeKoboldCpp,
  koboldCppProtocol,
} from "../src/domain/providers/koboldcpp-adapter.js";
import { generationFormatToTemplate } from "../src/domain/providers/completion-prompt.js";

// ─── Mock fetch ──────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

function setupMockFetch(responses: Array<{ ok: boolean; status: number; json?: unknown; body?: string }>) {
  let callIndex = 0;
  mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const response = responses[Math.min(callIndex, responses.length - 1)];
    callIndex++;
    const headers = new Headers({ "Content-Type": "application/json" });
    return new Response(response.body ?? JSON.stringify(response.json), {
      status: response.status,
      headers,
    });
  });
  globalThis.fetch = mockFetch as typeof fetch;
}

function setupMockSSEStream(tokens: string[], doneText = "full text") {
  const lines = [
    ...tokens.map((t) => `data: ${JSON.stringify({ token: t })}`),
    `data: ${JSON.stringify({ text: doneText, done: true })}`,
  ];
  const body = lines.join("\n\n");
  mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    return new Response(body, {
      status: 200,
      headers: new Headers({ "Content-Type": "text/event-stream" }),
    });
  });
  globalThis.fetch = mockFetch as typeof fetch;
}

// Byte-level control over the wire: SSE line reassembly and UTF-8 decoding are
// the adapter's job, and neither runs when the body arrives as one chunk.
function setupMockByteChunks(chunks: readonly (string | Uint8Array)[]) {
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
    { status: 200, headers: new Headers({ "Content-Type": "text/event-stream" }) },
  ));
  globalThis.fetch = mockFetch as typeof fetch;
}

// Splits text at a byte offset INSIDE a multi-byte character, so each half is
// invalid UTF-8 alone and only the joined pair decodes.
function splitBytes(text: string, at: number): [Uint8Array, Uint8Array] {
  const bytes = new TextEncoder().encode(text);
  return [bytes.slice(0, at), bytes.slice(at)];
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

// Files in packages/* + services/api share ONE bun process: a mock left
// installed after the file's last test poisons every later network test
// (skill: vibe-tavern-testing). beforeEach restores BETWEEN tests only —
// this afterAll also restores AFTER the last one.
afterAll(() => {
  globalThis.fetch = originalFetch;
});

// ═══════════════════════════════════════════════════════════════════════════
// createKoboldCppModel — doGenerate
// ═══════════════════════════════════════════════════════════════════════════

describe("KoboldCPP adapter — doGenerate", () => {
  it("sends prompt and returns generated text", async () => {
    setupMockFetch([{
      ok: true,
      status: 200,
      json: { results: [{ text: " jumps over the lazy dog." }] },
    }]);

    const model = createKoboldCppModel({
      baseURL: "http://localhost:5001",
      modelId: "test-model",
    });

    const result = await model.doGenerate({
      prompt: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ],
      temperature: 0.7,
      maxOutputTokens: 100,
    });

    expect(result.content).toEqual([{ type: "text", text: " jumps over the lazy dog." }]);
    expect(result.finishReason.unified).toBe("stop");
    expect(result.warnings).toEqual([]);
  });

  it("serializes multi-turn conversation into flat prompt", async () => {
    setupMockFetch([{
      ok: true,
      status: 200,
      json: { results: [{ text: " I'm fine." }] },
    }]);

    const model = createKoboldCppModel({
      baseURL: "http://localhost:5001",
      modelId: "test",
    });

    await model.doGenerate({
      prompt: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: [{ type: "text", text: "Hi" }] },
        { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
        { role: "user", content: [{ type: "text", text: "How are you?" }] },
      ],
    });

    // Check the request body that was sent
    const call = mockFetch.mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.prompt).toContain("System: You are helpful.");
    expect(body.prompt).toContain("User: Hi");
    expect(body.prompt).toContain("Assistant: Hello!");
    expect(body.prompt).toContain("User: How are you?");
    expect(body.prompt).toContain("Assistant:");
    expect(body.max_length).toBe(512); // default when not set in this call
  });

  it("passes sampler parameters via providerOptions", async () => {
    setupMockFetch([{
      ok: true,
      status: 200,
      json: { results: [{ text: "ok" }] },
    }]);

    const model = createKoboldCppModel({
      baseURL: "http://localhost:5001",
      modelId: "test",
    });

    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      temperature: 0.5,
      maxOutputTokens: 200,
      providerOptions: {
        koboldcpp: { top_k: 40, rep_pen: 1.2 },
      },
    });

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.temperature).toBe(0.5);
    expect(body.max_length).toBe(200);
    expect(body.top_k).toBe(40);
    expect(body.rep_pen).toBe(1.2);
  });

  it("passes stop sequences (user stops ride FIRST, implied markers follow — LS-9 auto union)", async () => {
    setupMockFetch([{
      ok: true,
      status: 200,
      json: { results: [{ text: "ok" }] },
    }]);

    const model = createKoboldCppModel({
      baseURL: "http://localhost:5001",
      modelId: "test",
    });

    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      stopSequences: ["\\n", "STOP"],
    });

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.stop_sequence).toEqual(["\\n", "STOP", "System:", "User:", "Assistant:"]);
  });

  it("handles empty generation result", async () => {
    setupMockFetch([{
      ok: true,
      status: 200,
      json: { results: [{ text: "" }] },
    }]);

    const model = createKoboldCppModel({
      baseURL: "http://localhost:5001",
      modelId: "test",
    });

    const result = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    });

    expect(result.content).toEqual([]);
  });

  it("throws on HTTP error", async () => {
    setupMockFetch([{
      ok: false,
      status: 500,
      body: "Internal Server Error",
    }]);

    const model = createKoboldCppModel({
      baseURL: "http://localhost:5001",
      modelId: "test",
    });

    try {
      await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("500");
      expect((err as Error).message).toContain("Internal Server Error");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createKoboldCppModel — doStream
// ═══════════════════════════════════════════════════════════════════════════

describe("KoboldCPP adapter — doStream", () => {
  it("streams tokens and emits finish", async () => {
    setupMockSSEStream(["Hello", " world", "!"]);

    const model = createKoboldCppModel({
      baseURL: "http://localhost:5001",
      modelId: "test",
    });

    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    });

    const parts: unknown[] = [];
    for await (const part of result.stream) {
      parts.push(part);
    }

    // Full protocol sequence (LS-6d): stream-start, text-start, 3 deltas,
    // text-end, finish — in that order.
    expect(parts[0]).toEqual({ type: "stream-start", warnings: [] });
    expect(parts[1]).toEqual({ type: "text-start", id: "0" });
    expect(parts[2]).toEqual({ type: "text-delta", id: "0", delta: "Hello" });
    expect(parts[3]).toEqual({ type: "text-delta", id: "0", delta: " world" });
    expect(parts[4]).toEqual({ type: "text-delta", id: "0", delta: "!" });
    expect(parts[5]).toEqual({ type: "text-end", id: "0" });
    expect(parts[6]?.type).toBe("finish");
    expect((parts[6] as { finishReason: { unified: string } }).finishReason.unified).toBe("stop");
  });

  it("reassembles an SSE event split across two wire chunks", async () => {
    // Given - TCP hands the adapter arbitrary byte runs, not whole SSE lines.
    setupMockByteChunks([
      'data: {"token":" wor',
      'ld"}\n\ndata: {"text":" world","done":true}\n\n',
    ]);
    const model = createKoboldCppModel({ baseURL: "http://localhost:5001", modelId: "test" });

    // When
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    });
    const parts: LanguageModelV3StreamPart[] = [];
    for await (const part of result.stream) parts.push(part);

    // Then - one delta, not two halves and not a dropped event.
    expect(parts).toEqual([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: " world" },
      { type: "text-end", id: "0" },
      expect.objectContaining({ type: "finish" }),
    ]);
  });

  it("joins a multi-byte character split across two wire chunks", async () => {
    // Given - the emoji's 4 UTF-8 bytes are cut in half by the chunk boundary.
    const line = 'data: {"token":"привет 😀"}\n\n';
    const emojiTailOffset = new TextEncoder().encode(line).length - 10;
    setupMockByteChunks([
      ...splitBytes(line, emojiTailOffset),
      'data: {"done":true}\n\n',
    ]);
    const model = createKoboldCppModel({ baseURL: "http://localhost:5001", modelId: "test" });

    // When
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    });
    const parts: LanguageModelV3StreamPart[] = [];
    for await (const part of result.stream) parts.push(part);

    // Then - no U+FFFD and no parse failure that would swallow the token.
    expect(parts[2]).toEqual({ type: "text-delta", id: "0", delta: "привет 😀" });
  });

  it("emits the last event when the body ends without a blank line", async () => {
    // Given - a closed connection leaves the final event in the buffer with no
    // terminator; dropping it would lose the last token of the reply.
    setupMockByteChunks([
      'data: {"token":"a"}\n\n',
      'data: {"token":"b"}',
    ]);
    const model = createKoboldCppModel({ baseURL: "http://localhost:5001", modelId: "test" });

    // When
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
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
      expect.objectContaining({ type: "finish" }),
    ]);
  });

  it("skips keep-alive comments and unparseable lines", async () => {
    // Given - SSE comments (": ping") and proxy noise must not end the stream.
    setupMockByteChunks([
      ": ping\n\n",
      'data: {"token":"a"}\n\n',
      "data: <html>502</html>\n\n",
      'data: {"token":"b"}\n\ndata: {"done":true}\n\n',
    ]);
    const model = createKoboldCppModel({ baseURL: "http://localhost:5001", modelId: "test" });

    // When
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
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
      expect.objectContaining({ type: "finish" }),
    ]);
  });

  it("streams through the REAL streamText recorder without protocol errors (LS-6d)", async () => {
    // Pins the recorder boundary: ai@7's streamText rejects bare text-deltas
    // ("text part 0 not found" — shipped to the owner on KoboldCPP streaming).
    // Raw-parts assertions above cannot catch this; consuming via streamText
    // is the boundary the fix must hold at.
    setupMockSSEStream(["Hello", " world", "!"]);

    const model = createKoboldCppModel({
      baseURL: "http://localhost:5001",
      modelId: "test",
    });

    const result = streamText({ model, prompt: "go" });
    const errors: unknown[] = [];
    let text = "";
    for await (const chunk of result.fullStream) {
      if (chunk.type === "error") errors.push(chunk.error);
      if (chunk.type === "text-delta") text += chunk.text;
    }

    expect(errors).toEqual([]);
    expect(text).toBe("Hello world!");
    expect((await result.text) === "Hello world!").toBe(true);
  });

  it("an empty stream still opens and closes the protocol (stream-start + finish, no dangling text)", async () => {
    setupMockSSEStream([]);

    const model = createKoboldCppModel({ baseURL: "http://localhost:5001", modelId: "test" });
    const result = streamText({ model, prompt: "go" });
    const errors: unknown[] = [];
    for await (const chunk of result.fullStream) {
      if (chunk.type === "error") errors.push(chunk.error);
    }
    expect(errors).toEqual([]);
  });

  it("sends request to /api/extra/generate/stream", async () => {
    setupMockSSEStream(["ok"]);

    const model = createKoboldCppModel({
      baseURL: "http://localhost:5001",
      modelId: "test",
    });

    await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    });

    const call = mockFetch.mock.calls[0];
    const url = call[0] as string;
    expect(url).toContain("/api/extra/generate/stream");
  });

  it("passes sampler options in stream request body", async () => {
    setupMockSSEStream(["ok"]);

    const model = createKoboldCppModel({
      baseURL: "http://localhost:5001",
      modelId: "test",
    });

    await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      temperature: 0.8,
      providerOptions: { koboldcpp: { top_k: 50 } },
    });

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.temperature).toBe(0.8);
    expect(body.top_k).toBe(50);
  });

  it("throws on HTTP error in stream mode", async () => {
    setupMockFetch([{
      ok: false,
      status: 503,
      body: "Service Unavailable",
    }]);

    const model = createKoboldCppModel({
      baseURL: "http://localhost:5001",
      modelId: "test",
    });

    try {
      await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("503");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// tokenizeKoboldCpp — V1f fixtures (LOCAL_SUPPORT_PLAN LS-1a/LS-1e)
// ═══════════════════════════════════════════════════════════════════════════

interface TokenizeCapture { url: string; body: { prompt: string } }

function tokenizeFetch(
  calls: TokenizeCapture[],
  respond: (body: { prompt: string }) => { status: number; json?: unknown },
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const urlText = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const body = JSON.parse(String(init?.body ?? "{}")) as { prompt: string };
    calls.push({ url: urlText, body });
    const r = respond(body);
    return new Response(r.json !== undefined ? JSON.stringify(r.json) : "error", {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("KoboldCPP adapter — tokenize (V1f normalization)", () => {
  it("subtracts the empty-prompt specials baseline from ids (Qwen 151643 V1f capture)", async () => {
    const calls: TokenizeCapture[] = [];
    const text = "The quiet forest held its breath.";
    // V1f capture shape: ids carry a LEADING special token (Qwen2.5 BOS 151643
    // `</s>`) that Kobold prepends itself, so `value` (= ids.length) overcounts
    // by 1 vs the exact content count. The empty-prompt probe returns exactly
    // that prepended special as ids — the baseline.
    const contentIds = Array.from({ length: 25 }, (_, i) => 10_000 + i);
    const count = await tokenizeKoboldCpp({
      baseUrl: "http://127.0.0.1:9501",
      apiKey: null,
      text,
      fetch: tokenizeFetch(calls, ({ prompt }) =>
        prompt === ""
          ? { status: 200, json: { value: 1, ids: [151643] } }
          : { status: 200, json: { value: 26, ids: [151643, ...contentIds] } },
      ),
    });

    expect(count).toBe(25); // ids.length (26) minus the detected leading special (1) — NOT value (26).
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("http://127.0.0.1:9501/api/extra/tokencount");
    expect(calls[0]!.body.prompt).toBe(""); // baseline probe
    expect(calls[1]!.body.prompt).toBe(text); // body field is `prompt`, not `text` (V1f correction)
  });

  it("keeps the full ids.length for a model with no BOS (baseline 0)", async () => {
    const calls: TokenizeCapture[] = [];
    const count = await tokenizeKoboldCpp({
      baseUrl: "http://127.0.0.1:9502",
      apiKey: null,
      text: "no specials here",
      fetch: tokenizeFetch(calls, ({ prompt }) =>
        prompt === ""
          ? { status: 200, json: { value: 0, ids: [] } }
          : { status: 200, json: { value: 3, ids: [7, 8, 9] } },
      ),
    });
    expect(count).toBe(3);
  });

  it("falls back to value when the baseline probe fails", async () => {
    const calls: TokenizeCapture[] = [];
    const count = await tokenizeKoboldCpp({
      baseUrl: "http://127.0.0.1:9503",
      apiKey: null,
      text: "hello",
      fetch: tokenizeFetch(calls, ({ prompt }) =>
        prompt === ""
          ? { status: 404 } // no tokencount probe support — fall back
          : { status: 200, json: { value: 6, ids: [151643, 1, 2, 3, 4, 5] } },
      ),
    });
    // Baseline unknown → value (V1f: off by at most one special) instead of a
    // nonsensical ids.length - 0.
    expect(count).toBe(6);
  });

  it("throws on HTTP error for the count call (counting layer falls back to the ladder)", async () => {
    const err = await tokenizeKoboldCpp({
      baseUrl: "http://127.0.0.1:9504",
      apiKey: null,
      text: "hello",
      fetch: tokenizeFetch([], () => ({ status: 500 })),
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
  });

  it("is cached per endpoint: a second call on the same base does not re-probe the baseline", async () => {
    const calls: TokenizeCapture[] = [];
    const fetchFn = tokenizeFetch(calls, ({ prompt }) =>
      prompt === ""
        ? { status: 200, json: { value: 1, ids: [151643] } }
        : { status: 200, json: { value: 2, ids: [151643, 42] } },
    );
    const first = await tokenizeKoboldCpp({ baseUrl: "http://127.0.0.1:9505", apiKey: null, text: "a", fetch: fetchFn });
    const second = await tokenizeKoboldCpp({ baseUrl: "http://127.0.0.1:9505", apiKey: null, text: "b", fetch: fetchFn });
    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(calls.filter((c) => c.body.prompt === "")).toHaveLength(1); // baseline probed once
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// fetchKoboldModel
// ═══════════════════════════════════════════════════════════════════════════

describe("fetchKoboldModel", () => {
  it("returns model name from /api/v1/model", async () => {
    setupMockFetch([{
      ok: true,
      status: 200,
      json: { result: "llama-3-8b.Q4_K_M.gguf" },
    }]);

    const name = await fetchKoboldModel("http://localhost:5001");
    expect(name).toBe("llama-3-8b.Q4_K_M.gguf");

    const call = mockFetch.mock.calls[0];
    expect((call[0] as string)).toContain("/api/v1/model");
  });

  it("throws on non-OK response", async () => {
    setupMockFetch([{
      ok: false,
      status: 404,
      body: "Not Found",
    }]);

    try {
      await fetchKoboldModel("http://localhost:5001");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("404");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LanguageModelV3 interface compliance
// ═══════════════════════════════════════════════════════════════════════════

describe("KoboldCPP adapter — V3 interface", () => {
  it("exposes correct specificationVersion, provider, modelId", () => {
    const model = createKoboldCppModel({
      baseURL: "http://localhost:5001",
      modelId: "my-model",
    });

    expect(model.specificationVersion).toBe("v3");
    expect(model.provider).toBe("koboldcpp");
    expect(model.modelId).toBe("my-model");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LS-6b — Generation-format template through the kobold serializer
// ═══════════════════════════════════════════════════════════════════════════

describe("KoboldCPP adapter — LS-6b generation-format template", () => {
  it("auto (no handoff) renders the historical role-prefixed bytes exactly", async () => {
    setupMockFetch([{ ok: true, status: 200, json: { results: [{ text: "ok" }] } }]);

    const model = createKoboldCppModel({ baseURL: "http://localhost:5001", modelId: "test" });
    await model.doGenerate({
      prompt: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: [{ type: "text", text: "Hi" }] },
      ],
    });

    const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
    // Byte-exact golden: the shared seam's DEFAULT template = the pre-LS-6
    // hardcoded serializer (trailing bare "Assistant:" continuation prefix).
    expect(body.prompt).toBe("System: You are helpful.\nUser: Hi\nAssistant:");
  });

  it("auto with a trailing assistant line: the line IS the continuation point (LS-3 seam semantics, no bare trailer)", async () => {
    setupMockFetch([{ ok: true, status: 200, json: { results: [{ text: "ok" }] } }]);

    const model = createKoboldCppModel({ baseURL: "http://localhost:5001", modelId: "test" });
    await model.doGenerate({
      prompt: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: [{ type: "text", text: "Hi" }] },
        { role: "assistant", content: [{ type: "text", text: "Sure, I" }] },
      ],
    });

    const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
    // Documented deviation from the pre-LS-6 bytes: a trailing assistant line
    // is the continuation point — no extra bare "Assistant:" trailer (the
    // model continues that line, an appended trailer would inject a turn break).
    expect(body.prompt).toBe("System: You are helpful.\nUser: Hi\nAssistant: Sure, I");
  });

  it("manual template from the preset renders the user sequences at the adapter boundary (resolveModel handoff)", async () => {
    setupMockFetch([{ ok: true, status: 200, json: { results: [{ text: "ok" }] } }]);

    const model = koboldCppProtocol.resolveModel(
      { providerPreset: "koboldcpp", endpoint: "http://localhost:5001", apiKey: null },
      "test",
      undefined,
      {
        completionFormat: {
          kind: "manual",
          template: generationFormatToTemplate({
            mode: "manual",
            systemSequence: "<|sys|>",
            inputSequence: "<|user|>",
            outputSequence: "<|assistant|>",
            inputSuffix: "\n",
            outputSuffix: "\n",
            systemSuffix: "\n",
            wrap: true,
          }),
        },
      },
    );
    if (model.specificationVersion !== "v3") throw new Error("expected a V3 model");
    await model.doGenerate({
      prompt: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: [{ type: "text", text: "Hi" }] },
        { role: "assistant", content: [{ type: "text", text: "Let me" }] },
      ],
    });

    const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
    // ST formatInstructModeChat semantics through the shared seam: wrapped
    // prefixes (wrap joins prefix and content with \n), per-message suffixes,
    // and the trailing assistant line as the continuation point (suffix
    // dropped, no trailer) — concatenated lines (extended path).
    expect(body.prompt).toBe("<|sys|>\nYou are helpful.\n<|user|>\nHi\n<|assistant|>\nLet me");
  });

  it("the stream path threads the manual template too", async () => {
    setupMockSSEStream(["ok"]);

    const model = koboldCppProtocol.resolveModel(
      { providerPreset: "koboldcpp", endpoint: "http://localhost:5001", apiKey: null },
      "test",
      undefined,
      {
        completionFormat: {
          kind: "manual",
          template: generationFormatToTemplate({
            mode: "manual",
            inputSequence: "<u> ",
            outputSequence: "<a> ",
          }),
        },
      },
    );
    if (model.specificationVersion !== "v3") throw new Error("expected a V3 model");
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    });
    for await (const _part of result.stream) void _part; // drain

    const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
    // Minimal (no-extensions) template: role-prefixed lines + bare assistant
    // trailer (trimmed) — the manual sequences replace the default labels.
    expect(body.prompt).toBe("<u> Hi\n<a>");
  });
});

describe("KoboldCPP adapter — LS-9 implied stop hygiene", () => {
  it("AUTO with no user stops: the implied role markers ride alone (no empty array — body byte-parity)", async () => {
    setupMockFetch([{ ok: true, status: 200, json: { results: [{ text: "ok" }] } }]);

    const model = createKoboldCppModel({ baseURL: "http://localhost:5001", modelId: "test" });
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    });

    const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.stop_sequence).toEqual(["System:", "User:", "Assistant:"]);
  });

  it("a user stop equal to a marker is deduped, not doubled", async () => {
    setupMockFetch([{ ok: true, status: 200, json: { results: [{ text: "ok" }] } }]);

    const model = createKoboldCppModel({ baseURL: "http://localhost:5001", modelId: "test" });
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      stopSequences: ["User:"],
    });

    const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.stop_sequence).toEqual(["User:", "System:", "Assistant:"]);
  });

  it("MANUAL template: the user's stops ride ALONE — nothing injected (owner rule)", async () => {
    setupMockFetch([{ ok: true, status: 200, json: { results: [{ text: "ok" }] } }]);

    const model = koboldCppProtocol.resolveModel(
      { providerPreset: "koboldcpp", endpoint: "http://localhost:5001", apiKey: null },
      "test",
      undefined,
      {
        completionFormat: {
          kind: "manual",
          template: generationFormatToTemplate({ mode: "manual", inputSequence: "<u> ", outputSequence: "<a> " }),
        },
      },
    );
    if (model.specificationVersion !== "v3") throw new Error("expected a V3 model");
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      stopSequences: ["MINE"],
    });

    const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.stop_sequence).toEqual(["MINE"]);
  });

  it("MANUAL with no user stops: no stop key at all (byte-parity with pre-LS-9 manual)", async () => {
    setupMockFetch([{ ok: true, status: 200, json: { results: [{ text: "ok" }] } }]);

    const model = koboldCppProtocol.resolveModel(
      { providerPreset: "koboldcpp", endpoint: "http://localhost:5001", apiKey: null },
      "test",
      undefined,
      {
        completionFormat: {
          kind: "manual",
          template: generationFormatToTemplate({ mode: "manual", inputSequence: "<u> ", outputSequence: "<a> " }),
        },
      },
    );
    if (model.specificationVersion !== "v3") throw new Error("expected a V3 model");
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    });

    const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.stop_sequence).toBeUndefined();
  });

  it("the STREAM path unions the implied markers too (same owner rule both transports)", async () => {
    setupMockSSEStream(["ok"]);

    const model = createKoboldCppModel({ baseURL: "http://localhost:5001", modelId: "test" });
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      stopSequences: ["MINE"],
    });
    for await (const _part of result.stream) void _part; // drain

    const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.stop_sequence).toEqual(["MINE", "System:", "User:", "Assistant:"]);
  });
});
