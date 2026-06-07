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
}

// ─── Prompt serialization ────────────────────────────────────────────────

/**
 * Convert AI SDK V3 prompt messages into a single text prompt for KoboldCPP.
 *
 * KoboldCPP's native API takes a flat `prompt` string, not structured messages.
 * We serialize the messages into a chat-like format:
 *
 *   System: You are helpful.
 *   User: Hello
 *   Assistant: Hi there
 *   Assistant: [prefill if present]
 */
function serializePrompt(prompt: LanguageModelV3CallOptions["prompt"]): string {
  const parts: string[] = [];

  for (const message of prompt) {
    switch (message.role) {
      case "system": {
        // V3: system content is a plain string
        parts.push(`System: ${message.content}\n`);
        break;
      }
      case "user": {
        for (const c of message.content) {
          if (c.type === "text") parts.push(`User: ${c.text}\n`);
        }
        break;
      }
      case "assistant": {
        for (const c of message.content) {
          if (c.type === "text") parts.push(`Assistant: ${c.text}\n`);
        }
        break;
      }
      case "tool": {
        // KoboldCPP doesn't support tools — skip
        break;
      }
    }
  }

  // End with Assistant: prefix to prompt continuation
  parts.push("Assistant:");
  return parts.join("");
}

// ─── Adapter ─────────────────────────────────────────────────────────────

/**
 * Create a LanguageModelV3 adapter for KoboldCPP.
 */
export function createKoboldCppModel(options: KoboldCppAdapterOptions): LanguageModelV3 {
  const { baseURL, modelId } = options;
  const base = baseURL.replace(/\/+$/, "");

  return {
    specificationVersion: "v3",
    provider: "koboldcpp",
    modelId,
    supportedUrls: {},

    async doGenerate(callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      const prompt = serializePrompt(callOptions.prompt);

      const body: KoboldGenerateRequest = {
        prompt,
        max_length: callOptions.maxOutputTokens ?? 512,
        temperature: callOptions.temperature ?? 1.0,
        top_p: callOptions.topP,
        top_k: callOptions.topK,
        stop_sequence: callOptions.stopSequences,
        seed: callOptions.seed,
        // Pass through providerOptions as KoboldCPP native sampler params
        ...(callOptions.providerOptions?.koboldcpp ?? {}),
      };

      const response = await fetch(`${base}/api/v1/generate`, {
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
      const prompt = serializePrompt(callOptions.prompt);

      const body: KoboldGenerateRequest = {
        prompt,
        max_length: callOptions.maxOutputTokens ?? 512,
        temperature: callOptions.temperature ?? 1.0,
        top_p: callOptions.topP,
        top_k: callOptions.topK,
        stop_sequence: callOptions.stopSequences,
        seed: callOptions.seed,
        ...(callOptions.providerOptions?.koboldcpp ?? {}),
      };

      const response = await fetch(`${base}/api/extra/generate/stream`, {
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

      // Parse SSE stream from KoboldCPP and convert to AI SDK V3 stream parts
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async pull(controller) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                // Flush remaining buffer
                if (buffer.trim()) {
                  const event = parseSSEEvent(buffer);
                  if (event) {
                    const parts = mapSSEEventToStreamParts(event);
                    for (const part of parts) controller.enqueue(part);
                  }
                }
                // Emit finish
                controller.enqueue({
                  type: "finish",
                  finishReason: makeFinishReason("stop"),
                  usage: makeUsage(),
                });
                controller.close();
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

                const parts = mapSSEEventToStreamParts(event);
                for (const part of parts) controller.enqueue(part);

                // Check for done event
                if ("done" in event && event.done) {
                  controller.enqueue({
                    type: "finish",
                    finishReason: makeFinishReason("stop"),
                    usage: makeUsage(),
                  });
                  controller.close();
                  return;
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

// ─── Model listing ───────────────────────────────────────────────────────

export interface KoboldModelInfo {
  result: string;
}

/**
 * Fetch the currently loaded model name from KoboldCPP.
 */
export async function fetchKoboldModel(baseURL: string): Promise<string> {
  const base = baseURL.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/v1/model`);
  if (!res.ok) throw new Error(`KoboldCPP model fetch failed (${res.status})`);
  const data = (await res.json()) as KoboldModelInfo;
  return data.result;
}
