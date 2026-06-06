/**
 * Non-streaming provider executor using Vercel AI SDK generateText().
 *
 * Makes a single non-streaming API call and returns the complete response.
 * Avoids SSE stream collection issues with providers that don't terminate
 * their streaming responses correctly (e.g. nanoGPT).
 */

import { generateText } from "ai";
import type { GenerationResult } from "./provider-execution-types.js";
import type { ProviderExecutionInput } from "./provider-execution-types.js";
import { resolveModel, toSdkMessages, prepareSdkMessages } from "./provider-executor-utils.js";
import { buildSamplerConfig } from "./sampler-mapper.js";
import { normalizeProviderType, type ProviderType } from "@vibe-tavern/domain";
import { cancelled, providerError } from "../errors.js";
import { logSendDebug } from "../send-debug-log.js";

export async function nonstreamingProviderExecute(
  input: ProviderExecutionInput,
): Promise<GenerationResult> {
  try {
    const model = resolveModel(input.profile, input.model);
    const messages = toSdkMessages(input.prompt);
    const { systemPrompt, conversationMessages } = prepareSdkMessages(messages, {
      prefill: input.prefill,
      providerType: normalizeProviderType(input.profile.providerPreset),
    });

    const samplerConfig = buildSamplerConfig(input.profile);
    if (input.overrideMaxTokens != null) {
      samplerConfig.maxOutputTokens = input.overrideMaxTokens;
    }
    logSendDebug("provider.nonstream.samplerConfig", {
      providerType: input.profile.providerPreset,
      samplerConfig,
    });
    const sentConfig = {
      systemRole: systemPrompt ? "system" as const : undefined,
      samplerConfig: samplerConfig as Record<string, unknown>,
      messageCount: conversationMessages.length,
    };
    logSendDebug("provider.nonstream.sentConfig", sentConfig);

    const result = await generateText({
      model,
      messages: conversationMessages,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      abortSignal: input.signal,
      ...samplerConfig,
    });

    logSendDebug("provider.nonstream.result", {
      textLength: result.text.length,
      textPreview: result.text.slice(0, 200),
      reasoningLength: result.reasoningText?.length ?? undefined,
      reasoningPartsCount: result.reasoning.length ?? undefined,
      finishReason: result.finishReason,
      usage: result.usage
        ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, totalTokens: result.usage.totalTokens }
        : null,
      providerMetadata: result.providerMetadata
        ? JSON.stringify(result.providerMetadata).slice(0, 500)
        : null,
      stepsCount: result.steps.length ?? undefined,
    });

    return {
      text: result.text,
      reasoning: result.reasoningText ?? undefined,
      usage: result.usage
        ? {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
          }
        : undefined,
      sentConfig,
    };
  } catch (error) {
    if (input.signal?.aborted) throw cancelled();
    throw providerError(error instanceof Error ? error.message : String(error));
  }
}
