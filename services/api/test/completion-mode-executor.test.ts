/**
 * TC generation mode at the executor boundary (LOCAL_SUPPORT_PLAN LS-2c/2e).
 *
 * Pins the whole path a `generationMode: "completion"` profile takes through
 * the REAL executors (streamText / generateText) against a stubbed transport:
 *
 *   - the request goes to the OpenAI-style `/completions` endpoint (not
 *     `/chat/completions`);
 *   - the body carries ONE flat prompt string — the serialization seam's
 *     output (role-prefixed stopgap template) — NOT a `messages` array;
 *   - the flat string matches the assembled prompt layers, with the bare
 *     `Assistant:` continuation trailer (and the prefill variant);
 *   - a chat-mode profile on the same preset still sends `messages` (silent
 *     backward compat — nothing else changes);
 *   - SSE abort parity: an aborted signal before/at execution settles the
 *     stream promises as cancelled, exactly like the existing chat paths.
 *
 * Doubles enter at the transport boundary only (globalThis.fetch stub +
 * recorded `/completion`-shaped fixtures) — mirroring the KoboldCPP native
 * adapter's fixture tests. No `mock.module`.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import type { AssemblePromptResponse, StoredProviderProfileRecord } from "@vibe-tavern/domain";
import { GENERATION_MODE } from "@vibe-tavern/domain";
import { resetProviderFetchFactory } from "../src/domain/providers/provider-fetch-factory.js";
import { nonstreamingProviderExecute } from "../src/infrastructure/ai/nonstreaming-provider-executor.js";
import { streamProviderExecutor } from "../src/infrastructure/ai/stream-provider-executor.js";
import type { ProviderExecutionInput } from "../src/infrastructure/ai/provider-execution-types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────

const FIXTURE_PORT = 9561;

/** Full stored profile (LM Studio preset = generic openai_compat protocol). */
function makeProfile(over: Partial<StoredProviderProfileRecord> = {}): StoredProviderProfileRecord {
  return {
    id: "prov_tc", name: "TC profile", providerPreset: "lmstudio",
    coauthorTransport: "chat_completions",
    generationMode: GENERATION_MODE.completion,
    endpoint: `http://127.0.0.1:${FIXTURE_PORT}/v1`,
    apiKey: null,
    defaultModel: "qwen-local",
    contextBudget: 16000, pinContextBudget: false, tokenPadding: 0,
    bindPerModel: false, modelFreeOnly: false, modelGroupByOwner: false,
    maxTokens: 512, temperature: 0.8, topP: 0.95, topK: 0, minP: 0.05, topA: 0,
    typicalP: 1, tfsZ: 1,
    adaptiveTarget: -1, adaptiveDecay: 0.9,
    dynatempRange: 0, dynatempExponent: 1, topNSigma: 0, smoothingFactor: 0,
    repeatLastN: 0, mirostat: 0, mirostatTau: 5, mirostatEta: 0.1,
    dryMultiplier: 0, dryBase: 1.75, dryAllowedLength: 2,
    drySequenceBreakers: [], dryPenaltyLastN: -1,
    bannedStrings: [],
    xtcThreshold: 0.1, xtcProbability: 0,
    frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1,
    stopSequences: [],
    logitBias: [],
    seed: null, reasoningEffort: "auto", showReasoning: false,
    streamResponse: true, customSamplers: false,
    proxyMode: "inherit", proxyId: null,
    isActive: true, visionModel: null,
    createdAt: "2026-01-01", updatedAt: "2026-01-01",
    ...over,
  };
}

const PROMPT_MESSAGES = [
  { role: "system", content: "You are a storyteller." },
  { role: "user", content: "Begin the tale." },
  { role: "assistant", content: "Once upon a time" },
];

/** Minimal assembled prompt — the executors read `finalPayload.messages`. */
function makePrompt(): AssemblePromptResponse {
  return {
    layers: [], tokenAccounting: {}, activatedLoreEntries: [],
    scriptInjections: [], retrievedMemories: [],
    finalPayload: { messages: PROMPT_MESSAGES },
  } as AssemblePromptResponse;
}

function makeInput(over: Partial<ProviderExecutionInput> = {}): ProviderExecutionInput {
  return {
    profile: makeProfile(),
    model: "qwen-local",
    prompt: makePrompt(),
    ...over,
  };
}

/** The serialized stopgap string the seam must produce for PROMPT_MESSAGES
 *  (ends on an assistant message → that line IS the continuation point — no
 *  extra bare trailer). */
const EXPECTED_PROMPT = "System: You are a storyteller.\nUser: Begin the tale.\nAssistant: Once upon a time";

/** Recorded `/completion` response (OpenAI text-completion shape). */
const COMPLETION_JSON = {
  id: "cmpl-fixture", object: "text_completion", model: "qwen-local",
  choices: [{ text: " there lived a wizard.", finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 },
};

interface CapturedCall { url: string; init: RequestInit }

const originalFetch = globalThis.fetch;
let calls: CapturedCall[] = [];

function installFetchStub(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const urlText = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const initRecord = (init ?? {}) as RequestInit;
    calls.push({ url: urlText, init: initRecord });
    return respond(urlText, initRecord);
  }) as typeof fetch;
}

function sseResponse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n") + "\n\ndata: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const STREAM_CHUNKS = [
  { id: "cmpl-s", object: "text_completion", model: "qwen-local", choices: [{ text: " there", finish_reason: null, index: 0 }] },
  { id: "cmpl-s", object: "text_completion", model: "qwen-local", choices: [{ text: " lived a wizard.", finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 } },
];

beforeEach(() => {
  // Direct transport: the executors must resolve NO proxy fetch so the SDK
  // uses the stubbed global fetch (the seam this file intercepts).
  resetProviderFetchFactory();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

// ═══════════════════════════════════════════════════════════════════════
// Non-streaming: generateText → POST /completions with the flat string
// ═══════════════════════════════════════════════════════════════════════

describe("completion mode — nonstreamingProviderExecute", () => {
  it("sends ONE flat prompt string to /completions (recorded fixture shape)", async () => {
    installFetchStub(() => new Response(JSON.stringify(COMPLETION_JSON), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));

    const result = await nonstreamingProviderExecute(makeInput());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`http://127.0.0.1:${FIXTURE_PORT}/v1/completions`);
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.prompt).toBe(EXPECTED_PROMPT);
    expect(body.model).toBe("qwen-local");
    expect(body.max_tokens).toBe(512);
    // NOT a chat request: no messages array may ride along.
    expect(body.messages).toBeUndefined();
    expect(result.text).toBe(" there lived a wizard.");
  });

  it("rides the prefill as the trailing continuation of the flat string", async () => {
    installFetchStub(() => new Response(JSON.stringify(COMPLETION_JSON), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));

    await nonstreamingProviderExecute(makeInput({ prefill: "*low voice* " }));

    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.prompt).toBe(`${EXPECTED_PROMPT}\nAssistant: *low voice* `);
  });

  it("a chat-mode profile on the same preset still sends chat messages (silent backward compat)", async () => {
    installFetchStub(() => new Response(JSON.stringify({
      id: "chatcmpl-fixture", object: "chat.completion", model: "qwen-local",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await nonstreamingProviderExecute(makeInput({
      profile: makeProfile({ generationMode: GENERATION_MODE.chat }),
    }));

    expect(calls[0]!.url).toBe(`http://127.0.0.1:${FIXTURE_PORT}/v1/chat/completions`);
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.prompt).toBeUndefined();
    expect(result.text).toBe("Hello!");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Streaming: streamText → SSE /completions (parity with the chat path)
// ═══════════════════════════════════════════════════════════════════════

describe("completion mode — streamProviderExecutor", () => {
  it("streams text deltas from the /completions SSE (same chunk contract as chat)", async () => {
    installFetchStub(() => sseResponse(STREAM_CHUNKS));

    const result = await streamProviderExecutor(makeInput());

    const deltas: string[] = [];
    for await (const chunk of result.stream) {
      if (chunk.type === "text-delta") deltas.push(chunk.delta);
    }
    expect(deltas.join("")).toBe(" there lived a wizard.");
    const finished = await result.finished;
    expect(finished.finishReason).toBe("stop");
    expect(await result.text).toBe(" there lived a wizard.");

    // Request assertions AFTER consumption: streamText resolves the model
    // lazily, so the fetch fires on first pull.
    expect(calls[0]!.url).toBe(`http://127.0.0.1:${FIXTURE_PORT}/v1/completions`);
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.prompt).toBe(EXPECTED_PROMPT);
    expect(body.stream).toBe(true);
  });

  it("SSE abort parity: a pre-aborted signal settles the stream promises as cancelled, like the chat paths", async () => {
    const controller = new AbortController();
    controller.abort();

    installFetchStub(() => new Response("{}", { status: 200 }));

    // The executor returns (setup does not throw — same as the chat path);
    // the abort surfaces through the finish/text promises (mapFinish/safe
    // wrappers settle cancelled instead of rejecting) and the stream ending.
    const result = await streamProviderExecutor(makeInput({ signal: controller.signal }));
    const finished = await result.finished;
    expect(finished.finishReason).toBe("cancelled");
    expect(await result.text).toBe("");
  });
});
