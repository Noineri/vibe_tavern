import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { streamText } from "ai";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import {
  createNovelAiModel,
  novelaiProtocol,
  probeNovelAiConnection,
  listNovelAiModels,
  testNovelAiChat,
} from "../src/domain/providers/novelai-adapter.js";
import { generationFormatToTemplate } from "../src/domain/providers/completion-prompt.js";

// ─── Mock fetch ──────────────────────────────────────────────────────────

// Fake token ONLY (plan rule: never store/print a real NovelAI token).
const TEST_API_KEY = "pst-test";

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;
let lastInit: RequestInit | undefined;

function setupMockFetch(responses: Array<{ ok: boolean; status: number; json?: unknown; body?: string }>) {
  let callIndex = 0;
  mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    lastInit = init;
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
    lastInit = init;
    return new Response(body, {
      status: 200,
      headers: new Headers({ "Content-Type": "text/event-stream" }),
    });
  });
  globalThis.fetch = mockFetch as typeof fetch;
}

function sentBody(): Record<string, unknown> {
  return JSON.parse((lastInit?.body as string)) as Record<string, unknown>;
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
  lastInit = undefined;
});

// Files in packages/* + services/api share ONE bun process: a mock left
// installed after the file's last test poisons every later network test
// (skill: vibe-tavern-testing). beforeEach restores BETWEEN tests only —
// this afterAll also restores AFTER the last one.
afterAll(() => {
  globalThis.fetch = originalFetch;
});

function kayraModel() {
  return createNovelAiModel({
    baseURL: "https://text.novelai.net",
    apiKey: TEST_API_KEY,
    modelId: "kayra-v1",
  });
}

function eratoModel() {
  return createNovelAiModel({
    baseURL: "https://text.novelai.net",
    apiKey: TEST_API_KEY,
    modelId: "llama-3-erato-v1",
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// createNovelAiModel — doGenerate (wire shape)
// ═══════════════════════════════════════════════════════════════════════════

describe("NovelAI adapter — doGenerate wire shape", () => {
  it("sends { input, model, parameters } with the mandated fields, Bearer auth, and no stop_sequences on the wire", async () => {
    setupMockFetch([{ ok: true, status: 200, json: { output: " once upon a time." } }]);

    const result = await kayraModel().doGenerate({
      prompt: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ],
      temperature: 0.7,
      maxOutputTokens: 100,
    });

    expect(result.content).toEqual([{ type: "text", text: " once upon a time." }]);
    expect(result.finishReason.unified).toBe("stop");
    expect(result.warnings).toEqual([]);

    // URL + headers (Authorization Bearer + JSON content type)
    const call = mockFetch.mock.calls[0];
    expect((call[0] as string)).toBe("https://text.novelai.net/ai/generate");
    const headers = new Headers(lastInit?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${TEST_API_KEY}`);
    expect(headers.get("Content-Type")).toBe("application/json");

    // Body shape: Kayra carries NO input prefix
    const body = sentBody();
    expect(body.model).toBe("kayra-v1");
    expect(body.input).toBe("User: Hello\nAssistant:");
    expect(body.parameters).toEqual({
      temperature: 0.7,
      use_string: true,
      max_length: 100,
      min_length: 1,
      prefix: "vanilla",
    });
    // Client-side stop design: stop sequences NEVER reach the wire (the
    // native API takes token-id arrays from the model's own tokenizer).
    expect("stop_sequences" in (body.parameters as object)).toBe(false);
  });

  it("prepends the Erato prefix to input (llama-3-erato-v1 only)", async () => {
    setupMockFetch([{ ok: true, status: 200, json: { output: "ok" } }]);

    await eratoModel().doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    });
    expect(sentBody().input).toBe("<|startoftext|><|reserved_special_token81|>User: Hello\nAssistant:");
    expect(sentBody().model).toBe("llama-3-erato-v1");
  });

  it("passes the user's maxOutputTokens to max_length unchanged (never clamped)", async () => {
    setupMockFetch([{ ok: true, status: 200, json: { output: "ok" } }]);

    await kayraModel().doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      maxOutputTokens: 250,
    });

    // Owner ruling: no hard-coded response-length cap — 250 ships as 250.
    expect((sentBody().parameters as { max_length: number }).max_length).toBe(250);
  });

  it("spreads providerOptions.novelai into parameters (NAI-3b seam) without overriding the mandated fields", async () => {
    setupMockFetch([{ ok: true, status: 200, json: { output: "ok" } }]);

    await kayraModel().doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      maxOutputTokens: 150,
      providerOptions: { novelai: { top_k: 40, order: [0, 1] } },
    });

    const parameters = sentBody().parameters as Record<string, unknown>;
    expect(parameters.top_k).toBe(40);
    expect(parameters.order).toEqual([0, 1]);
    // The mandated fields are re-asserted AFTER the spread — nothing from
    // providerOptions can override or clamp them.
    expect(parameters.use_string).toBe(true);
    expect(parameters.max_length).toBe(150);
    expect(parameters.min_length).toBe(1);
    expect(parameters.prefix).toBe("vanilla");
  });

  it("throws on HTTP error with the status and body", async () => {
    setupMockFetch([{ ok: false, status: 401, body: '{"message":"invalid token"}' }]);

    try {
      await kayraModel().doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("401");
      expect((err as Error).message).toContain("invalid token");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createNovelAiModel — doGenerate (client-side stops, blocking)
// ═══════════════════════════════════════════════════════════════════════════

describe("NovelAI adapter — client-side stops (blocking)", () => {
  it("cuts the output before the user's stop string", async () => {
    setupMockFetch([{ ok: true, status: 200, json: { output: "abcSTOPdef" } }]);

    const result = await kayraModel().doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      stopSequences: ["STOP"],
    });

    expect(result.content).toEqual([{ type: "text", text: "abc" }]);
  });

  it("cuts at the implied role markers too (AUTO template, LS-9 union)", async () => {
    setupMockFetch([{ ok: true, status: 200, json: { output: "The fox jumps.User: next turn" } }]);

    const result = await kayraModel().doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    });

    // No user stops — the AUTO implied markers ride alone and stop the
    // runaway turn exactly as KoboldCPP's server-side stops would.
    expect(result.content).toEqual([{ type: "text", text: "The fox jumps." }]);
  });

  it("returns the untouched output when no stop matches", async () => {
    setupMockFetch([{ ok: true, status: 200, json: { output: "plain reply" } }]);

    const result = await kayraModel().doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      stopSequences: ["STOP"],
    });

    expect(result.content).toEqual([{ type: "text", text: "plain reply" }]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createNovelAiModel — doStream
// ═══════════════════════════════════════════════════════════════════════════

describe("NovelAI adapter — doStream", () => {
  it("streams SSE token events to the full protocol sequence and concatenates them", async () => {
    setupMockSSEStream(["Hello", " world", "!"]);

    const result = await kayraModel().doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    });

    const parts: LanguageModelV3StreamPart[] = [];
    for await (const part of result.stream) parts.push(part);

    // Full protocol sequence (LS-6d). AUTO implied stops hold back the last
    // (longest marker - 1) chars while tokens arrive, so the deltas are
    // split — their CONCATENATION is the pinned result.
    expect(parts[0]).toEqual({ type: "stream-start", warnings: [] });
    const deltas = parts
      .filter((p): p is { type: "text-delta"; id: string; delta: string } => p.type === "text-delta")
      .map((p) => p.delta);
    expect(deltas.join("")).toBe("Hello world!");
    // Hold-back pinned: the first token is never forwarded whole while a
    // stop could still complete inside it.
    expect(deltas[0]).not.toBe("Hello");
    expect(parts.at(-2)).toEqual({ type: "text-end", id: "0" });
    expect(parts.at(-1)?.type).toBe("finish");
    expect((parts.at(-1) as { finishReason: { unified: string } }).finishReason.unified).toBe("stop");

    // Streaming endpoint + Bearer header
    const call = mockFetch.mock.calls[0];
    expect((call[0] as string)).toBe("https://text.novelai.net/ai/generate-stream");
    const headers = new Headers(lastInit?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${TEST_API_KEY}`);
    const body = sentBody() as { model: string; parameters: { max_length: number } };
    expect(body.model).toBe("kayra-v1");
    expect(body.parameters.max_length).toBe(512); // fork-kept defensive default
  });

  it("emits every token immediately when no stops are active (manual template, no user stops)", async () => {
    setupMockSSEStream(["Hello", " world", "!"]);

    const model = novelaiProtocol.resolveModel(
      { providerPreset: "novelai", endpoint: "https://text.novelai.net", apiKey: TEST_API_KEY },
      "kayra-v1",
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
    const parts: LanguageModelV3StreamPart[] = [];
    for await (const part of result.stream) parts.push(part);

    // MANUAL injects no implied stops and no user stops ride → nothing is
    // held back: each SSE token becomes one whole delta.
    expect(parts).toEqual([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: "Hello" },
      { type: "text-delta", id: "0", delta: " world" },
      { type: "text-delta", id: "0", delta: "!" },
      { type: "text-end", id: "0" },
      expect.objectContaining({ type: "finish" }),
    ]);

    // The manual template renders through the shared seam (LS-6b).
    const body = sentBody() as { input: string };
    expect(body.input).toBe("<u> Hi\n<a>");
  });

  it("streams through the REAL streamText recorder without protocol errors (LS-6d)", async () => {
    setupMockSSEStream(["Hello", " world", "!"]);

    const textResult = streamText({ model: kayraModel(), prompt: "go" });
    const errors: unknown[] = [];
    let text = "";
    for await (const chunk of textResult.fullStream) {
      if (chunk.type === "error") errors.push(chunk.error);
      if (chunk.type === "text-delta") text += chunk.text;
    }

    expect(errors).toEqual([]);
    expect(text).toBe("Hello world!");
  });

  it("cuts the stream at an implied marker and ABORTS the request (client-side stop)", async () => {
    // Third token completes the AUTO implied marker "User:" mid-token.
    setupMockSSEStream(["Hello ", "world", "User: trailing garbage"]);

    const textResult = streamText({ model: kayraModel(), prompt: "go" });
    const errors: unknown[] = [];
    let text = "";
    for await (const chunk of textResult.fullStream) {
      if (chunk.type === "error") errors.push(chunk.error);
      if (chunk.type === "text-delta") text += chunk.text;
    }

    // The output is cut BEFORE the marker; nothing after it leaks.
    expect(errors).toEqual([]);
    expect(text).toBe("Hello world");

    // The SSE request itself is aborted (the design decision: stop matching
    // kills the request, not just the outgoing stream).
    expect((lastInit?.signal as AbortSignal | undefined)?.aborted).toBe(true);
  });

  it("throws on HTTP error in stream mode", async () => {
    setupMockFetch([{ ok: false, status: 503, body: "Service Unavailable" }]);

    try {
      await kayraModel().doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("503");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// probe / testChat / listModels
// ═══════════════════════════════════════════════════════════════════════════

describe("NovelAI adapter — probe (subscription key check)", () => {
  it("200 → success with the static model count, hitting the IMAGE host", async () => {
    setupMockFetch([{ ok: true, status: 200, json: { tier: "opus", active: true, perks: { contextTokens: 8192 } } }]);

    const result = await probeNovelAiConnection({ baseUrl: "https://text.novelai.net", apiKey: TEST_API_KEY });

    expect(result).toEqual({ success: true, modelCount: 2 });
    const call = mockFetch.mock.calls[0];
    expect((call[0] as string)).toBe("https://image.novelai.net/user/subscription");
    const headers = new Headers(lastInit?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${TEST_API_KEY}`);
  });

  it("401 → rejected key", async () => {
    setupMockFetch([{ ok: false, status: 401, body: "Unauthorized" }]);

    const result = await probeNovelAiConnection({ baseUrl: "https://text.novelai.net", apiKey: "pst-wrong" });

    expect(result.success).toBe(false);
    expect(result.error ?? "").toContain("Authentication rejected");
  });
});

describe("NovelAI adapter — testChat", () => {
  it("generates a minimal reply over the native blocking endpoint", async () => {
    setupMockFetch([{ ok: true, status: 200, json: { output: " Hi there" } }]);

    const result = await testNovelAiChat({
      baseUrl: "https://text.novelai.net",
      apiKey: TEST_API_KEY,
      model: "kayra-v1",
    });

    expect(result).toEqual({ success: true, reply: "Hi there" });
    const call = mockFetch.mock.calls[0];
    expect((call[0] as string)).toBe("https://text.novelai.net/ai/generate");
    const headers = new Headers(lastInit?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${TEST_API_KEY}`);
    const body = sentBody() as { input: string; model: string; parameters: Record<string, unknown> };
    expect(body.model).toBe("kayra-v1");
    expect(body.input).toBe("User: Hi\nAssistant:");
    expect(body.parameters.use_string).toBe(true);
    expect(body.parameters.max_length).toBe(64);
  });
});

describe("NovelAI adapter — listModels (static catalog)", () => {
  it("returns Kayra and Erato with contextLength when the subscription call succeeds", async () => {
    setupMockFetch([{ ok: true, status: 200, json: { tier: "opus", active: true, perks: { contextTokens: 8192 } } }]);

    const models = await listNovelAiModels({
      baseUrl: "https://text.novelai.net",
      apiKey: TEST_API_KEY,
    });

    expect(models).toEqual([
      { id: "kayra-v1", label: "Kayra", contextLength: 8192 },
      { id: "llama-3-erato-v1", label: "Erato", contextLength: 8192 },
    ]);
    const call = mockFetch.mock.calls[0];
    expect((call[0] as string)).toBe("https://image.novelai.net/user/subscription");
  });

  it("omits contextLength when the subscription call fails (never invents a number)", async () => {
    setupMockFetch([{ ok: false, status: 401, body: "Unauthorized" }]);

    const models = await listNovelAiModels({
      baseUrl: "https://text.novelai.net",
      apiKey: "pst-wrong",
    });

    expect(models).toEqual([
      { id: "kayra-v1", label: "Kayra" },
      { id: "llama-3-erato-v1", label: "Erato" },
    ]);
  });

  it("skips the subscription call entirely without a key", async () => {
    setupMockFetch([{ ok: true, status: 200, json: { perks: { contextTokens: 8192 } } }]);

    const models = await listNovelAiModels({ baseUrl: "https://text.novelai.net", apiKey: "" });

    expect(models).toEqual([
      { id: "kayra-v1", label: "Kayra" },
      { id: "llama-3-erato-v1", label: "Erato" },
    ]);
    expect(mockFetch.mock.calls).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LanguageModelV3 interface compliance + registry wiring
// ═══════════════════════════════════════════════════════════════════════════

describe("NovelAI adapter — V3 interface + protocol object", () => {
  it("exposes correct specificationVersion, provider, modelId", () => {
    const model = createNovelAiModel({
      baseURL: "https://text.novelai.net",
      apiKey: TEST_API_KEY,
      modelId: "kayra-v1",
    });

    expect(model.specificationVersion).toBe("v3");
    expect(model.provider).toBe("novelai");
    expect(model.modelId).toBe("kayra-v1");
  });

  it("declares the NAI-3a capabilities and has no tokenize member", () => {
    expect(novelaiProtocol.id).toBe("novelai");
    expect(novelaiProtocol.capabilities).toEqual({
      nonStreamGeneration: true,
      abortSignal: true,
      streaming: true,
      prefill: false,
      logitBias: false,
      samplers: expect.objectContaining({ temperature: true, unifiedLinear: true }),
      textCompletion: false,
      backendTemplate: false,
    });
    expect("tokenize" in novelaiProtocol).toBe(false);
  });

  it("resolveModel defaults the endpoint to the canonical text host and the model to Kayra", async () => {
    setupMockFetch([{ ok: true, status: 200, json: { output: "ok" } }]);
    const model = novelaiProtocol.resolveModel(
      { providerPreset: "novelai", endpoint: "", apiKey: TEST_API_KEY },
      "",
    );
    if (model.specificationVersion !== "v3") throw new Error("expected a V3 model");
    expect(model.modelId).toBe("kayra-v1");

    await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }] });
    expect((mockFetch.mock.calls[0]?.[0] as string)).toBe("https://text.novelai.net/ai/generate");
  });
});
