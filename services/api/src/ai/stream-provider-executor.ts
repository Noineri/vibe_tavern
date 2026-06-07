/**
 * Streaming-native provider executor using Vercel AI SDK.
 *
 * Uses streamText() exclusively — the route layer decides whether to collect
 * the full response (this brief) or forward as SSE (FW-AI5).
 */

import { streamText } from "ai";
import type { ProviderExecutor, ProviderStreamResult, SentConfigSnapshot } from "./provider-execution-types.js";
import { resolveModel, toSdkMessages, prepareSdkMessages } from "./provider-executor-utils.js";
import { buildSamplerConfig } from "./sampler-mapper.js";
import { normalizeProviderType } from "@vibe-tavern/domain";
import { log } from "@vibe-tavern/domain";
import { cancelled, providerError } from "../errors.js";
import { createMappedStream, mapFinish, safeStreamTextPromise, safeReasoningPromise } from "./stream-helpers.js";

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
    const { conversationMessages } = prepareSdkMessages(messages, {
      prefill: input.prefill,
      providerType: normalizeProviderType(input.profile.providerPreset),
    });

    // DEBUG: log what actually goes to the provider
    const messageLen = conversationMessages.reduce((s, m) => s + m.content.length, 0);
    const hasSystemMessages = conversationMessages.some((m) => m.role === "system");
    const logger = log.tag("stream");
    logger.debug("%d msgs sent in trace order (%d chars total)", conversationMessages.length, messageLen);
    for (const m of conversationMessages) {
      logger.debug("  [msg] role=%s len=%d", m.role, m.content.length);
    }

    const samplerConfig = buildSamplerConfig(input.profile);
    const sentConfig: SentConfigSnapshot = {
      systemRole: hasSystemMessages ? "system" : undefined,
      samplerConfig: samplerConfig as Record<string, unknown>,
      messageCount: conversationMessages.length,
    };
    logger.debug("sentConfig: %o", sentConfig);

    const result = streamText({
      model,
      messages: conversationMessages,
      allowSystemInMessages: true,
      abortSignal: input.signal,
      ...samplerConfig,
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
    });

    const { stream, hasRedacted } = createMappedStream(result.fullStream);

    // Attach catch handlers immediately. On manual cancellation AI SDK v5 can
    // reject these promises later with NoOutputGeneratedError even after our
    // route already returned an abort event; if left unhandled, Bun terminates.
    const finished = mapFinish(result, input.signal);
    const text = safeStreamTextPromise(result.text, input.signal);
    const reasoning = safeReasoningPromise(result.reasoningText as Promise<string | undefined>, input.signal);

    return {
      stream,
      finished,
      text,
      reasoning,
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
