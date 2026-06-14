/**
 * Helpers extracted from stream-provider-executor for testability.
 *
 * These operate on AI SDK result types and fullStream parts without
 * depending on the full executor pipeline.
 */

import { logSendDebug } from "../../send-debug-log.js";
import { extractProviderErrorMessage } from "./provider-error-message.js";
import { cancelled, providerError } from "../../errors.js";
import { REASONING_START_MARKER, REASONING_END_MARKER } from "../../domain/providers/openai-reasoning-fetch.js";
import type { ProviderStreamChunk, ProviderStreamFinish } from "./provider-execution-types.js";

// ─── createMappedStream ──────────────────────────────────────────────────

/**
 * Map the Vercel AI SDK fullStream into our ProviderStreamChunk iterable.
 *
 * Filters for `text-delta` and `reasoning` parts only.
 * Tracks whether a `redacted-reasoning` part was seen (e.g. Claude extended thinking).
 *
 * Also handles the REASONING_START/REASONING_END marker protocol injected
 * by our `createReasoningAwareFetch()` wrapper for OpenAI Chat Completions
 * providers that return `reasoning_content` in streaming deltas.
 */
export function createMappedStream(
  fullStream: AsyncIterable<unknown>,
): {
  stream: AsyncGenerator<ProviderStreamChunk>;
  hasRedacted: boolean;
} {
  let hasRedacted = false;
  let inReasoning = false;

  async function* walk(): AsyncGenerator<ProviderStreamChunk> {
    let chunkCount = 0;
    let reasoningCount = 0;
    const partTypes = new Set<string>();

    for await (const part of fullStream) {
      const p = part as { type: string };
      chunkCount++;
      partTypes.add(p.type);

      // ── Provider error in stream ──
      if (p.type === "error") {
        const pErr = part as { type: string; errorText?: string; error?: unknown };
        const errMsg = pErr.errorText ?? extractProviderErrorMessage(pErr.error);
        logSendDebug("reasoning.stream-error", { chunkCount, error: errMsg, partTypes: [...partTypes].sort() });
        throw providerError(errMsg);
      }

      // ── Tool calls (informational — AI SDK handles execution) ──
      if (p.type === "tool-call") {
        const tc = part as { type: string; toolCallId?: string; toolName?: string; args?: unknown };
        if (tc.toolCallId && tc.toolName) {
          const args = (typeof tc.args === "object" && tc.args !== null ? tc.args : {}) as Record<string, unknown>;
          yield { type: "tool-call", toolCallId: tc.toolCallId, toolName: tc.toolName, args };
          continue;
        }
      }

      // ── Tool results (informational — forwarded for SSE) ──
      if (p.type === "tool-result") {
        const tr = part as { type: string; toolCallId?: string; toolName?: string; isError?: boolean };
        if (tr.toolCallId) {
          yield { type: "tool-result", toolCallId: tr.toolCallId, toolName: String(tr.toolName ?? ""), isError: tr.isError };
          continue;
        }
      }

      // AI SDK v5/v6 fullStream part fields:
      //   text-delta     → `text` (string)
      //   reasoning-delta → `delta` (string)
      const p2 = part as { type: string; text?: string; delta?: string };

      if (p.type === "text-delta" && p2.text) {
        // ── Marker protocol (OpenAI Chat Completions reasoning) ──
        if (p2.text === REASONING_START_MARKER) {
          inReasoning = true;
          reasoningCount++;
          logSendDebug("reasoning.marker.start", { chunkCount });
          continue;
        }
        if (p2.text === REASONING_END_MARKER) {
          inReasoning = false;
          logSendDebug("reasoning.marker.end", { chunkCount, reasoningCount });
          continue;
        }

        if (inReasoning) {
          reasoningCount++;
          yield { type: "reasoning-delta", textDelta: p2.text };
        } else {
          yield { type: "text-delta", delta: p2.text };
        }
      } else if (p.type === "reasoning-delta" && p2.delta) {
        // ── Native reasoning parts (AI SDK v5+: reasoning-start/reasoning-delta/reasoning-end) ──
        reasoningCount++;
        yield { type: "reasoning-delta", textDelta: p2.delta };
      } else if (p.type === "redacted-reasoning") {
        hasRedacted = true;
      }
      // reasoning-start, reasoning-end, text-start, text-end, source, etc. — silently ignored
    }

    logSendDebug("reasoning.stream-complete", {
      totalChunks: chunkCount,
      reasoningChunks: reasoningCount,
      partTypes: [...partTypes].sort(),
      hasRedacted,
    });
  }

  return { stream: walk(), hasRedacted };
}

// ─── mapFinish ───────────────────────────────────────────────────────────

/**
 * Map the Vercel AI SDK result into our ProviderStreamFinish promise.
 */
export function mapFinish(
  result: { finishReason: PromiseLike<unknown>; usage: PromiseLike<unknown> },
  signal?: AbortSignal,
): Promise<ProviderStreamFinish> {
  return Promise.all([result.finishReason, result.usage]).then(([reason, usage]) => {
    const usageRecord = usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
    let finishReason: ProviderStreamFinish["finishReason"] = "stop";
    if (reason === "length") finishReason = "length";
    else if (reason === "content-filter") finishReason = "content-filter";
    else if (reason === "tool-calls") finishReason = "tool-calls";
    else if (reason === "error" || reason === "unknown") finishReason = "error";

    return {
      finishReason,
      usage: usageRecord ? {
        inputTokens: usageRecord.inputTokens,
        outputTokens: usageRecord.outputTokens,
        totalTokens: usageRecord.totalTokens,
      } : undefined,
    };
  }).catch((error) => {
    if (signal?.aborted || isNoOutputGeneratedError(error)) return { finishReason: "cancelled" };
    logSendDebug("stream.finish-promise-error", { message: error instanceof Error ? error.message : String(error) });
    return { finishReason: "error" };
  });
}

// ─── Error classification ────────────────────────────────────────────────

export function isNoOutputGeneratedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AI_NoOutputGeneratedError" || error.name === "NoOutputGeneratedError" || error.message.includes("No output generated");
}

// ─── Safe promise wrappers ───────────────────────────────────────────────

export function safeStreamTextPromise(promise: PromiseLike<string>, signal?: AbortSignal): Promise<string> {
  return Promise.resolve(promise).catch((error: unknown) => {
    if (signal?.aborted || isNoOutputGeneratedError(error)) return "";
    logSendDebug("stream.text-promise-error", { message: error instanceof Error ? error.message : String(error) });
    return "";
  });
}

export function safeReasoningPromise(promise: PromiseLike<string | undefined>, signal?: AbortSignal): Promise<string | undefined> {
  return Promise.resolve(promise).catch((error: unknown) => {
    if (signal?.aborted || isNoOutputGeneratedError(error)) return undefined;
    logSendDebug("stream.reasoning-promise-error", { message: error instanceof Error ? error.message : String(error) });
    return undefined;
  });
}
