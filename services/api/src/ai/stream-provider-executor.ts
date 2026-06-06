/**
 * Streaming-native provider executor using Vercel AI SDK.
 *
 * Uses streamText() exclusively — the route layer decides whether to collect
 * the full response (this brief) or forward as SSE (FW-AI5).
 */

import { streamText, APICallError } from "ai";
import type { ProviderExecutor, ProviderStreamResult, ProviderStreamChunk, ProviderStreamFinish, SentConfigSnapshot } from "./provider-execution-types.js";
import { resolveModel, toSdkMessages, prepareSdkMessages } from "./provider-executor-utils.js";
import { buildSamplerConfig } from "./sampler-mapper.js";
import { normalizeProviderType, type ProviderType } from "@vibe-tavern/domain";
import { log } from "@vibe-tavern/domain";
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
        const errMsg = pErr.errorText ?? (pErr.error instanceof Error ? pErr.error.message : typeof pErr.error === "string" ? pErr.error : JSON.stringify(pErr.error));
        logSendDebug("reasoning.stream-error", { chunkCount, error: errMsg, partTypes: [...partTypes].sort() });
        throw providerError(`Provider stream error: ${errMsg}`);
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

      // AI SDK v5 fullStream part fields:
      //   text-delta     → `text` (string)
      //   reasoning-delta → `delta` (string)
      const p2 = part as { type: string; text?: string; delta?: string; toolCallId?: string; toolName?: string; args?: unknown; errorText?: string; isError?: boolean };

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
        // ── Native reasoning parts (AI SDK v5: reasoning-start/reasoning-delta/reasoning-end) ──
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

/**
 * Map the Vercel AI SDK result into our ProviderStreamFinish promise.
 */
function mapFinish(result: { finishReason: Promise<unknown>; usage: Promise<unknown> }): Promise<ProviderStreamFinish> {
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
      providerType: normalizeProviderType(input.profile.providerPreset),
    });

    // DEBUG: log what actually goes to the provider
    const systemLen = systemPrompt?.length ?? 0;
    const convLen = conversationMessages.reduce((s, m) => s + m.content.length, 0);
    const logger = log.tag("stream");
    logger.debug("%d msgs → system=%d chars + %d conv msgs (%d chars) = %d chars total", messages.length, systemLen, conversationMessages.length, convLen, systemLen + convLen);
    for (const m of messages) {
      logger.debug("  [msg] role=%s len=%d", m.role, m.content.length);
    }

    const samplerConfig = buildSamplerConfig(input.profile);
    const sentConfig: SentConfigSnapshot = {
      systemRole: systemPrompt ? "system" : undefined,
      samplerConfig: samplerConfig as Record<string, unknown>,
      messageCount: conversationMessages.length,
    };
    logger.debug("sentConfig: %o", sentConfig);

    const result = streamText({
      model,
      messages: conversationMessages,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      abortSignal: input.signal,
      ...samplerConfig,
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
    });

    const { stream, hasRedacted } = createMappedStream(result.fullStream);

    const finished = mapFinish(result);

    return {
      stream,
      finished,
      text: result.text,
      reasoning: result.reasoningText as Promise<string | undefined>,
      hasRedactedReasoning: hasRedacted,
      sentConfig,
    };
  } catch (error) {
    if (input.signal?.aborted) throw cancelled();
    // AI SDK v5 throws NoOutputGeneratedError when stream produced nothing (e.g. immediate abort)
    if (error && typeof error === "object" && "vercel.ai.error" in error) {
      throw cancelled();
    }
    throw providerError(error instanceof Error ? error.message : String(error));
  }
};
