/**
 * Streaming-native provider executor using Vercel AI SDK.
 *
 * Uses streamText() exclusively — the route layer decides whether to collect
 * the full response (this brief) or forward as SSE (FW-AI5).
 */

import { streamText } from "ai";
import type { ProviderExecutor, ProviderStreamResult, ProviderStreamChunk, ProviderStreamFinish } from "./provider-execution-types.js";
import { mapProfileToSdkModel } from "./provider-profile-mapper.js";
import { buildSamplerConfig } from "./sampler-mapper.js";
import { getProviderCapabilities } from "./provider-capabilities.js";
import type { ProviderType } from "@rp-platform/domain";
import { cancelled, providerError } from "../errors.js";

/**
 * Resolve a Vercel AI SDK language model from a stored provider profile.
 * Delegates to the canonical provider-profile-mapper.
 */
function resolveModel(profile: { type: string; endpoint: string; apiKey: string | null }, model: string) {
  const mapping = mapProfileToSdkModel(profile, model);
  return mapping.model;
}

/**
 * Convert an AssemblePromptResponse into Vercel AI SDK message format.
 */
function toSdkMessages(prompt: { finalPayload?: unknown }): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const payload = prompt.finalPayload as { messages?: unknown } | undefined;
  const records = Array.isArray(payload?.messages) ? payload.messages : [];

  return records
    .map((record: unknown) => {
      if (!record || typeof record !== "object") return null;
      const r = record as { role?: unknown; content?: unknown };
      if (typeof r.role !== "string" || typeof r.content !== "string") return null;
      if (r.role !== "system" && r.role !== "user" && r.role !== "assistant") return null;
      return { role: r.role as "system" | "user" | "assistant", content: r.content };
    })
    .filter((m): m is { role: "system" | "user" | "assistant"; content: string } => m !== null);
}

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

    // Separate system message from conversation messages
    const systemMessages = messages.filter(m => m.role === "system");
    const conversationMessages = messages.filter(m => m.role !== "system");
    const systemPrompt = systemMessages.map(m => m.content).join("\n\n") || undefined;
    const capabilities = getProviderCapabilities(input.profile.type as ProviderType);
    if (input.prefill && capabilities.prefill) {
      conversationMessages.push({ role: "assistant", content: input.prefill });
    }

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
