/**
 * Streaming-native provider executor using Vercel AI SDK.
 *
 * Uses streamText() exclusively — the route layer decides whether to collect
 * the full response (this brief) or forward as SSE (FW-AI5).
 */

import { streamText } from "ai";
import type { ProviderExecutor, ProviderStreamResult, ProviderStreamChunk, ProviderStreamFinish } from "./provider-execution-types.js";
import { resolveModel, toSdkMessages, prepareSdkMessages } from "./provider-executor-utils.js";
import { buildSamplerConfig } from "./sampler-mapper.js";
import type { ProviderType } from "@rp-platform/domain";
import { cancelled, providerError } from "../errors.js";

/**
 * Map the Vercel AI SDK text stream into our ProviderStreamChunk iterable.
 */
async function* mapTextStream(
  textStream: AsyncIterable<string>,
): AsyncGenerator<ProviderStreamChunk> {
  for await (const delta of textStream) {
    if (delta) {
      yield { type: "text-delta", delta };
    }
  }
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
 * a collected text promise, and a finish metadata promise.
 */
export const streamProviderExecutor: ProviderExecutor = async (input) => {
  try {
    const model = resolveModel(input.profile, input.model);
    const messages = toSdkMessages(input.prompt);
    const { systemPrompt, conversationMessages } = prepareSdkMessages(messages, {
      prefill: input.prefill,
      providerType: input.profile.type as ProviderType,
    });

    const samplerConfig = buildSamplerConfig(input.profile);
    const result = streamText({
      model,
      messages: conversationMessages,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      abortSignal: input.signal,
      ...samplerConfig,
    });

    const stream = mapTextStream(result.textStream);
    const finished = mapFinish(result);

    return {
      stream,
      finished,
      text: result.text,
    };
  } catch (error) {
    if (input.signal?.aborted) throw cancelled();
    throw providerError(error instanceof Error ? error.message : String(error));
  }
};
