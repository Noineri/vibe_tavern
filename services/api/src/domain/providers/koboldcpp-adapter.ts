/**
 * KoboldCPP native adapter — thin LanguageModelV3 wrapper.
 *
 * KoboldCPP uses a non-standard generation endpoint (`/api/v1/generate`)
 * that is NOT OpenAI-compatible. This adapter implements the LanguageModelV3
 * interface directly, routing through KoboldCPP's native API:
 *
 * - Generation:  POST /api/v1/generate  (blocking)
 * - Streaming:   POST /api/extra/generate/stream  (SSE)
 * - Model info:  GET  /api/v1/model
 * - Abort:       POST /api/extra/abort
 *
 * Sampler parameters are passed directly in the request body using
 * KoboldCPP's native parameter names (top_k, top_p, rep_pen, etc.).
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  LanguageModelV3FinishReason,
  LanguageModelV3Text,
} from "@ai-sdk/provider";
import {
  MODEL_LIST_TIMEOUT_MS,
  TEST_CHAT_TIMEOUT_MS,
  TOKENIZE_TIMEOUT_MS,
  normalizeKoboldCppBaseUrl,
  tryParseUrl,
  wrapProviderNetworkError,
  type ProviderConnectionInput,
  type ProviderModelOption,
  type ProviderProbeResult,
  type TestChatResult,
} from "./provider-transport.js";
import { PROVIDER_TYPE, SAMPLER_SETS } from "@vibe-tavern/domain";
import type { ProtocolAdapter, ProbeInput, ListModelsInput, TokenizeInput, CompletionFormatHandoff } from "./protocol-types.js";
import { serializeCompletionPrompt, DEFAULT_COMPLETION_TEMPLATE, templateStopMarkers, unionStopSequences, type CompletionFormatTemplate } from "./completion-prompt.js";
import type { ProviderFetch } from "./provider-fetch-factory.js";

// ─── Types ───────────────────────────────────────────────────────────────

/** KoboldCPP generation request body. */
interface KoboldGenerateRequest {
  prompt: string;
  max_context_length?: number;
  max_length?: number;
  temperature?: number;
  top_k?: number;
  top_p?: number;
  min_p?: number;
  top_a?: number;
  typical?: number;
  tfs?: number;
  rep_pen?: number;
  rep_pen_range?: number;
  dry_multiplier?: number;
  dry_base?: number;
  dry_allowed_length?: number;
  dry_sequence_breakers?: string[];
  xtc_threshold?: number;
  xtc_probability?: number;
  mirostat?: number;
  mirostat_tau?: number;
  mirostat_eta?: number;
  stop_sequence?: string[];
  seed?: number;
  stream?: boolean;
}

function makeUsage(): LanguageModelV3Usage {
  return {
    inputTokens: { total: 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 0, text: undefined, reasoning: undefined },
  };
}

function makeFinishReason(reason: LanguageModelV3FinishReason["unified"]): LanguageModelV3FinishReason {
  return { unified: reason, raw: reason };
}
interface KoboldGenerateResponse {
  results: Array<{ text: string }>;
}

/** KoboldCPP SSE token event. */
interface KoboldStreamTokenEvent {
  token: string;
}

/** KoboldCPP SSE done event. */
interface KoboldStreamDoneEvent {
  text: string;
  done: boolean;
}

export interface KoboldCppAdapterOptions {
  /** Base URL (e.g. http://localhost:5001). */
  baseURL: string;
  /** Model ID (from /api/v1/model). */
  modelId: string;
  /** AbortSignal for the generation. */
  signal?: AbortSignal;
  /** Optional proxy-aware fetch honoring the profile's proxy policy. */
  fetch?: ProviderFetch;
  /** LS-6b: the preset's manual Generation-format template, threaded through
   *  the same handoff the openai-compat completion seam uses. Absent (auto)
   *  → the default role-prefixed serialization — byte-identical to the
   *  pre-LS-6 hardcoded serializer except the trailing-assistant continuation
   *  (the LS-3 seam semantics: a trailing assistant line IS the continuation
   *  point, no extra bare trailer). */
  template?: CompletionFormatTemplate;
}

// ─── Prompt serialization ────────────────────────────────────────────────

/**
 * Convert AI SDK model prompt messages into a single text prompt for KoboldCPP.
 *
 * KoboldCPP's native API takes a flat `prompt` string, not structured messages.
 * Delegates to the SHARED serialization seam (`completion-prompt.ts` —
 * LS-6b): the default template renders the historical role-prefixed shape
 * ("System: / User: / Assistant:" lines, "\n" separator, bare continuation
 * prefix); a manual template from the preset's Generation-format tab renders
 * the ST-instruct semantics through the same seam the llama path uses.
 */
function serializePrompt(
  prompt: LanguageModelV3CallOptions["prompt"],
  template?: CompletionFormatTemplate,
): string {
  return serializeCompletionPrompt(prompt, { template });
}

/**
 * LS-9 implied stops for this model instance (owner rule, 2026-09-09): in
 * AUTO the native serializer owns the role markers — they ride into
 * `stop_sequence` alongside the user's own stops (a model continuing the
 * dialog writes "User:" and rambles otherwise; the owner's live runaway
 * catch). A MANUAL template means the user authors the format — NOTHING is
 * injected, their stops ride alone (the empty-stops hint is the format
 * pane's job, LS-10).
 */
function impliedStopsFor(template: CompletionFormatTemplate | undefined): string[] {
  return template ? [] : templateStopMarkers(DEFAULT_COMPLETION_TEMPLATE);
}

// ─── Adapter ─────────────────────────────────────────────────────────────

/**
 * Create a LanguageModelV3 adapter for KoboldCPP.
 */
export function createKoboldCppModel(options: KoboldCppAdapterOptions): LanguageModelV3 {
  const { baseURL, modelId, fetch: customFetch, template } = options;
  const base = baseURL.replace(/\/+$/, "");
  const doFetch: typeof fetch = customFetch ?? fetch;
  const impliedStops = impliedStopsFor(template);

  return {
    specificationVersion: "v3",
    provider: "koboldcpp",
    modelId,
    supportedUrls: {},

    async doGenerate(callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      const prompt = serializePrompt(callOptions.prompt, template);

      const body: KoboldGenerateRequest = {
        prompt,
        max_length: callOptions.maxOutputTokens ?? 512,
        temperature: callOptions.temperature ?? 1.0,
        top_p: callOptions.topP,
        top_k: callOptions.topK,
        stop_sequence: unionStopSequences(callOptions.stopSequences, impliedStops),
        seed: callOptions.seed,
        // Pass through providerOptions as KoboldCPP native sampler params
        ...(callOptions.providerOptions?.koboldcpp ?? {}),
      };

      const response = await doFetch(`${base}/api/v1/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: callOptions.abortSignal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`KoboldCPP generate error (${response.status}): ${text}`);
      }

      const data = (await response.json()) as KoboldGenerateResponse;
      const generatedText = data.results?.[0]?.text ?? "";

      const content: LanguageModelV3Text[] = generatedText
        ? [{ type: "text", text: generatedText }]
        : [];

      return {
        content,
        finishReason: makeFinishReason("stop"),
        usage: makeUsage(),
        warnings: [],
        request: { body },
      };
    },

    async doStream(callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      const prompt = serializePrompt(callOptions.prompt, template);

      const body: KoboldGenerateRequest = {
        prompt,
        max_length: callOptions.maxOutputTokens ?? 512,
        temperature: callOptions.temperature ?? 1.0,
        top_p: callOptions.topP,
        top_k: callOptions.topK,
        stop_sequence: unionStopSequences(callOptions.stopSequences, impliedStops),
        seed: callOptions.seed,
        ...(callOptions.providerOptions?.koboldcpp ?? {}),
      };

      const response = await doFetch(`${base}/api/extra/generate/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: callOptions.abortSignal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`KoboldCPP stream error (${response.status}): ${text}`);
      }

      if (!response.body) {
        throw new Error("KoboldCPP stream: no response body");
      }

      // Parse SSE stream from KoboldCPP and convert to AI SDK V3 stream parts.
      // LS-6d: the ai@7 streamText recorder requires the FULL protocol
      // sequence — stream-start first, a text-start before the first delta,
      // and a matching text-end before finish ("text part 0 not found" was
      // the recorder rejecting bare deltas). Flags persist across pull calls.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamStarted = false;
      let textOpened = false;

      const emitEventParts = (
        controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
        event: Record<string, unknown>,
      ) => {
        const parts = mapSSEEventToStreamParts(event);
        if (parts.length === 0) return;
        if (!textOpened) {
          textOpened = true;
          controller.enqueue({ type: "text-start", id: "0" });
        }
        for (const part of parts) controller.enqueue(part);
      };

      const closeTextAndFinish = (
        controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
      ) => {
        if (textOpened) {
          textOpened = false;
          controller.enqueue({ type: "text-end", id: "0" });
        }
        controller.enqueue({
          type: "finish",
          finishReason: makeFinishReason("stop"),
          usage: makeUsage(),
        });
        controller.close();
      };

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async pull(controller) {
          try {
            if (!streamStarted) {
              streamStarted = true;
              controller.enqueue({ type: "stream-start", warnings: [] });
            }
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                // Flush remaining buffer
                if (buffer.trim()) {
                  const event = parseSSEEvent(buffer);
                  if (event) emitEventParts(controller, event);
                }
                closeTextAndFinish(controller);
                return;
              }

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(":")) continue; // skip empty/comments

                const event = parseSSEEvent(trimmed);
                if (!event) continue;

                emitEventParts(controller, event);

                // Check for done event
                if ("done" in event && event.done) {
                  closeTextAndFinish(controller);
                  return;
                }
              }
            }
          } catch (err) {
            if (textOpened) {
              textOpened = false;
              controller.enqueue({ type: "text-end", id: "0" });
            }
            if (callOptions.abortSignal?.aborted) {
              controller.enqueue({
                type: "finish",
                finishReason: makeFinishReason("stop"),
                usage: makeUsage(),
              });
            } else {
              controller.enqueue({
                type: "error",
                error: err,
              } satisfies LanguageModelV3StreamPart);
            }
            controller.close();
          }
        },
      });

      return {
        stream,
        request: { body },
      };
    },
  };
}

// ─── SSE parsing ─────────────────────────────────────────────────────────

function parseSSEEvent(line: string): Record<string, unknown> | null {
  // KoboldCPP SSE format: "data: {...}"
  if (line.startsWith("data: ")) {
    try {
      return JSON.parse(line.slice(6));
    } catch {
      return null;
    }
  }
  // Some events come without the "data: " prefix (raw JSON)
  if (line.startsWith("{")) {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }
  return null;
}

function mapSSEEventToStreamParts(
  event: Record<string, unknown>,
): LanguageModelV3StreamPart[] {
  // Token event: { "token": " word" }
  if ("token" in event && typeof event.token === "string") {
    return [{ type: "text-delta", id: "0", delta: event.token }];
  }

  // Done event: { "text": "...", "done": true }
  if ("done" in event && event.done) {
    // The done event may include the full accumulated text, but we've
    // already streamed all tokens — nothing more to emit.
    return [];
  }

  return [];
}

// ─── Tokenize (LS-1a) ───────────────────────────────────────────────────

/** KoboldCPP `/api/extra/tokencount` response (V1f-probed shape). */
interface KoboldTokenCountResponse {
  value?: unknown;
  ids?: unknown;
}

/**
 * Per-base-url cache of the LEADING-SPECIALS BASELINE for `/api/extra/tokencount`.
 *
 * V1f probe finding (LOCAL_SAMPLERS_ADDITION_REPORT): KoboldCPP prepends the
 * model's BOS/special token to every tokencount response's `ids` (Qwen2.5 →
 * id 151643 `</s>`), so `value` (= ids.length) overcounts by 1 vs the exact
 * content count (llama-server /tokenize). The special is model-dependent and
 * invisible from a single response — but an EMPTY-prompt probe returns exactly
 * the prepended specials as `ids`, which detects it for any model. One probe
 * per backend, cached for the process lifetime.
 */
const koboldSpecialBaseline = new Map<string, number | null>();

async function probeKoboldSpecialBaseline(
  base: string,
  doFetch: typeof fetch,
  signal: AbortSignal,
): Promise<number | null> {
  const cached = koboldSpecialBaseline.get(base);
  if (cached !== undefined) return cached;
  try {
    const response = await doFetch(`${base}/api/extra/tokencount`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ prompt: "" }),
      signal,
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const payload = (await response.json()) as KoboldTokenCountResponse;
    if (!Array.isArray(payload.ids)) throw new Error("missing ids array");
    // ids for an empty prompt ARE the prepended specials (empty array = none).
    koboldSpecialBaseline.set(base, payload.ids.length);
    return payload.ids.length;
  } catch {
    // Remember the failure so every warm call doesn't re-probe a dead endpoint;
    // the count then falls back to `value` (V1f: overcounts by at most 1).
    koboldSpecialBaseline.set(base, null);
    return null;
  }
}

/**
 * Exact token count via KoboldCPP's native `POST /api/extra/tokencount`
 * (body field is `prompt`, NOT `text` — V1f correction).
 *
 * Normalization heuristic (pinned by fixture tests): prefer `ids.length` minus
 * the detected leading-specials baseline (empty-prompt probe) over `value`.
 * When the baseline probe fails, fall back to `value` — still far more accurate
 * than the local tokenizer ladder, off by at most 1 special token.
 */
export async function tokenizeKoboldCpp(input: TokenizeInput): Promise<number> {
  const base = normalizeKoboldCppBaseUrl(input.baseUrl);
  if (!base) throw new Error("KoboldCPP tokenize: provider endpoint is required.");
  const doFetch: typeof fetch = input.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKENIZE_TIMEOUT_MS);
  try {
    const baseline = await probeKoboldSpecialBaseline(base, doFetch, controller.signal);

    const response = await doFetch(`${base}/api/extra/tokencount`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ prompt: input.text }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`KoboldCPP tokencount failed (${response.status})${errorText ? `: ${errorText.slice(0, 200)}` : ""}`);
    }
    const payload = (await response.json()) as KoboldTokenCountResponse;
    const ids = Array.isArray(payload.ids) ? (payload.ids as unknown[]).length : null;
    const value = typeof payload.value === "number" ? payload.value : null;
    if (ids === null && value === null) {
      throw new Error("KoboldCPP tokencount: unexpected response shape (missing value and ids).");
    }
    // Exact: ids.length minus the detected leading specials. Guard against a
    // nonsensical baseline (≥ ids) by falling back to value.
    if (ids !== null && baseline !== null && baseline < ids) {
      return ids - baseline;
    }
    if (value !== null) return value;
    return ids ?? 0;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Model listing ───────────────────────────────────────────────────────

export interface KoboldModelInfo {
  result: string;
}

/**
 * Fetch the currently loaded model name from KoboldCPP.
 */
export async function fetchKoboldModel(baseURL: string, customFetch?: ProviderFetch): Promise<string> {
  const base = baseURL.replace(/\/+$/, "");
  const doFetch: typeof fetch = customFetch ?? fetch;
  const res = await doFetch(`${base}/api/v1/model`);
  if (!res.ok) throw new Error(`KoboldCPP model fetch failed (${res.status})`);
  const data = (await res.json()) as KoboldModelInfo;
  return data.result;
}

// ─── Registry-facing operations (probe / testChat / listModels) ───────────
// Moved from protocol-registry.ts; colocated with the native SDK wrapper so
// the full KoboldCPP protocol description lives in one file.

export async function probeKoboldCppConnection(input: ProbeInput): Promise<ProviderProbeResult> {
  try {
    const models = await listKoboldCppModels(input);
    return { success: true, modelCount: models.length };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function testKoboldCppChat(input: ProviderConnectionInput): Promise<TestChatResult> {
  const baseUrl = normalizeKoboldCppBaseUrl(input.baseUrl);
  if (!baseUrl) return { success: false, error: "Provider endpoint is required." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_CHAT_TIMEOUT_MS);
  const doFetch: typeof fetch = input.fetch ?? fetch;

  try {
    const response = await doFetch(`${baseUrl}/api/v1/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        prompt: "User: Hi\nAssistant:",
        max_length: 64,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return {
        success: false,
        error: `${response.status} ${response.statusText}${errorText ? `: ${errorText.slice(0, 200)}` : ""}`,
      };
    }

    const payload = (await response.json()) as { results?: Array<{ text?: string }> };
    const content = payload.results?.[0]?.text?.trim() ?? "";
    return { success: true, reply: content || "(empty response)" };
  } catch (error) {
    clearTimeout(timer);
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || /aborted/i.test(error.message))
    ) {
      return {
        success: false,
        error: `Timed out after ${Math.floor(TEST_CHAT_TIMEOUT_MS / 1000)}s.`,
      };
    }
    return { success: false, error: msg };
  }
}

export async function listKoboldCppModels(input: ListModelsInput): Promise<ProviderModelOption[]> {
  const baseUrl = normalizeKoboldCppBaseUrl(input.baseUrl);
  if (!baseUrl || !tryParseUrl(baseUrl)) {
    throw new Error(`Invalid provider endpoint: ${input.baseUrl}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);
  const doFetch: typeof fetch = input.fetch ?? fetch;

  let response: Response;
  try {
    response = await doFetch(`${baseUrl}/api/v1/model`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (error) {
    clearTimeout(timer);
    throw wrapProviderNetworkError(error, { operation: "KoboldCPP model list", timeoutMs: MODEL_LIST_TIMEOUT_MS });
  }

  if (!response.ok) {
    throw new Error(`KoboldCPP model list failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as { result?: string; model?: string; name?: string };
  const id = (payload.result ?? payload.model ?? payload.name ?? "koboldcpp-loaded-model").trim();
  return [{ id: id || "koboldcpp-loaded-model", label: id || "KoboldCPP loaded model" }];
}

export const koboldCppProtocol: ProtocolAdapter = {
  id: PROVIDER_TYPE.koboldCpp,
  capabilities: {
    nonStreamGeneration: true,
    abortSignal: true,
    streaming: true,
    prefill: false,
    logitBias: false,
    samplers: SAMPLER_SETS.koboldcpp_native,
    textCompletion: false,
    // LS-3c: KoboldCPP is NATIVE text completion — its own adapter builds the
    // flat prompt, so AUTO is a no-op here (no backend template, no seam
    // serialization). See ProviderCapabilityFlags.backendTemplate.
    backendTemplate: false,
  },
  resolveModel(profile, model, fetch?: ProviderFetch, format?: CompletionFormatHandoff) {
    const endpoint = (profile.endpoint || "").replace(/\/+$/, "") || "http://localhost:5001";
    return createKoboldCppModel({
      baseURL: endpoint,
      modelId: model ?? "koboldcpp",
      // LS-6b: the preset's manual Generation-format sequences render through
      // the shared seam (auto/absent → the default template = today's bytes).
      ...(format?.completionFormat?.kind === "manual" ? { template: format.completionFormat.template } : {}),
      ...(fetch ? { fetch } : {}),
    });
  },
  limitations: [
    "Uses KoboldCPP native /api/v1/generate endpoint (not OpenAI-compat).",
    "Chat messages are serialized into a flat text prompt.",
    "Tool calling is not supported.",
  ],
  probe: probeKoboldCppConnection,
  testChat: testKoboldCppChat,
  listModels: listKoboldCppModels,
  tokenize: tokenizeKoboldCpp,
};
