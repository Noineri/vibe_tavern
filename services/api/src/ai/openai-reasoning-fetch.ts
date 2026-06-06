/**
 * Custom fetch wrapper for OpenAI-compatible Chat Completions that intercepts
 * SSE streaming responses and rewrites chunks to expose `reasoning_content`
 * from the `delta` object.
 *
 * ## The Problem
 *
 * `@ai-sdk/openai`'s `OpenAIChatLanguageModel.doStream()` parses SSE chunks
 * with a Zod schema (`openaiChatChunkSchema`) that does NOT include
 * `delta.reasoning_content`. This field — used by DeepSeek R1, OpenRouter
 * thinking models, and other OpenAI-compatible providers for reasoning tokens
 * — is silently stripped by Zod's `.parse()`.
 *
 * ## The Fix
 *
 * This fetch wrapper intercepts the SSE response from `/chat/completions`
 * and rewrites each chunk's JSON so that `delta.reasoning_content` is moved
 * into a synthetic `content` field. The wrapper then injects a **marker
 * event** before the real content to signal the reasoning boundary:
 *
 * ```
 * data: {"choices":[{"delta":{"content":"[REASONING_START]"}}]}
 * data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}
 *         → rewritten to {"choices":[{"delta":{"content":"thinking..."}}]}
 * data: {"choices":[{"delta":{"reasoning_content":null,"content":"Hello"}}]}
 *         → rewritten as-is (content comes through normally)
 * ```
 *
 * This is **transparent** to the AI SDK — it just sees text-delta events
 * for both reasoning and content. Our `createMappedStream()` in the executor
 * can then detect the marker and split them appropriately.
 *
 * ## Usage
 *
 * ```ts
 * const provider = createOpenAI({
 *   ...config,
 *   fetch: createReasoningAwareFetch({ fetch: originalFetch }),
 * });
 * ```
 */

// ─── Marker protocol ───────────────────────────────────────────────────

import { log } from "@vibe-tavern/domain";

/**
 * Special text that marks the beginning of reasoning content in the stream.
 * When the wrapper sees `reasoning_content` in a delta, it emits this marker
 * first, then streams the reasoning text as regular `content`.
 *
 * When `reasoning_content` ends and real `content` begins, the wrapper emits
 * `[REASONING_END]` to signal the transition.
 */
export const REASONING_START_MARKER = "\x02REASONING_START\x03";
export const REASONING_END_MARKER = "\x02REASONING_END\x03";

// ─── SSE line parser ───────────────────────────────────────────────────

/**
 * Process a single SSE line. Returns one or more rewritten lines.
 * Each element is a complete SSE line ("data: {...}" or other SSE line).
 */
function rewriteChunkLine(line: string, state: { inReasoning: boolean; allDeltaKeys: Set<string>; chunkCount: number }): string[] {
  // Only process data: lines
  if (!line.startsWith("data: ")) return [line];
  const payload = line.slice(6);

  // Pass through [DONE] marker
  if (payload === "[DONE]") {
    log.tag("reasoning").debug("Stream done. Total chunks: %d, All delta keys seen: %o", state.chunkCount, [...state.allDeltaKeys].sort());
    return [line];
  }

  try {
    const chunk = JSON.parse(payload);
    const choice = chunk?.choices?.[0];
    if (!choice?.delta) return [line];

    const delta = choice.delta;
    state.chunkCount++;
    for (const k of Object.keys(delta)) state.allDeltaKeys.add(k);

    // Some providers use "reasoning", others use "reasoning_content"
    const reasoningText = typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0
      ? delta.reasoning_content
      : typeof delta.reasoning === "string" && delta.reasoning.length > 0
        ? delta.reasoning
        : null;
    const hasReasoning = reasoningText !== null;
    const hasContent = typeof delta.content === "string" && delta.content.length > 0;

    if (hasReasoning) {
      // Emit REASONING_START marker if this is the first reasoning chunk
      if (!state.inReasoning) {
        state.inReasoning = true;
        const markerChunk = JSON.parse(JSON.stringify(chunk));
        markerChunk.choices[0].delta = { content: REASONING_START_MARKER };
        const dataChunk = JSON.parse(JSON.stringify(chunk));
        dataChunk.choices[0].delta = { content: reasoningText };
        return [`data: ${JSON.stringify(markerChunk)}`, `data: ${JSON.stringify(dataChunk)}`];
      }
      // Replace reasoning → content
      const rewritten = JSON.parse(JSON.stringify(chunk));
      rewritten.choices[0].delta = { content: reasoningText };
      return [`data: ${JSON.stringify(rewritten)}`];
    }

    if (hasContent && state.inReasoning) {
      // Transition from reasoning to real content
      state.inReasoning = false;
      const markerChunk = JSON.parse(JSON.stringify(chunk));
      markerChunk.choices[0].delta = { content: REASONING_END_MARKER };
      return [`data: ${JSON.stringify(markerChunk)}`, line];
    }

    return [line];
  } catch {
    return [line];
  }
}

// ─── Response body rewriter ────────────────────────────────────────────

/**
 * Transform a ReadableStream<Uint8Array> of SSE data, rewriting chunks
 * to expose reasoning_content.
 */
function rewriteSseStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state = { inReasoning: false, allDeltaKeys: new Set<string>(), chunkCount: 0 };
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          // Flush remaining buffer
          if (buffer) {
            const rewritten = rewriteChunkLine(buffer, state);
            for (const rl of rewritten) {
              controller.enqueue(encoder.encode(rl + "\n\n"));
            }
            buffer = "";
          }
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split("\n");
        // Keep last incomplete line in buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const rewritten = rewriteChunkLine(line, state);
          for (const rl of rewritten) {
            controller.enqueue(encoder.encode(rl + "\n\n"));
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}

// ─── Non-streaming JSON rewriter ──────────────────────────────────────

const THINKING_TAG_RE = /<(?:thinking|think|thought)>[\s\S]*?<\/(?:thinking|think|thought)>/i;

function getMessageReasoning(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  const reasoning = typeof record.reasoning === "string" && record.reasoning.trim().length > 0
    ? record.reasoning
    : typeof record.reasoning_content === "string" && record.reasoning_content.trim().length > 0
      ? record.reasoning_content
      : null;
  return reasoning;
}

function rewriteNonStreamingJson(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const record = payload as { choices?: unknown };
  if (!Array.isArray(record.choices)) return payload;

  let changed = false;
  const rewritten = structuredClone(payload) as { choices?: Array<{ message?: Record<string, unknown> }> };
  for (const choice of rewritten.choices ?? []) {
    const message = choice.message;
    const reasoning = getMessageReasoning(message);
    if (!message || !reasoning) continue;

    const content = message.content;
    if (typeof content === "string") {
      if (THINKING_TAG_RE.test(content)) continue;
      message.content = `<thinking>${reasoning.trim()}</thinking>${content.trim() ? `\n\n${content}` : ""}`;
      changed = true;
    }
  }

  return changed ? rewritten : payload;
}

// ─── Fetch wrapper ─────────────────────────────────────────────────────

export interface ReasoningFetchOptions {
  /** The original fetch to wrap. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Create a fetch function that intercepts SSE responses from Chat Completions
 * and rewrites them to expose `reasoning_content` as regular content with
 * start/end markers.
 */
export function createReasoningAwareFetch(
  options: ReasoningFetchOptions = {},
): typeof globalThis.fetch {
  const baseFetch = options.fetch ?? globalThis.fetch;

  return Object.assign(
    async function reasoningAwareFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const response = await baseFetch(input as RequestInfo, init);

    // Only intercept Chat Completions responses
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const isChatCompletions = url.includes("/chat/completions");
    const contentType = response.headers.get("content-type") ?? "";
    const isStreaming = contentType.includes("text/event-stream");

    if (!isChatCompletions) {
      return response;
    }

    if (isStreaming && response.body) {
      return new Response(rewriteSseStream(response.body), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    if (contentType.includes("application/json")) {
      try {
        const payload = await response.clone().json();
        const rewritten = rewriteNonStreamingJson(payload);
        if (rewritten !== payload) {
          const headers = new Headers(response.headers);
          headers.delete("content-length");
          return new Response(JSON.stringify(rewritten), {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        }
      } catch {
        return response;
      }
    }

    return response;
  },
  { preconnect: (baseFetch as { preconnect?: (...args: unknown[]) => void }).preconnect ?? (() => {}) },
  ) as typeof globalThis.fetch;
}
