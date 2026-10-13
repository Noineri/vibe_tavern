/**
 * CPF-2b — Continue prefill fallback at the orchestrator boundary.
 *
 * WHAT THIS PROVES
 *   1. Clean-rejection retry-once, BOTH seams: a backend 400 carrying the
 *      real multiai/Gemini rejection text («The conversation cannot end with a
 *      model response. …») triggers exactly ONE re-issue, whose request shape
 *      is the fallback (target message IN history + trailing user
 *      instruction, NO assistant prefill), and whose reply is stitched onto
 *      the original variant text via mergeContinuation (overlap trimmed).
 *   2. Rejection memory: a second Continue click on the same orchestrator
 *      sends the fallback request FIRST — no doomed prefill call in between.
 *   3. Non-prefill errors (5xx, even with a matching message) never retry —
 *      the detector's status corroboration — and surface exactly as before
 *      (non-streaming: thrown; streaming: `error` SSE event, no variant).
 *   4. Trace lifecycle across the retry: the rejected attempt's pending trace
 *      is discarded (never consumed), the fallback assembly opts into
 *      setPendingTrace and its patch clears `prefill` (nothing rode).
 *   5. Runtime-level (REAL ChatRuntime): setPendingTrace attributes the
 *      fallback variant (model + preset flow through the append) and
 *      patchPendingTrace({prefill: null}) clears a stale preset prefill.
 *   6. CPF-3 direct entry: Continue on a `prefill: false` protocol (google)
 *      runs the fallback FIRST — exactly ONE wire call in fallback shape
 *      (target IN history, trailing user instruction), a stitched variant,
 *      and NO prefill attempt (no exclusion assembly, no discard, no error).
 *
 * HOW: the real orchestrator methods with the REAL executors — the stub sits
 * at the external boundary (globalThis.fetch, queue of prepared Responses),
 * no executor mocks, no mock.module (tier policy: T2 true external boundary).
 * Prompt assembly is stubbed at the chatRuntime DI seam (same harness as
 * live-chat-continue.test.ts) with different histories for the excluded
 * (prefill) and full (fallback) assemblies.
 */
import { describe, expect, it, beforeEach, afterEach, afterAll } from "bun:test";
import { brandId, EventBus } from "@vibe-tavern/domain";
import type { ChatBranchId, ChatId, MessageId, ProviderResponseTrace, StoredProviderProfileRecord } from "@vibe-tavern/domain";
import { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";
import { RpModeStrategy } from "../src/domain/chat/chat-mode-strategy.js";
import { ChatRuntime } from "../src/runtime/session/session-runtime-chat.js";
import { CONTINUATION_USER_INSTRUCTION } from "../src/infrastructure/ai/provider-executor-utils.js";
import { mergeContinuation } from "../src/infrastructure/ai/merge-continuation.js";
import { nonstreamingProviderExecute } from "../src/infrastructure/ai/nonstreaming-provider-executor.js";
import { streamProviderExecutor } from "../src/infrastructure/ai/stream-provider-executor.js";
import { ProviderExecutionError } from "../src/infrastructure/ai/provider-execution-types.js";

const CHAT = "chat_1";
const MESSAGE = "msg_1";
/** The selected variant's text — the continuation start. */
const ORIGINAL = "The night grew cold and the lantern flickered over broken wings.";
/** The model re-emits the tail (overlap) before continuing. */
const CONTINUATION_OVERLAP = "wings. And then the rain came down.";
/** Composition pin (not internals): overlap trimmed, single "wings.". */
const MERGED_OVERLAP = mergeContinuation(ORIGINAL, CONTINUATION_OVERLAP).content;
/** Mid-word continuation: no overlap — glued verbatim. */
const MID_WORD_ORIGINAL = "He opened the heavy doo";
const MID_WORD_CONTINUATION = "r creaked ominously.";
const MID_WORD_MERGED = "He opened the heavy door creaked ominously.";
const REJECTION_MESSAGE = "The conversation cannot end with a model response. Add a user or tool message before continuing.";

// ─── Wire stub (external boundary) ──────────────────────────────────────────

interface WireCall {
  url: string;
  messages: Array<{ role: string; content: string }>;
  /** The raw request body (native-protocol shapes carry no `messages`). */
  rawBody: string;
}

const realFetch = globalThis.fetch;
let restoreFetch: (() => void) | null = null;

function installFetchQueue(responses: Array<() => Response>): WireCall[] {
  const calls: WireCall[] = [];
  let index = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const rawBody = typeof init?.body === "string" ? init.body : "";
    let messages: Array<{ role: string; content: string }> = [];
    if (rawBody) {
      const parsed = JSON.parse(rawBody) as { messages?: Array<{ role: string; content: string }> };
      messages = parsed.messages ?? [];
    }
    calls.push({ url, messages, rawBody });
    const next = responses[index];
    index += 1;
    if (!next) throw new Error(`unexpected provider fetch #${index} (${url})`);
    return next();
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = realFetch;
    restoreFetch = null;
  };
  return calls;
}

beforeEach(() => {
  restoreFetch?.();
});
afterEach(() => {
  restoreFetch?.();
});
afterAll(() => {
  restoreFetch?.();
});

/** The real multiai/Gemini rejection body, verbatim (status configurable —
 *  the 5xx variant pins the detector's status corroboration). */
function multiaiRejection(status = 400): () => Response {
  return () => new Response(JSON.stringify({ error: { message: REJECTION_MESSAGE } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A plain OpenAI-compatible chat completion (non-streaming success). */
function completion(text: string): () => Response {
  return () => new Response(JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 0,
    model: "model-1",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

/** An OpenAI-compatible SSE completion stream (streaming success). */
function sseCompletion(deltas: string[]): () => Response {
  return () => {
    const encoder = new TextEncoder();
    const chunk = (payload: Record<string, unknown>): string => `data: ${JSON.stringify(payload)}\n\n`;
    const parts = deltas.map((delta) => chunk({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 0,
      model: "model-1",
      choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
    }));
    parts.push(chunk({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 0,
      model: "model-1",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }));
    parts.push("data: [DONE]\n\n");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

// ─── Orchestrator harness (real executors, stubbed runtime + strategy) ──────

function makeProfile(): StoredProviderProfileRecord {
  // "multiai" is not a known preset → normalizes to openai_compat (the
  // aggregator protocol; prefill-capable — the gate under test).
  return {
    id: "profile_1",
    name: "profile",
    providerPreset: "multiai",
    coauthorTransport: "chatCompletions",
    generationMode: "chat",
    endpoint: "http://127.0.0.1:9/v1",
    apiKey: "test-key",
    defaultModel: "model-1",
    contextBudget: 16000,
    pinContextBudget: false,
    tokenPadding: 0,
    bindPerModel: false,
    modelFreeOnly: false,
    modelGroupByOwner: false,
    maxTokens: 512,
    stopSequences: [],
    bannedStrings: [],
    logitBias: [],
    seed: null,
    showReasoning: false,
    streamResponse: true,
    customSamplers: false,
    proxyMode: "direct",
    proxyId: null,
  } as StoredProviderProfileRecord;
}

interface ContinueCalls {
  assemblies: Array<{ excludeMessageId?: MessageId; setPendingTrace?: boolean }>;
  appendedVariants: Array<{ messageId: string; content: string }>;
  tracePatches: Array<{ prefill?: string | null; sentConfig?: unknown; providerResponse?: unknown }>;
  discards: number;
}

function makeCalls(): ContinueCalls {
  return { assemblies: [], appendedVariants: [], tracePatches: [], discards: 0 };
}

/** Required-but-unused orchestrator deps (chatApp / providers — the continue
 *  paths never touch them). One declaration so the nominal-class cast is a
 *  single, counted suppression instead of per-site noise. */
const UNSET = null as never;

/** chatRuntime DI stub: the prefill assembly EXCLUDES the target message (so
 *  the executor's prefill push is the only trailing assistant), the fallback
 *  assembly keeps it in history — mirroring the real assembly contract. */
function makeOrchestrator(calls: ContinueCalls, executors?: {
  nonstreaming: typeof nonstreamingProviderExecute;
  stream: typeof streamProviderExecutor;
}): LiveChatOrchestrator {
  const prefillHistory = [{ role: "user", content: "Tell me a story." }];
  const fallbackHistory = [
    { role: "user", content: "Tell me a story." },
    { role: "assistant", content: ORIGINAL },
  ];
  const runtime = {
    async assemblePromptPreview(_chatId: string, options: { excludeMessageId?: MessageId; setPendingTrace?: boolean }) {
      calls.assemblies.push({ excludeMessageId: options.excludeMessageId, setPendingTrace: options.setPendingTrace });
      return {
        prefill: null,
        finalPayload: { messages: options.excludeMessageId ? prefillHistory : fallbackHistory },
      };
    },
    async appendMessageVariant(_chatId: string, messageId: MessageId, input: { content: string }) {
      calls.appendedVariants.push({ messageId, content: input.content });
      return { messages: [], overflowAlerts: [] };
    },
    patchPendingTrace(_chatId: string, patch: { prefill?: string | null; sentConfig?: unknown; providerResponse?: unknown }) {
      calls.tracePatches.push({ prefill: patch.prefill, sentConfig: patch.sentConfig, providerResponse: patch.providerResponse });
    },
    discardPendingPromptTrace() {
      calls.discards += 1;
    },
  } as never;
  // The REAL RP strategy — dependency-free, pass-through provider resolution:
  // better fidelity than a stub for the continue paths under test.
  const strategy = new RpModeStrategy();
  // regexHooks + executors omitted → REAL infrastructure executors run; the
  // only test double is globalThis.fetch (the external boundary). The 5xx
  // corroboration case injects an executor stub through the same DI seam
  // instead (see that test for why).
  return new LiveChatOrchestrator(
    runtime,
    UNSET,
    UNSET,
    new EventBus(),
    async () => strategy,
    undefined,
    undefined,
    executors,
  );
}

function continueInput(continuationText: string) {
  return {
    chatId: CHAT,
    messageId: MESSAGE,
    continuationText,
    profile: makeProfile(),
    model: "model-1",
  };
}

// ─── Wire-shape helpers ─────────────────────────────────────────────────────

function lastMessage(call: WireCall): { role: string; content: string } {
  const last = call.messages[call.messages.length - 1];
  if (!last) throw new Error("no messages on the wire");
  return last;
}

function historyContains(call: WireCall, role: string, content: string): boolean {
  return call.messages.some((m) => m.role === role && m.content === content);
}

// ─── Cases ──────────────────────────────────────────────────────────────────

describe("LiveChatOrchestrator — continue prefill fallback, streaming (CPF-2b)", () => {
  it("retries once on a clean rejection: call 1 rides the assistant prefill, call 2 the user instruction, one stitched variant", async () => {
    const calls = makeCalls();
    const orchestrator = makeOrchestrator(calls);
    const wire = installFetchQueue([
      multiaiRejection(),
      sseCompletion(["wings.", " And then the rain came down."]),
    ]);

    const events: Array<{ event: string; data: string }> = [];
    for await (const event of orchestrator.continueMessageStream(continueInput(ORIGINAL))) {
      events.push(event);
    }

    // Exactly one wire re-issue; the rejected attempt never reached the client.
    expect(wire).toHaveLength(2);
    expect(events.some((e) => e.event === "error")).toBe(false);
    expect(events.some((e) => e.event === "text-delta")).toBe(true);
    expect(events.some((e) => e.event === "finish")).toBe(true);
    // Call 1: the prefill shape — history WITHOUT the target, trailing assistant prefill.
    expect(lastMessage(wire[0]!).role).toBe("assistant");
    expect(lastMessage(wire[0]!).content).toBe(ORIGINAL);
    expect(wire[0]!.messages).toHaveLength(2);
    // Call 2: the fallback shape — target IN history, trailing user instruction.
    expect(historyContains(wire[1]!, "assistant", ORIGINAL)).toBe(true);
    expect(lastMessage(wire[1]!).role).toBe("user");
    expect(lastMessage(wire[1]!).content).toBe(CONTINUATION_USER_INSTRUCTION);
    // One variant, stitched (overlap trimmed — a single "wings.").
    expect(calls.appendedVariants).toHaveLength(1);
    expect(calls.appendedVariants[0]!.messageId).toBe(MESSAGE);
    expect(calls.appendedVariants[0]!.content).toBe(MERGED_OVERLAP);
    // Trace lifecycle: rejected pending trace discarded, fallback assembly traced, prefill cleared.
    expect(calls.discards).toBe(1);
    expect(calls.assemblies).toEqual([
      { excludeMessageId: MESSAGE, setPendingTrace: undefined },
      { excludeMessageId: undefined, setPendingTrace: true },
    ]);
    expect(calls.tracePatches[0]!.prefill).toBe(ORIGINAL);
    expect(calls.tracePatches[calls.tracePatches.length - 1]!.prefill).toBe(null);
  });

  it("memory: a second Continue click sends the fallback request FIRST (no rejected call in between)", async () => {
    const calls = makeCalls();
    const orchestrator = makeOrchestrator(calls);
    const wire = installFetchQueue([
      multiaiRejection(),
      completion(CONTINUATION_OVERLAP),
      completion(CONTINUATION_OVERLAP),
    ]);

    const first = await orchestrator.continueMessage(continueInput(ORIGINAL));
    expect(first.reply).toBe(MERGED_OVERLAP);
    const wireAfterFirstClick = wire.length;

    const second = await orchestrator.continueMessage(continueInput(ORIGINAL));

    // Click 2 issued exactly ONE call — the fallback shape directly.
    expect(wire).toHaveLength(wireAfterFirstClick + 1);
    expect(lastMessage(wire[2]!).role).toBe("user");
    expect(lastMessage(wire[2]!).content).toBe(CONTINUATION_USER_INSTRUCTION);
    expect(historyContains(wire[2]!, "assistant", ORIGINAL)).toBe(true);
    expect(second.reply).toBe(MERGED_OVERLAP);
    // Click 2 assembled ONCE — no exclude, still traced, no prefill patch.
    expect(calls.assemblies).toHaveLength(3);
    expect(calls.assemblies[2]).toEqual({ excludeMessageId: undefined, setPendingTrace: true });
    expect(calls.appendedVariants).toHaveLength(2);
  });

  it("a 5xx error (even with a matching message) never retries — detector status corroboration", async () => {
    const calls = makeCalls();
    // Injected at the executor DI seam, NOT the wire: the real SDK retries a
    // 5xx twice itself (~6s of deterministic internal backoff — over bun's
    // 5s per-test budget), which would pin the SDK's retries, not ours. This
    // test pins the ORCHESTRATOR wiring: a ProviderExecutionError carrying
    // statusCode 500 + a matching message → detector's 5xx corroboration
    // forces false → no fallback call, existing discard + rethrow.
    const executorInputs: Array<{ prefill?: string; continuationFallback?: boolean }> = [];
    const orchestrator = makeOrchestrator(calls, {
      nonstreaming: async (input) => {
        executorInputs.push(input);
        throw new ProviderExecutionError(REJECTION_MESSAGE, "server_error", "openai_compat", { statusCode: 500 });
      },
      stream: async () => {
        throw new Error("stream executor is not exercised by this test");
      },
    });

    await expect(orchestrator.continueMessage(continueInput(ORIGINAL))).rejects.toMatchObject({ message: REJECTION_MESSAGE });
    expect(executorInputs).toHaveLength(1); // the one prefill attempt — no fallback re-issue
    expect(executorInputs[0]!.prefill).toBe(ORIGINAL);
    expect(calls.appendedVariants).toHaveLength(0);
    expect(calls.discards).toBe(1);
    expect(calls.assemblies).toHaveLength(1); // no re-assembly either
  });

  it("a generic streaming error forwards the error event unchanged — no retry, no variant", async () => {
    const calls = makeCalls();
    const orchestrator = makeOrchestrator(calls);
    // Generic 400 (non-retryable for the SDK, no internal backoff). On the
    // stream path the wire status is already lost by the time the error event
    // is emitted (the executor error is flattened to a message), so the
    // 5xx-status corroboration is pinned on the non-streaming case above —
    // here the pin is: message does NOT match the detector → forward.
    const wire = installFetchQueue([() => new Response(JSON.stringify({ error: { message: "internal server error" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })]);

    const events: Array<{ event: string; data: string }> = [];
    for await (const event of orchestrator.continueMessageStream(continueInput(ORIGINAL))) {
      events.push(event);
    }

    expect(wire).toHaveLength(1);
    expect(calls.appendedVariants).toHaveLength(0);
    const errorEvents = events.filter((e) => e.event === "error");
    expect(errorEvents).toHaveLength(1);
    expect(JSON.parse(errorEvents[0]!.data as string).message).toBe("internal server error");
  });

  it("no-overlap continuation glues mid-word: merged variant is original + continuation verbatim", async () => {
    const calls = makeCalls();
    const orchestrator = makeOrchestrator(calls);
    const wire = installFetchQueue([
      multiaiRejection(),
      sseCompletion(["r creaked ominously."]),
    ]);

    const events: Array<{ event: string; data: string }> = [];
    for await (const event of orchestrator.continueMessageStream(continueInput(MID_WORD_ORIGINAL))) {
      events.push(event);
    }

    expect(wire).toHaveLength(2);
    expect(calls.appendedVariants).toHaveLength(1);
    // Composition pin: nothing trimmed, nothing glued extra.
    expect(calls.appendedVariants[0]!.content).toBe(MID_WORD_MERGED);
    expect(events.some((e) => e.event === "error")).toBe(false);
  });
});

describe("LiveChatOrchestrator — continue prefill fallback, non-streaming (CPF-2b)", () => {
  it("retries once on a clean rejection: same wire swap, merged reply, honest trace", async () => {
    const calls = makeCalls();
    const orchestrator = makeOrchestrator(calls);
    const wire = installFetchQueue([
      multiaiRejection(),
      completion(CONTINUATION_OVERLAP),
    ]);

    const result = await orchestrator.continueMessage(continueInput(ORIGINAL));

    expect(wire).toHaveLength(2);
    expect(lastMessage(wire[0]!).role).toBe("assistant");
    expect(lastMessage(wire[0]!).content).toBe(ORIGINAL);
    expect(lastMessage(wire[1]!).role).toBe("user");
    expect(lastMessage(wire[1]!).content).toBe(CONTINUATION_USER_INSTRUCTION);
    expect(historyContains(wire[1]!, "assistant", ORIGINAL)).toBe(true);
    expect(result.reply).toBe(MERGED_OVERLAP);
    expect(calls.appendedVariants).toHaveLength(1);
    expect(calls.appendedVariants[0]!.content).toBe(MERGED_OVERLAP);
    expect(calls.discards).toBe(1);
    expect(calls.assemblies).toEqual([
      { excludeMessageId: MESSAGE, setPendingTrace: undefined },
      { excludeMessageId: undefined, setPendingTrace: true },
    ]);
    // The prefill patch from the rejected attempt, then the fallback patch clearing prefill.
    expect(calls.tracePatches[0]!.prefill).toBe(ORIGINAL);
    expect(calls.tracePatches[calls.tracePatches.length - 1]!.prefill).toBe(null);
  });
});

describe("LiveChatOrchestrator — continue direct fallback on prefill:false protocols (CPF-3)", () => {
  function makeGoogleProfile(): StoredProviderProfileRecord {
    return {
      ...makeProfile(),
      providerPreset: "google",
      endpoint: "https://generativelanguage.googleapis.com",
      apiKey: "test-key",
      defaultModel: "gemini-test",
    };
  }

  function continueGoogleInput(continuationText: string) {
    return {
      chatId: CHAT,
      messageId: MESSAGE,
      continuationText,
      profile: makeGoogleProfile(),
      model: "gemini-test",
    };
  }

  /** A Google-native generateContent response (non-streaming success). */
  function googleCompletion(text: string): () => Response {
    return () => new Response(JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  /** A Google-native SSE stream (streaming success). */
  function googleStream(deltas: string[]): () => Response {
    return () => {
      const encoder = new TextEncoder();
      const parts = deltas.map((text) => `data: ${JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text }] }, index: 0 }],
      })}\n\n`);
      parts.push(`data: ${JSON.stringify({
        candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      })}\n\n`);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const part of parts) controller.enqueue(encoder.encode(part));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
  }

  interface GoogleWireContent {
    role: string;
    text: string;
  }

  /** Google-native wire body → the contents list as (role, text) pairs. */
  function googleContents(call: WireCall): GoogleWireContent[] {
    const parsed = JSON.parse(call.rawBody) as { contents?: Array<{ role: string; parts: Array<{ text?: string }> }> };
    if (!parsed.contents) throw new Error("no contents on the google wire body");
    return parsed.contents.map((content) => ({
      role: content.role,
      text: content.parts.map((part) => part.text ?? "").join(""),
    }));
  }

  it("non-streaming: ONE wire call in fallback shape, stitched variant, no prefill attempt, no error", async () => {
    const calls = makeCalls();
    const orchestrator = makeOrchestrator(calls);
    const wire = installFetchQueue([googleCompletion(CONTINUATION_OVERLAP)]);

    const result = await orchestrator.continueMessage(continueGoogleInput(ORIGINAL));

    // Direct entry — exactly ONE wire call, no rejected prefill attempt.
    expect(wire).toHaveLength(1);
    // Fallback shape: the target IN history (model turn) + the trailing user instruction.
    const contents = googleContents(wire[0]!);
    expect(contents).toEqual([
      { role: "user", text: "Tell me a story." },
      { role: "model", text: ORIGINAL },
      { role: "user", text: CONTINUATION_USER_INSTRUCTION },
    ]);
    // One variant, stitched (overlap trimmed — a single "wings.").
    expect(result.reply).toBe(MERGED_OVERLAP);
    expect(calls.appendedVariants).toHaveLength(1);
    expect(calls.appendedVariants[0]!.messageId).toBe(MESSAGE);
    expect(calls.appendedVariants[0]!.content).toBe(MERGED_OVERLAP);
    // No exclusion assembly (a single traced assembly), nothing discarded,
    // and no prefill ever rode (the single patch clears it).
    expect(calls.assemblies).toEqual([{ excludeMessageId: undefined, setPendingTrace: true }]);
    expect(calls.discards).toBe(0);
    expect(calls.tracePatches).toHaveLength(1);
    expect(calls.tracePatches[0]!.prefill).toBe(null);
  });

  it("streaming: ONE wire call in fallback shape, deltas stream, stitched variant, no error event", async () => {
    const calls = makeCalls();
    const orchestrator = makeOrchestrator(calls);
    const wire = installFetchQueue([googleStream(["wings.", " And then the rain came down."])]);

    const events: Array<{ event: string; data: string }> = [];
    for await (const event of orchestrator.continueMessageStream(continueGoogleInput(ORIGINAL))) {
      events.push(event);
    }

    // Direct entry — exactly ONE wire call, and the client saw no error.
    expect(wire).toHaveLength(1);
    expect(events.some((e) => e.event === "error")).toBe(false);
    expect(events.some((e) => e.event === "text-delta")).toBe(true);
    expect(events.some((e) => e.event === "finish")).toBe(true);
    // Fallback shape: the target IN history (model turn) + the trailing user instruction.
    const contents = googleContents(wire[0]!);
    expect(contents).toEqual([
      { role: "user", text: "Tell me a story." },
      { role: "model", text: ORIGINAL },
      { role: "user", text: CONTINUATION_USER_INSTRUCTION },
    ]);
    // One variant, stitched (overlap trimmed — a single "wings.").
    expect(calls.appendedVariants).toHaveLength(1);
    expect(calls.appendedVariants[0]!.messageId).toBe(MESSAGE);
    expect(calls.appendedVariants[0]!.content).toBe(MERGED_OVERLAP);
    // No exclusion assembly, nothing discarded, no prefill ever rode.
    expect(calls.assemblies).toEqual([{ excludeMessageId: undefined, setPendingTrace: true }]);
    expect(calls.discards).toBe(0);
    expect(calls.tracePatches).toHaveLength(1);
    expect(calls.tracePatches[0]!.prefill).toBe(null);
  });
});

describe("ChatRuntime — setPendingTrace (CPF-2b fallback trace attribution)", () => {
  function makeRealRuntime() {
    const addVariantCalls: Array<{ messageId: string; content: string; modelId: string | null; presetName: string | null }> = [];
    const savedTraces: Array<{ model: string; presetName: string; prefill?: string | null; finalPayload?: Record<string, unknown> }> = [];
    const finalPayload = { messages: [{ role: "user", content: "Tell me a story." }, { role: "assistant", content: ORIGINAL }] };
    // One whole-deps cast: ChatRuntimeDeps members are nominal store/app
    // classes (ChatStore, MessageStore, …) that stub literals cannot satisfy
    // structurally — the per-member alternatives would be a dozen casts.
    const runtime = new ChatRuntime({
      chats: { getById: async () => ({ activeBranchId: brandId<ChatBranchId>("branch_1") }) },
      messages: {
        addVariant: async (messageId: string, content: string, _finishReason: undefined, _reasoning: undefined, _duration: undefined, modelId: string | null, presetName: string | null) => {
          addVariantCalls.push({ messageId, content, modelId, presetName });
        },
      },
      traces: {
        saveTrace: async (data: { model: string; presetName: string; prefill?: string | null; finalPayload?: Record<string, unknown> }) => {
          savedTraces.push({ model: data.model, presetName: data.presetName, prefill: data.prefill, finalPayload: data.finalPayload });
        },
      },
      chatApp: null,
      diceRolls: null,
      uiSettings: null,
      experiences: null,
      assemblePrompt: async () => ({
        branchId: brandId<ChatBranchId>("branch_1"),
        prompt: { finalPayload },
        promptTraceDraft: {
          chatId: CHAT,
          branchId: brandId<ChatBranchId>("branch_1"),
          model: "model-1",
          presetId: null,
          presetName: "Fallback Preset",
          assembledLayers: [],
          tokenAccounting: {},
          finalPayload,
          activatedLoreEntries: [],
          activatedLoreDetail: [],
          retrievedMemories: [],
          scriptInjections: [],
          latencyMs: 0,
          prefill: "Stale preset prefill",
        },
        tools: undefined,
        maxSteps: undefined,
        coauthorModuleId: undefined,
        coauthorSkillId: null,
      }),
      getSnapshot: null,
      buildMessageResponse: async () => ({ messages: [] }),
      buildVariantResponse: null,
      buildBranchResponse: null,
      buildBranchMetaResponse: null,
      buildChatListResponse: null,
      chatOrder: null,
    } as never);
    return { runtime, addVariantCalls, savedTraces };
  }

  it("a no-exclude assembly with setPendingTrace attributes the variant and saves the fallback trace", async () => {
    const { runtime, addVariantCalls, savedTraces } = makeRealRuntime();
    await runtime.assemblePromptPreview(brandId<ChatId>(CHAT), { model: "model-1", setPendingTrace: true });
    await runtime.appendMessageVariant(brandId<ChatId>(CHAT), brandId<MessageId>(MESSAGE), { content: MERGED_OVERLAP, latencyMs: 7 });

    // The (b2) attribution hole, pinned: model + preset flow to the variant.
    expect(addVariantCalls).toHaveLength(1);
    expect(addVariantCalls[0]!.modelId).toBe("model-1");
    expect(addVariantCalls[0]!.presetName).toBe("Fallback Preset");
    // And the saved trace describes the fallback request's payload.
    expect(savedTraces).toHaveLength(1);
    expect(savedTraces[0]!.model).toBe("model-1");
  });

  it("without setPendingTrace a no-exclude assembly stays untraced (unchanged preview behavior)", async () => {
    const { runtime, addVariantCalls, savedTraces } = makeRealRuntime();
    await runtime.assemblePromptPreview(brandId<ChatId>(CHAT), { model: "model-1" });
    await runtime.appendMessageVariant(brandId<ChatId>(CHAT), brandId<MessageId>(MESSAGE), { content: MERGED_OVERLAP, latencyMs: 7 });

    expect(addVariantCalls[0]!.modelId).toBe(null);
    expect(savedTraces).toHaveLength(0);
  });

  it("patchPendingTrace({ prefill: null }) clears a stale preset prefill (fallback honesty)", async () => {
    const { runtime, savedTraces } = makeRealRuntime();
    await runtime.assemblePromptPreview(brandId<ChatId>(CHAT), { model: "model-1", setPendingTrace: true });
    runtime.patchPendingTrace(brandId<ChatId>(CHAT), {
      providerResponse: { mode: "stream", steps: [] } satisfies ProviderResponseTrace,
      prefill: null,
    });
    await runtime.appendMessageVariant(brandId<ChatId>(CHAT), brandId<MessageId>(MESSAGE), { content: MERGED_OVERLAP, latencyMs: 7 });

    expect(savedTraces).toHaveLength(1);
    expect(savedTraces[0]!.prefill).toBe(null);
  });
});
