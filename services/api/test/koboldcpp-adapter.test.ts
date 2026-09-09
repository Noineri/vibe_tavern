import { describe, it, expect, mock, beforeEach } from "bun:test";
import {
  createKoboldCppModel,
  fetchKoboldModel,
  tokenizeKoboldCpp,
} from "../src/domain/providers/koboldcpp-adapter.js";

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

beforeEach(() => {
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

  it("passes stop sequences", async () => {
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
    expect(body.stop_sequence).toEqual(["\\n", "STOP"]);
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

    // Should have text-delta parts + finish
    const textParts = parts.filter((p: any) => p.type === "text-delta");
    const finishParts = parts.filter((p: any) => p.type === "finish");

    expect(textParts).toHaveLength(3);
    expect(textParts[0]).toEqual({ type: "text-delta", id: "0", delta: "Hello" });
    expect(textParts[1]).toEqual({ type: "text-delta", id: "0", delta: " world" });
    expect(textParts[2]).toEqual({ type: "text-delta", id: "0", delta: "!" });
    expect(finishParts).toHaveLength(1);
    expect((finishParts[0] as any).finishReason.unified).toBe("stop");
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
