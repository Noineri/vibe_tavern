import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { generateText, streamText } from "ai";
import { googleInteractionsProtocol } from "../src/domain/providers/google-interactions-adapter.js";
import { resolveProtocol, PROTOCOL_CAPABILITIES } from "../src/domain/providers/protocol-registry.js";
import { normalizeProviderType, resolveSamplerSet, PROVIDER_TYPE } from "@vibe-tavern/domain";

// ─── Mock fetch ──────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;
let lastRequest: { url: string; headers: Record<string, string>; body: any } | null = null;

function profile() {
  return {
    providerPreset: "google_interactions",
    endpoint: "https://generativelanguage.googleapis.com",
    apiKey: "test-key-123",
  };
}

function setupMockFetch(response: () => Response) {
  lastRequest = null;
  mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = url instanceof Request ? url.url : String(url);
    lastRequest = {
      url: urlStr,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    return response();
  });
  globalThis.fetch = mockFetch as typeof fetch;
}

// Canned non-stream Interaction response (shape captured from the live API;
// schema is `.loose()` so extra fields are tolerated).
const INTERACTION_RESPONSE = {
  id: "v1_testinteraction",
  status: "completed",
  object: "interaction",
  model: "gemini-3-flash-preview",
  created: "2026-08-22T18:10:20Z",
  updated: "2026-08-22T18:10:20Z",
  steps: [
    { type: "thought", signature: "sig-hash" },
    {
      type: "model_output",
      content: [{ type: "text", text: "Привет из Interactions API!" }],
    },
  ],
  usage: {
    total_tokens: 60,
    total_input_tokens: 13,
    input_tokens_by_modality: [{ modality: "text", tokens: 13 }],
    total_cached_tokens: 0,
    total_output_tokens: 7,
    total_thought_tokens: 40,
    total_tool_use_tokens: 0,
  },
};

// Canned SSE stream (event sequence from the live API).
function sseStreamResponse(): Response {
  const events = [
    ["interaction.created", { interaction: { id: "v1_testinteraction", status: "in_progress", model: "gemini-3-flash-preview", object: "interaction" }, event_type: "interaction.created" }],
    ["interaction.status_update", { interaction_id: "v1_testinteraction", status: "in_progress", event_type: "interaction.status_update" }],
    ["step.start", { index: 0, step: { type: "thought" }, event_type: "step.start" }],
    ["step.start", { index: 1, step: { type: "model_output" }, event_type: "step.start" }],
    ["step.delta", { index: 1, delta: { type: "text", text: "Привет " }, event_type: "step.delta" }],
    ["step.delta", { index: 1, delta: { type: "text", text: "из потока!" }, event_type: "step.delta" }],
    ["step.stop", { index: 1, event_type: "step.stop" }],
    ["interaction.completed", { interaction: { id: "v1_testinteraction", status: "completed", model: "gemini-3-flash-preview", object: "interaction" }, event_type: "interaction.completed" }],
  ];
  const body = events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: new Headers({ "Content-Type": "text/event-stream" }),
  });
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ═══════════════════════════════════════════════════════════════════════════
// Registry wiring
// ═══════════════════════════════════════════════════════════════════════════

describe("google_interactions protocol — registry wiring", () => {
  it("resolves via resolveProtocol", () => {
    const adapter = resolveProtocol(PROVIDER_TYPE.googleInteractions);
    expect(adapter).toBe(googleInteractionsProtocol);
    expect(adapter.id).toBe("google_interactions");
  });

  it("normalizeProviderType maps the preset id to the canonical type", () => {
    expect(normalizeProviderType("google_interactions")).toBe("google_interactions");
  });

  it("appears in PROTOCOL_CAPABILITIES with streaming + non-streaming", () => {
    const caps = PROTOCOL_CAPABILITIES[PROVIDER_TYPE.googleInteractions];
    expect(caps.nonStreamGeneration).toBe(true);
    expect(caps.streaming).toBe(true);
    expect(caps.abortSignal).toBe(true);
    expect(caps.prefill).toBe(false);
    expect(caps.logitBias).toBe(false);
    expect(caps.textCompletion).toBe(false);
  });

  it("uses the minimal_reasoning sampler set", () => {
    expect(resolveSamplerSet("google_interactions", "google_interactions")).toBe("minimal_reasoning");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveModel → generateText (non-stream) — the executor boundary
// ═══════════════════════════════════════════════════════════════════════════

describe("google_interactions adapter — generateText", () => {
  it("POSTs to /v1beta/interactions with model + input and parses model_output text", async () => {
    setupMockFetch(() => new Response(JSON.stringify(INTERACTION_RESPONSE), {
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
    }));

    const model = googleInteractionsProtocol.resolveModel(profile(), "gemini-3-flash-preview");
    const result = await generateText({ model, prompt: "Привет!" });

    expect(result.text).toBe("Привет из Interactions API!");
    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(lastRequest!.headers["x-goog-api-key"]).toBe("test-key-123");
    expect(lastRequest!.body.model).toBe("gemini-3-flash-preview");
    // The prompt must land in the interaction `input` (string or content array).
    const input = lastRequest!.body.input;
    const inputText = typeof input === "string"
      ? input
      : JSON.stringify(input);
    expect(inputText).toContain("Привет!");
  });

  it("does not set previous_interaction_id by default (stateless mode)", async () => {
    setupMockFetch(() => new Response(JSON.stringify(INTERACTION_RESPONSE), {
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
    }));

    const model = googleInteractionsProtocol.resolveModel(profile(), "gemini-3-flash-preview");
    await generateText({ model, prompt: "Hi" });

    expect(lastRequest!.body.previous_interaction_id).toBeUndefined();
  });

  it("forwards temperature + maxOutputTokens through generation_config", async () => {
    setupMockFetch(() => new Response(JSON.stringify(INTERACTION_RESPONSE), {
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
    }));

    const model = googleInteractionsProtocol.resolveModel(profile(), "gemini-3-flash-preview");
    await generateText({ model, prompt: "Hi", temperature: 0.7, maxOutputTokens: 512 });

    expect(lastRequest!.body.generation_config).toMatchObject({
      temperature: 0.7,
      max_output_tokens: 512,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// testChat — must hit /v1beta/interactions, NOT :generateContent
// ═══════════════════════════════════════════════════════════════════════════

describe("google_interactions adapter — testChat", () => {
  it("tests against /v1beta/interactions (interactions-only models 400 on :generateContent)", async () => {
    setupMockFetch(() => new Response(JSON.stringify(INTERACTION_RESPONSE), {
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
    }));

    const result = await googleInteractionsProtocol.testChat({
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "test-key-123",
      model: "gemini-3.6-flash",
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.reply).toBe("Привет из Interactions API!");
    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions?key=test-key-123");
    expect(lastRequest!.url).not.toContain(":generateContent");
    expect(lastRequest!.body.model).toBe("gemini-3.6-flash");
    expect(lastRequest!.body.input).toBe("Hi");
  });

  it("surfaces a provider 400 with its message (the interactions-only rejection)", async () => {
    setupMockFetch(() => new Response(JSON.stringify({
      error: { code: 400, message: "This model only supports Interactions API.", status: "INVALID_ARGUMENT" },
    }), { status: 400, headers: new Headers({ "Content-Type": "application/json" }) }));

    const result = await googleInteractionsProtocol.testChat({
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "test-key-123",
      model: "gemini-3.6-flash",
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("This model only supports Interactions API.");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveModel → streamText — the streaming executor boundary
// ═══════════════════════════════════════════════════════════════════════════

describe("google_interactions adapter — streamText", () => {
  it("streams step.delta text events into the assembled text", async () => {
    setupMockFetch(sseStreamResponse);

    const model = googleInteractionsProtocol.resolveModel(profile(), "gemini-3-flash-preview");
    const result = streamText({ model, prompt: "Привет!" });
    const text = await result.text;

    expect(text).toBe("Привет из потока!");
    expect(lastRequest!.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(lastRequest!.body.stream).toBe(true);
  });
});
