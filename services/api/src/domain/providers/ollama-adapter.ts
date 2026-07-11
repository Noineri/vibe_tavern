/**
 * Ollama native adapter — LanguageModelV3 wrapper.
 *
 * While Ollama supports OpenAI-compatible /v1/chat/completions, that adapter
 * silently drops sampler parameters (top_k, min_p, repeat_penalty, etc.).
 * This adapter uses Ollama's native /api/chat endpoint to pass ALL samplers.
 *
 * Endpoints:
 * - Generation:  POST /api/chat  (blocking, stream: false)
 * - Streaming:   POST /api/chat  (stream: true — NDJSON)
 * - Model list:  GET  /api/tags
 * - Abort:       n/a (handled by AbortSignal)
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
  PROBE_TIMEOUT_MS,
  MODEL_LIST_TIMEOUT_MS,
  TEST_CHAT_TIMEOUT_MS,
  wrapProviderNetworkError,
  type ProviderConnectionInput,
  type ProviderModelOption,
  type ProviderProbeResult,
  type TestChatResult,
} from "./provider-transport.js";
import { PROVIDER_TYPE, SAMPLER_SETS } from "@vibe-tavern/domain";
import type { ProtocolAdapter, ProbeInput, ListModelsInput } from "./protocol-types.js";

// ─── Types ───────────────────────────────────────────────────────────────

/** Ollama /api/chat request body. */
interface OllamaChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  options?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    min_p?: number;
    typical_p?: number;
    tfs_z?: number;
    repeat_penalty?: number;
    repeat_last_n?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    mirostat?: number;
    mirostat_tau?: number;
    mirostat_eta?: number;
    seed?: number;
    num_predict?: number;
    stop?: string[];
    num_ctx?: number;
  };
}

function makeUsage(
  promptEval = 0,
  evalCount = 0,
): LanguageModelV3Usage {
  return {
    inputTokens: { total: promptEval, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: evalCount, text: undefined, reasoning: undefined },
  };
}

function makeFinishReason(
  reason: LanguageModelV3FinishReason["unified"],
  raw?: string,
): LanguageModelV3FinishReason {
  return { unified: reason, raw: raw ?? reason };
}

interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

export interface OllamaAdapterOptions {
  /** Base URL (e.g. http://localhost:11434). */
  baseURL: string;
  /** Model name (e.g. "gemma3:4b"). */
  modelId: string;
}

// ─── Prompt conversion ───────────────────────────────────────────────────

/**
 * Convert AI SDK V3 prompt messages to Ollama's /api/chat format.
 *
 * Ollama accepts structured messages with role + content, which maps
 * cleanly from the V3 format.
 */
function convertPrompt(
  prompt: LanguageModelV3CallOptions["prompt"],
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];

  for (const message of prompt) {
    switch (message.role) {
      case "system": {
        // V3: system content is a plain string
        messages.push({ role: "system", content: message.content });
        break;
      }
      case "user": {
        const text = message.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("");
        messages.push({ role: "user", content: text });
        break;
      }
      case "assistant": {
        const text = message.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("");
        messages.push({ role: "assistant", content: text });
        break;
      }
      case "tool": {
        // Ollama supports tools, but we skip for now
        break;
      }
    }
  }

  return messages;
}

// ─── Sampler mapping ─────────────────────────────────────────────────────

function buildOllamaOptions(
  callOptions: LanguageModelV3CallOptions,
): OllamaChatRequest["options"] {
  const opts: NonNullable<OllamaChatRequest["options"]> = {};

  // Standard AI SDK parameters
  if (callOptions.temperature != null) opts.temperature = callOptions.temperature;
  if (callOptions.topP != null) opts.top_p = callOptions.topP;
  if (callOptions.topK != null) opts.top_k = callOptions.topK;
  if (callOptions.seed != null) opts.seed = callOptions.seed;
  if (callOptions.maxOutputTokens != null) opts.num_predict = callOptions.maxOutputTokens;
  if (callOptions.stopSequences?.length) opts.stop = callOptions.stopSequences;

  // Frequency/presence penalty (AI SDK native)
  // These map to Ollama's native options
  const freqPen = callOptions.frequencyPenalty;
  const presPen = callOptions.presencePenalty;
  if (freqPen != null) opts.frequency_penalty = freqPen;
  if (presPen != null) opts.presence_penalty = presPen;

  // Provider-specific options via providerOptions.ollama
  const ollamaOpts = (callOptions.providerOptions as Record<string, Record<string, unknown>> | undefined)?.ollama;
  if (ollamaOpts) {
    if (ollamaOpts.min_p != null) opts.min_p = ollamaOpts.min_p as number;
    if (ollamaOpts.typical_p != null) opts.typical_p = ollamaOpts.typical_p as number;
    if (ollamaOpts.tfs_z != null) opts.tfs_z = ollamaOpts.tfs_z as number;
    if (ollamaOpts.repeat_penalty != null) opts.repeat_penalty = ollamaOpts.repeat_penalty as number;
    if (ollamaOpts.repeat_last_n != null) opts.repeat_last_n = ollamaOpts.repeat_last_n as number;
    if (ollamaOpts.mirostat != null) opts.mirostat = ollamaOpts.mirostat as number;
    if (ollamaOpts.mirostat_tau != null) opts.mirostat_tau = ollamaOpts.mirostat_tau as number;
    if (ollamaOpts.mirostat_eta != null) opts.mirostat_eta = ollamaOpts.mirostat_eta as number;
    if (ollamaOpts.num_ctx != null) opts.num_ctx = ollamaOpts.num_ctx as number;
    // Allow overriding anything from providerOptions
    if (ollamaOpts.top_k != null) opts.top_k = ollamaOpts.top_k as number;
    if (ollamaOpts.top_p != null) opts.top_p = ollamaOpts.top_p as number;
    if (ollamaOpts.temperature != null) opts.temperature = ollamaOpts.temperature as number;
    if (ollamaOpts.frequency_penalty != null) opts.frequency_penalty = ollamaOpts.frequency_penalty as number;
    if (ollamaOpts.presence_penalty != null) opts.presence_penalty = ollamaOpts.presence_penalty as number;
  }

  return Object.keys(opts).length > 0 ? opts : undefined;
}

// ─── Adapter ─────────────────────────────────────────────────────────────

/**
 * Create a LanguageModelV3 adapter for Ollama using native /api/chat.
 */
export function createOllamaModel(options: OllamaAdapterOptions): LanguageModelV3 {
  const { baseURL, modelId } = options;
  const base = baseURL.replace(/\/+$/, "");

  return {
    specificationVersion: "v3",
    provider: "ollama",
    modelId,
    supportedUrls: {},

    async doGenerate(callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      const messages = convertPrompt(callOptions.prompt);
      const ollamaOptions = buildOllamaOptions(callOptions);

      const body: OllamaChatRequest = {
        model: modelId,
        messages,
        stream: false,
        options: ollamaOptions,
      };

      const response = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: callOptions.abortSignal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Ollama generate error (${response.status}): ${text}`);
      }

      const data = (await response.json()) as OllamaChatResponse;
      const generatedText = data.message?.content ?? "";

      const content: LanguageModelV3Text[] = generatedText
        ? [{ type: "text", text: generatedText }]
        : [];

      const finishReason = data.done_reason === "length"
        ? makeFinishReason("length", data.done_reason)
        : makeFinishReason("stop", data.done_reason);

      return {
        content,
        finishReason,
        usage: makeUsage(data.prompt_eval_count, data.eval_count),
        warnings: [],
        request: { body },
      };
    },

    async doStream(callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      const messages = convertPrompt(callOptions.prompt);
      const ollamaOptions = buildOllamaOptions(callOptions);

      const body: OllamaChatRequest = {
        model: modelId,
        messages,
        stream: true,
        options: ollamaOptions,
      };

      const response = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: callOptions.abortSignal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Ollama stream error (${response.status}): ${text}`);
      }

      if (!response.body) {
        throw new Error("Ollama stream: no response body");
      }

      // Ollama streaming is NDJSON: one JSON object per line.
      // Each chunk: {"message":{"role":"assistant","content":"token"},"done":false}
      // Final chunk: {"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":N,"eval_count":N}
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async pull(controller) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                controller.enqueue({
                  type: "finish",
                  finishReason: makeFinishReason("stop"),
                  usage: makeUsage(),
                });
                controller.close();
                return;
              }

              buffer += decoder.decode(value, { stream: true });
              // NDJSON: split by newlines, each line is a complete JSON object
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                let chunk: OllamaChatResponse;
                try {
                  chunk = JSON.parse(trimmed);
                } catch {
                  continue;
                }

                if (chunk.done) {
                  // Final chunk — emit finish with usage stats
                  const finishReason = chunk.done_reason === "length"
                    ? makeFinishReason("length", chunk.done_reason)
                    : makeFinishReason("stop", chunk.done_reason);

                  controller.enqueue({
                    type: "finish",
                    finishReason,
                    usage: makeUsage(chunk.prompt_eval_count, chunk.eval_count),
                  });
                  controller.close();
                  return;
                }

                // Token chunk
                const token = chunk.message?.content;
                if (token) {
                  controller.enqueue({
                    type: "text-delta",
                    id: "0",
                    delta: token,
                  });
                }
              }
            }
          } catch (err) {
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

// ─── Model listing ───────────────────────────────────────────────────────

export interface OllamaTagsResponse {
  models: Array<{
    name: string;
    model: string;
    size: number;
    details?: {
      format?: string;
      family?: string;
      parameter_size?: string;
      quantization_level?: string;
    };
    capabilities?: string[];
  }>;
}

/**
 * Fetch available models from Ollama.
 * Returns model names (e.g. ["gemma3:4b", "qwen3.5:9b"]).
 */
export async function fetchOllamaModels(baseURL: string): Promise<string[]> {
  const base = baseURL.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/tags`);
  if (!res.ok) throw new Error(`Ollama model list failed (${res.status})`);
  const data = (await res.json()) as OllamaTagsResponse;
  // Filter out embedding-only models
  return data.models
    .filter((m) => !m.capabilities?.includes("embedding") || m.capabilities?.includes("completion"))
    .map((m) => m.name);
}

// ─── Registry-facing operations (probe / testChat / listModels) ───────────
// Moved from protocol-registry.ts; colocated with the native SDK wrapper so
// the full Ollama protocol description lives in one file.

export async function probeOllamaConnection(input: ProbeInput): Promise<ProviderProbeResult> {
  try {
    const models = await listOllamaModels(input);
    return { success: true, modelCount: models.length };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function testOllamaChat(input: ProviderConnectionInput): Promise<TestChatResult> {
  const baseUrl = (input.baseUrl || "").replace(/\/+$/, "").replace(/\/v1$/, "");
  if (!baseUrl) return { success: false, error: "Provider endpoint is required." };
  if (!input.model) return { success: false, error: "Model is required." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_CHAT_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
        options: { num_predict: 64, temperature: 0.7 },
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

    const payload = (await response.json()) as { message?: { content?: string } };
    const content = payload.message?.content?.trim() ?? "";
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

export async function listOllamaModels(input: ListModelsInput): Promise<ProviderModelOption[]> {
  const baseUrl = (input.baseUrl || "").replace(/\/+$/, "").replace(/\/v1$/, "");
  const url = `${baseUrl}/api/tags`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (error) {
    clearTimeout(timer);
    throw wrapProviderNetworkError(error, { operation: "Ollama model list", timeoutMs: MODEL_LIST_TIMEOUT_MS });
  }

  if (!response.ok) {
    throw new Error(`Ollama model list failed: ${response.status} ${response.statusText}`);
  }

  interface OllamaModel { name: string; model?: string; capabilities?: string[]; }
  const payload = (await response.json()) as { models?: OllamaModel[] };
  const records = Array.isArray(payload.models) ? payload.models : [];
  const baseOptions = records
    .filter((r) => !r.capabilities?.includes("embedding") || r.capabilities?.includes("completion"))
    .map((r) => {
      const id = (r.name ?? r.model ?? "").trim();
      return id ? { id, label: id } : null;
    })
    .filter((r): r is ProviderModelOption => r !== null);

  const enriched = await Promise.all(
    baseOptions.map(async (option) => ({
      ...option,
      ...(await fetchOllamaModelMetadata(baseUrl, option.id)),
    })),
  );

  return enriched.sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchOllamaModelMetadata(
  baseUrl: string,
  model: string,
): Promise<Partial<ProviderModelOption>> {
  try {
    const response = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return {};

    const payload = (await response.json()) as {
      capabilities?: string[];
      details?: {
        family?: string;
        families?: string[];
        format?: string;
        parameter_size?: string;
        quantization_level?: string;
      };
      model_info?: Record<string, unknown>;
      parameters?: string;
    };

    const metadata: Partial<ProviderModelOption> = {};
    const contextLength = extractOllamaContextLength(payload);
    if (contextLength) metadata.contextLength = contextLength;

    const details = payload.details;
    const detailParts = [
      details?.parameter_size,
      details?.quantization_level,
      details?.family,
      details?.format,
    ].filter(Boolean);
    if (detailParts.length > 0) metadata.description = detailParts.join(" · ");
    if (payload.capabilities) {
      metadata.capabilities = {
        vision: payload.capabilities.includes("vision"),
      };
    }

    return metadata;
  } catch {
    return {};
  }
}

function extractOllamaContextLength(payload: {
  model_info?: Record<string, unknown>;
  parameters?: string;
}): number | undefined {
  const info = payload.model_info ?? {};
  for (const [key, value] of Object.entries(info)) {
    if (!/(^|\.)context_length$/.test(key)) continue;
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const numCtxMatch = payload.parameters?.match(/(?:^|\n)\s*num_ctx\s+(\d+)/i);
  if (numCtxMatch?.[1]) {
    const parsed = Number(numCtxMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  return undefined;
}

export const ollamaProtocol: ProtocolAdapter = {
  id: PROVIDER_TYPE.ollama,
  capabilities: {
    nonStreamGeneration: true,
    abortSignal: true,
    streaming: true,
    prefill: true,
    logitBias: true,
    samplers: SAMPLER_SETS.openai_local,
    textCompletion: false,
  },
  resolveModel(profile, model) {
    const endpoint = (profile.endpoint || "").replace(/\/+$/, "") || "http://localhost:11434";
    return createOllamaModel({ baseURL: endpoint, modelId: model });
  },
  limitations: [
    "Uses Ollama native /api/chat endpoint for full sampler support.",
    "Model list uses Ollama's native /api/tags endpoint.",
  ],
  probe: probeOllamaConnection,
  testChat: testOllamaChat,
  listModels: listOllamaModels,
};
