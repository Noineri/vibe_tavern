/**
 * Streaming-native provider executor using Vercel AI SDK.
 *
 * Uses streamText() exclusively — the route layer decides whether to collect
 * the full response (this brief) or forward as SSE (FW-AI5).
 */

import { streamText } from "ai";
import type { ProviderExecutor, ProviderStreamResult, ProviderStreamChunk, ProviderStreamFinish, RawToolCall } from "./provider-execution-types.js";
import { resolveModel, toSdkMessages, prepareSdkMessages } from "./provider-executor-utils.js";
import { buildSamplerConfig } from "./sampler-mapper.js";
import type { ProviderType } from "@rp-platform/domain";
import { cancelled, providerError } from "../errors.js";
import { REASONING_START_MARKER, REASONING_END_MARKER } from "./openai-reasoning-fetch.js";
import { logSendDebug } from "../send-debug-log.js";

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
function createMappedStream(
  fullStream: AsyncIterable<unknown>,
): {
  stream: AsyncGenerator<ProviderStreamChunk>;
  hasRedacted: boolean;
  toolCalls: RawToolCall[];
} {
  let hasRedacted = false;
  let inReasoning = false;
  const toolCalls: RawToolCall[] = [];

  async function* walk(): AsyncGenerator<ProviderStreamChunk> {
    let chunkCount = 0;
    let reasoningCount = 0;
    const partTypes = new Set<string>();

    for await (const part of fullStream) {
      const p = part as { type: string; textDelta?: string; text?: string; toolCallId?: string; toolName?: string; args?: unknown; error?: unknown };
      chunkCount++;
      partTypes.add(p.type);

      // ── Provider error in stream ──
      if (p.type === "error") {
        const errMsg = p.error instanceof Error ? p.error.message : typeof p.error === "string" ? p.error : JSON.stringify(p.error);
        logSendDebug("reasoning.stream-error", { chunkCount, error: errMsg, partTypes: [...partTypes].sort() });
        throw providerError(`Provider stream error: ${errMsg}`);
      }

      // ── Tool calls ──
      if (p.type === "tool-call" && p.toolCallId && p.toolName) {
        const args = (typeof p.args === "object" && p.args !== null ? p.args : {}) as Record<string, unknown>;
        toolCalls.push({ toolCallId: p.toolCallId, toolName: p.toolName, args });
        yield { type: "tool-call", toolCallId: p.toolCallId, toolName: p.toolName, args };
        continue;
      }

      if (p.type === "text-delta" && p.textDelta) {
        // ── Marker protocol (OpenAI Chat Completions reasoning) ──
        if (p.textDelta === REASONING_START_MARKER) {
          inReasoning = true;
          reasoningCount++;
          logSendDebug("reasoning.marker.start", { chunkCount });
          continue;
        }
        if (p.textDelta === REASONING_END_MARKER) {
          inReasoning = false;
          logSendDebug("reasoning.marker.end", { chunkCount, reasoningCount });
          continue;
        }

        if (inReasoning) {
          reasoningCount++;
          yield { type: "reasoning-delta", textDelta: p.textDelta };
        } else {
          yield { type: "text-delta", delta: p.textDelta };
        }
      } else if (p.type === "reasoning" && (p.textDelta ?? p.text)) {
        // ── Native reasoning parts (Anthropic, Responses API) ──
        reasoningCount++;
        yield { type: "reasoning-delta", textDelta: p.textDelta ?? p.text ?? "" };
      } else if (p.type === "redacted-reasoning") {
        hasRedacted = true;
      }
      // reasoning-signature, source, tool-call, etc. — silently ignored
    }

    logSendDebug("reasoning.stream-complete", {
      totalChunks: chunkCount,
      reasoningChunks: reasoningCount,
      partTypes: [...partTypes].sort(),
      hasRedacted,
    });
  }

  return { stream: walk(), hasRedacted, toolCalls };
}

/**
 * Map the Vercel AI SDK result into our ProviderStreamFinish promise.
 */
function mapFinish(result: { finishReason: Promise<unknown>; usage: Promise<unknown> }): Promise<ProviderStreamFinish> {
  return Promise.all([result.finishReason, result.usage]).then(([reason, usage]) => {
    const usageRecord = usage as { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
    let finishReason: ProviderStreamFinish["finishReason"] = "stop";
    if (reason === "length") finishReason = "length";
    else if (reason === "content-filter") finishReason = "content-filter";
    else if (reason === "tool-calls") finishReason = "tool-calls";
    else if (reason === "error" || reason === "unknown") finishReason = "error";

    return {
      finishReason,
      usage: usageRecord ? {
        promptTokens: usageRecord.promptTokens,
        completionTokens: usageRecord.completionTokens,
        totalTokens: usageRecord.totalTokens,
      } : undefined,
    };
  });
}

/**
 * Streaming-native provider executor.
 *
 * Returns a ProviderStreamResult with an async iterable stream of text chunks,
 * a collected text promise, reasoning promise, and a finish metadata promise.
 */
export const streamProviderExecutor: ProviderExecutor = async (input) => {
  try {
    const model = resolveModel(input.profile, input.model);
    const messages = toSdkMessages(input.prompt);
    const { systemPrompt, conversationMessages } = prepareSdkMessages(messages, {
      prefill: input.prefill,
      providerType: input.profile.providerPreset as ProviderType,
    });

    const samplerConfig = buildSamplerConfig(input.profile);
    const result = streamText({
      model,
      messages: conversationMessages,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      abortSignal: input.signal,
      ...samplerConfig,
    });

    const { stream, hasRedacted, toolCalls: collectedToolCalls } = createMappedStream(result.fullStream);

    const finished = mapFinish(result);

    return {
      stream,
      finished,
      text: result.text,
      reasoning: result.reasoning as Promise<string | undefined>,
      hasRedactedReasoning: hasRedacted,
      toolCalls: collectedToolCalls,
    };
  } catch (error) {
    if (input.signal?.aborted) throw cancelled();
    throw providerError(error instanceof Error ? error.message : String(error));
  }
};
