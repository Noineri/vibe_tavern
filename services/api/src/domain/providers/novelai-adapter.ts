/**
 * NovelAI native adapter — thin LanguageModelV3 wrapper.
 *
 * fork #1 of koboldcpp-adapter.ts (fork discipline, AGENTS.md §3; the source
 * header carries the reciprocal `forks: 1` count).
 *
 * Correspondence summary vs the fork source — KEPT:
 * - The whole LanguageModelV3 wrapper shape: model factory, doGenerate /
 *   doStream, the LS-6d protocol sequencing (stream-start, text-start before
 *   the first delta, text-end before finish), SSE line reassembly (chunk
 *   splitting, keep-alive comments, buffer flush at stream end), and the
 *   `token`-field event mapping.
 * - The shared prompt serialization seam (completion-prompt.ts, LS-6b): AUTO
 *   renders the default role-prefixed template; the preset's manual
 *   Generation-format template threads through resolveModel identically.
 * - The LS-9 implied-stops rule: AUTO unions the role markers into the stop
 *   set; MANUAL injects nothing.
 * - Registry-facing operations (probe / testChat / listModels) and the
 *   protocol object shape.
 *
 * DIFFERS (the native NovelAI wire — NOVELAI_PROVIDER_PLAN NAI-3a):
 * - Wire: POST /ai/generate (blocking, response `{ output }`) and POST
 *   /ai/generate-stream (SSE; each event's `data` is JSON, the text piece in
 *   `token` — SillyTavern nai-settings.js:741-766); body `{ input, model,
 *   parameters }`.
 * - Auth: `Authorization: Bearer <apiKey>` on every call (KoboldCPP is local).
 * - `parameters` always carries use_string / max_length / min_length / prefix
 *   — the mandated fields are re-asserted AFTER the providerOptions spread so
 *   nothing can override or clamp them (owner ruling: the call's
 *   maxOutputTokens reaches max_length unchanged).
 * - Erato only: `<|startoftext|><|reserved_special_token81|>` is prepended to
 *   `input` (SillyTavern nai-settings.js:567-569).
 * - Client-side stop sequences: the native API accepts stop sequences only as
 *   TOKEN-ID arrays from the model's tokenizer and VT has no nerdstash /
 *   Llama-3 tokenizer, so `stop_sequences` is NEVER sent. The union of the
 *   user's stops and the template's implied stops is matched against the
 *   accumulated text here: blocking — the output is cut before the first
 *   match; streaming — the last (longest stop - 1) chars are held back until
 *   no stop can complete, and on a match the stream finishes and the request
 *   is aborted.
 * - No `tokenize` member (no public tokenize endpoint) and no dead
 *   `signal` option (the call's abortSignal is the real seam).
 * - Model list: static kayra-v1 / llama-3-erato-v1 (spec
 *   text.LMGenerateRequest.model); `contextLength` = perks.contextTokens from
 *   GET image.novelai.net/user/subscription when the key is valid, omitted
 *   when that call fails — never invented.
 * - Probe: GET image.novelai.net/user/subscription (SillyTavern
 *   novelai.js:143); 200 → ok, 401 → rejected key. Does NOT delegate to
 *   listModels (the static list succeeds without a key — only the probe
 *   distinguishes a rejected token).
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
  PROBE_TIMEOUT_MS,
  TEST_CHAT_TIMEOUT_MS,
  type ProviderConnectionInput,
  type ProviderModelOption,
  type ProviderProbeResult,
  type TestChatResult,
} from "./provider-transport.js";
import { interpretProbeResponse } from "./probe-helpers.js";
import { PROVIDER_TYPE, SAMPLER_SETS } from "@vibe-tavern/domain";
import type { ProtocolAdapter, ProbeInput, ListModelsInput, CompletionFormatHandoff } from "./protocol-types.js";
import { serializeCompletionPrompt, DEFAULT_COMPLETION_TEMPLATE, templateStopMarkers, unionStopSequences, type CompletionFormatTemplate } from "./completion-prompt.js";
import type { ProviderFetch } from "./provider-fetch-factory.js";
import { readProviderErrorBody } from "../../infrastructure/ai/provider-error-body.js";

// ─── Constants ───────────────────────────────────────────────────────────

/** Canonical NovelAI text host (the NAI-3c preset pins the profile endpoint
 *  here; used as the default when a profile carries no endpoint). */
const NOVELAI_TEXT_BASE_URL = "https://text.novelai.net";

/** The persistent-token check and subscription info live on the IMAGE host
 *  (the APIs are split per the spec; SillyTavern novelai.js:143) — same token,
 *  fixed URL, independent of the profile's text endpoint. */
const NOVELAI_SUBSCRIPTION_URL = "https://image.novelai.net/user/subscription";

/** Static native model ids — spec `text.LMGenerateRequest.model`: «currently
 *  only kayra-v1 and llama-3-erato-v1 are available. … Trial users may only
 *  use kayra-v1» (research Finding 2). Kayra is the fallback model for the
 *  same reason (trial-eligible). */
const KAYRA_MODEL_ID = "kayra-v1";
const ERATO_MODEL_ID = "llama-3-erato-v1";

const NOVELAI_NATIVE_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: KAYRA_MODEL_ID, label: "Kayra" },
  { id: ERATO_MODEL_ID, label: "Erato" },
];

/** Erato requires its BOS-style prefix on `input` (SillyTavern
 *  nai-settings.js:567-569); Kayra takes the bare prompt. */
const ERATO_INPUT_PREFIX = "<|startoftext|><|reserved_special_token81|>";

function novelAiInput(modelId: string, prompt: string): string {
  return modelId === ERATO_MODEL_ID ? `${ERATO_INPUT_PREFIX}${prompt}` : prompt;
}

// ─── Types ───────────────────────────────────────────────────────────────

/** NovelAI native generation request body (`{ input, model, parameters }`). */
interface NovelAiGenerateRequest {
  input: string;
  model: string;
  parameters: NovelAiGenerateParameters;
}

/**
 * `parameters` object. The always-carried fields (use_string, max_length,
 * min_length, prefix) and temperature are set by the adapter; everything else
 * arrives through `callOptions.providerOptions.novelai` in native parameter
 * names (sampler-mapper, NAI-3b).
 */
interface NovelAiGenerateParameters {
  use_string: boolean;
  max_length: number;
  min_length: number;
  prefix: string;
  temperature?: number;
}

/** Blocking response (spec `text.LMGenerationResponse`). */
interface NovelAiGenerateResponse {
  output?: string;
}

/** Subscription payload (GET image.novelai.net/user/subscription) — only the
 *  field the model list reads: the tier's context size. */
interface NovelAiSubscriptionResponse {
  tier?: string;
  active?: boolean;
  perks?: { contextTokens?: number };
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

export interface NovelAiAdapterOptions {
  /** Base URL (e.g. https://text.novelai.net). */
  baseURL: string;
  /** NovelAI persistent API token (sent as the Bearer credential). */
  apiKey: string;
  /** Model ID (kayra-v1 / llama-3-erato-v1). */
  modelId: string;
  /** Optional proxy-aware fetch honoring the profile's proxy policy. */
  fetch?: ProviderFetch;
  /** The preset's manual Generation-format template, threaded through the
   *  same handoff the KoboldCPP adapter uses (LS-6b). Absent (auto) → the
   *  default role-prefixed serialization. */
  template?: CompletionFormatTemplate;
}

// ─── Prompt serialization (fork-kept) ────────────────────────────────────

/**
 * Convert AI SDK model prompt messages into a single text prompt. The native
 * API takes a flat `input` string, not structured messages — the SHARED
 * serialization seam (completion-prompt.ts, LS-6b) renders it, exactly as the
 * KoboldCPP fork source does.
 */
function serializePrompt(
  prompt: LanguageModelV3CallOptions["prompt"],
  template?: CompletionFormatTemplate,
): string {
  return serializeCompletionPrompt(prompt, { template });
}

/**
 * LS-9 implied stops for this model instance — the fork-kept rule. In AUTO the
 * native serializer owns the role markers, so they join the client-side stop
 * set; a MANUAL template means the user authors the format and NOTHING is
 * injected.
 */
function impliedStopsFor(template: CompletionFormatTemplate | undefined): string[] {
  return template ? [] : templateStopMarkers(DEFAULT_COMPLETION_TEMPLATE);
}

// ─── Client-side stop sequences (NAI-3a design decision) ─────────────────

/**
 * The stop set for client-side matching: the user's stop sequences (ride
 * first) unioned with the template's implied markers — the same union
 * KoboldCPP SENDS as `stop_sequence`, applied HERE against the accumulated
 * text instead, because the native API takes stop sequences only as token-id
 * arrays from the model's own tokenizer (community KB «Using the API») and VT
 * has no nerdstash / Llama-3 tokenizer.
 */
function clientSideStops(
  callOptions: LanguageModelV3CallOptions,
  impliedStops: string[],
): string[] {
  return unionStopSequences(callOptions.stopSequences, impliedStops) ?? [];
}

/** Earliest index at which any stop string occurs in `text` (-1 = none). */
function findFirstStopIndex(text: string, stops: string[]): number {
  let earliest = -1;
  for (const stop of stops) {
    if (!stop) continue;
    const index = text.indexOf(stop);
    if (index !== -1 && (earliest === -1 || index < earliest)) earliest = index;
  }
  return earliest;
}

/** Cut the blocking output before the first stop match. */
function cutAtFirstStop(text: string, stops: string[]): string {
  if (stops.length === 0) return text;
  const cut = findFirstStopIndex(text, stops);
  return cut === -1 ? text : text.slice(0, cut);
}

// ─── Adapter ─────────────────────────────────────────────────────────────

/**
 * Create a LanguageModelV3 adapter for the NovelAI native text API.
 */
export function createNovelAiModel(options: NovelAiAdapterOptions): LanguageModelV3 {
  const { baseURL, apiKey, modelId, fetch: customFetch, template } = options;
  const base = baseURL.replace(/\/+$/, "");
  const doFetch: typeof fetch = customFetch ?? fetch;
  const impliedStops = impliedStopsFor(template);
  const authHeaders: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  return {
    specificationVersion: "v3",
    provider: "novelai",
    modelId,
    supportedUrls: {},

    async doGenerate(callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      const prompt = serializePrompt(callOptions.prompt, template);
      const stops = clientSideStops(callOptions, impliedStops);

      const body: NovelAiGenerateRequest = {
        input: novelAiInput(modelId, prompt),
        model: modelId,
        parameters: {
          temperature: callOptions.temperature ?? 1.0,
          ...(callOptions.providerOptions?.novelai ?? {}),
          // Mandated fields go AFTER the spread: parameters ALWAYS carry them,
          // and the call's maxOutputTokens reaches max_length unchanged —
          // never clamped (owner ruling), never overridden by providerOptions.
          // Unset-value fallback is 150, NOT the fork's 512: 150 is the value
          // every NovelAI tier accepts (spec `input` description; lowest tiers
          // cap above it) — a keyless-config first request must not 4xx on a
          // tier limit before NAI-3c's preset default even applies (owner
          // 2026-10-06).
          use_string: true,
          max_length: callOptions.maxOutputTokens ?? 150,
          min_length: 1,
          prefix: "vanilla",
        },
      };

      const response = await doFetch(`${base}/ai/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(body),
        signal: callOptions.abortSignal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`NovelAI generate error (${response.status}): ${text}`);
      }

      const data = (await response.json()) as NovelAiGenerateResponse;
      const generatedText = cutAtFirstStop(typeof data.output === "string" ? data.output : "", stops);

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
      const stops = clientSideStops(callOptions, impliedStops);
      const maxStopLength = stops.reduce((max, stop) => Math.max(max, stop.length), 0);

      const body: NovelAiGenerateRequest = {
        input: novelAiInput(modelId, prompt),
        model: modelId,
        parameters: {
          temperature: callOptions.temperature ?? 1.0,
          ...(callOptions.providerOptions?.novelai ?? {}),
          use_string: true,
          // 150 = every-tier-safe unset fallback (see the blocking path above).
          max_length: callOptions.maxOutputTokens ?? 150,
          min_length: 1,
          prefix: "vanilla",
        },
      };

      // One abort controller serves both the caller's signal and the
      // client-side stop: a stop match must abort the SSE request itself,
      // not just close the outgoing stream.
      const requestAbort = new AbortController();
      if (callOptions.abortSignal) {
        if (callOptions.abortSignal.aborted) requestAbort.abort();
        else callOptions.abortSignal.addEventListener("abort", () => requestAbort.abort(), { once: true });
      }

      const response = await doFetch(`${base}/ai/generate-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(body),
        signal: requestAbort.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`NovelAI stream error (${response.status}): ${text}`);
      }

      if (!response.body) {
        throw new Error("NovelAI stream: no response body");
      }

      // Parse the SSE stream and convert to AI SDK V3 stream parts. The
      // fork-kept LS-6d protocol sequencing applies (stream-start first, a
      // text-start before the first delta, a matching text-end before
      // finish). Client-side stops add one twist: while stops are active the
      // last (maxStopLength - 1) received chars are held back — a stop string
      // split across token boundaries must still be caught before it is
      // forwarded.
      const reader = response.textStream().getReader();
      let buffer = "";
      let streamStarted = false;
      let textOpened = false;
      let received = "";
      let emittedLen = 0;
      let stoppedEarly = false;

      const emitDelta = (
        controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
        delta: string,
      ) => {
        if (!delta) return;
        if (!textOpened) {
          textOpened = true;
          controller.enqueue({ type: "text-start", id: "0" });
        }
        controller.enqueue({ type: "text-delta", id: "0", delta });
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

      /** Flush the held-back tail at the natural end of the stream — no
       *  future token can complete a stop anymore. */
      const flushHeldBackTail = (
        controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
      ) => {
        if (emittedLen < received.length) {
          emitDelta(controller, received.slice(emittedLen));
          emittedLen = received.length;
        }
      };

      /** Feed one token through the client-side stop filter. Returns true
       *  when a stop matched: the cut delta was emitted, the stream was
       *  finished, and the request was aborted. */
      const feedToken = (
        controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
        token: string,
      ): boolean => {
        received += token;
        const cut = findFirstStopIndex(received, stops);
        if (cut !== -1) {
          emitDelta(controller, received.slice(emittedLen, cut));
          stoppedEarly = true;
          closeTextAndFinish(controller);
          requestAbort.abort();
          return true;
        }
        const safeEnd = stops.length > 0
          ? Math.max(0, received.length - (maxStopLength - 1))
          : received.length;
        emitDelta(controller, received.slice(emittedLen, safeEnd));
        emittedLen = safeEnd;
        return false;
      };

      /** Handle one parsed SSE event; true = the stream ended (stop match or
       *  done event — the caller must return from pull). */
      const handleEvent = (
        controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
        event: Record<string, unknown>,
      ): boolean => {
        // Token event: { "token": " word" }
        if ("token" in event && typeof event.token === "string") {
          return feedToken(controller, event.token);
        }
        // Done event: { "text": "...", "done": true } — everything is
        // streamed already; flush what is held back and finish.
        if ("done" in event && event.done) {
          flushHeldBackTail(controller);
          closeTextAndFinish(controller);
          return true;
        }
        return false;
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
                  if (event && handleEvent(controller, event)) return;
                }
                flushHeldBackTail(controller);
                closeTextAndFinish(controller);
                return;
              }

              buffer += value;
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(":")) continue; // skip empty/comments

                const event = parseSSEEvent(trimmed);
                if (!event) continue;

                if (handleEvent(controller, event)) return;
              }
            }
          } catch (err) {
            // A client-side stop already finished and closed this stream;
            // the abort of the underlying reader lands here and is expected.
            if (stoppedEarly) return;
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

// ─── SSE parsing (fork-kept verbatim) ────────────────────────────────────

function parseSSEEvent(line: string): Record<string, unknown> | null {
  // NovelAI SSE format: "data: {...}" — same envelope as KoboldCPP.
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

// ─── Subscription (context size source) ──────────────────────────────────

/**
 * Fetch the tier's context size (perks.contextTokens) with the profile's key.
 * Any failure (missing key, 401, network, malformed payload) → null: the
 * static model list ships without `contextLength` — a number is never
 * invented (plan NAI-3a).
 */
async function fetchNovelAiContextTokens(doFetch: typeof fetch, apiKey: string): Promise<number | null> {
  if (!apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);
  try {
    const response = await doFetch(NOVELAI_SUBSCRIPTION_URL, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as NovelAiSubscriptionResponse;
    const tokens = payload?.perks?.contextTokens;
    return typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? tokens : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Registry-facing operations (probe / testChat / listModels) ───────────

export async function probeNovelAiConnection(input: ProbeInput): Promise<ProviderProbeResult> {
  // Key check (SillyTavern novelai.js:143): GET the subscription endpoint on
  // the image host — 200 → ok, 401 → rejected key.
  const doFetch: typeof fetch = input.fetch ?? fetch;
  try {
    const response = await doFetch(NOVELAI_SUBSCRIPTION_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // modelCount = the static catalog size (the list itself needs no key).
    return await interpretProbeResponse(response, () => NOVELAI_NATIVE_MODELS.length);
  } catch (error) {
    return {
      success: false,
      error: `Network error during probe: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function testNovelAiChat(input: ProviderConnectionInput): Promise<TestChatResult> {
  const base = (input.baseUrl || "").replace(/\/+$/, "") || NOVELAI_TEXT_BASE_URL;
  const modelId = input.model || KAYRA_MODEL_ID;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_CHAT_TIMEOUT_MS);
  const doFetch: typeof fetch = input.fetch ?? fetch;

  try {
    const response = await doFetch(`${base}/ai/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
      },
      body: JSON.stringify({
        input: novelAiInput(modelId, "User: Hi\nAssistant:"),
        model: modelId,
        parameters: {
          temperature: 1.0,
          use_string: true,
          max_length: 64,
          min_length: 1,
          prefix: "vanilla",
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      const errorText = await readProviderErrorBody(response);
      return {
        success: false,
        error: `${response.status} ${response.statusText}${errorText ? `: ${errorText}` : ""}`,
      };
    }

    const payload = (await response.json()) as { output?: string };
    const content = (payload.output ?? "").trim();
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

export async function listNovelAiModels(input: ListModelsInput): Promise<ProviderModelOption[]> {
  // Static catalog — the native API exposes no model-list endpoint; the ids
  // come from the spec. contextLength rides along only when the subscription
  // call succeeds with the profile's key.
  const doFetch: typeof fetch = input.fetch ?? fetch;
  const contextTokens = await fetchNovelAiContextTokens(doFetch, input.apiKey);
  return NOVELAI_NATIVE_MODELS.map((model) => ({
    id: model.id,
    label: model.label,
    ...(contextTokens != null ? { contextLength: contextTokens } : {}),
  }));
}

export const novelaiProtocol: ProtocolAdapter = {
  id: PROVIDER_TYPE.novelai,
  capabilities: {
    nonStreamGeneration: true,
    abortSignal: true,
    streaming: true,
    prefill: false,
    logitBias: false,
    samplers: SAMPLER_SETS.novelai_native,
    textCompletion: false,
    // Native text completion like KoboldCPP (LS-3c): this adapter builds the
    // flat prompt itself — AUTO is a no-op here (no backend template, the
    // seam serialization lives in the adapter).
    backendTemplate: false,
  },
  resolveModel(profile, model, fetch?: ProviderFetch, format?: CompletionFormatHandoff) {
    const endpoint = (profile.endpoint || "").replace(/\/+$/, "") || NOVELAI_TEXT_BASE_URL;
    return createNovelAiModel({
      baseURL: endpoint,
      apiKey: profile.apiKey ?? "",
      // The model id is load-bearing on this wire (unlike KoboldCPP's loaded
      // model) — an empty id would 400; Kayra is the trial-eligible default.
      modelId: model || KAYRA_MODEL_ID,
      ...(format?.completionFormat?.kind === "manual" ? { template: format.completionFormat.template } : {}),
      ...(fetch ? { fetch } : {}),
    });
  },
  limitations: [
    "Uses NovelAI's native /ai/generate endpoint (not OpenAI-compat).",
    "Chat messages are serialized into a flat text prompt.",
    "Tool calling is not supported.",
    "Only the Kayra and Erato models are available on the native API.",
  ],
  probe: probeNovelAiConnection,
  testChat: testNovelAiChat,
  listModels: listNovelAiModels,
  // No `tokenize` member: the native API exposes no public tokenize endpoint
  // (token counting stays on the local tokenizer ladder).
};
