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
import type { ProviderType } from "@rp-platform/domain";
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
      providerType: input.profile.providerPreset as ProviderType,
    });

    const samplerConfig = buildSamplerConfig(input.profile);
    if (input.overrideMaxTokens != null) {
      samplerConfig.maxTokens = input.overrideMaxTokens;
    }
    logSendDebug("provider.nonstream.samplerConfig", {
      providerType: input.profile.providerPreset,
      samplerConfig,
    });
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
      reasoningLength: result.reasoning?.length ?? undefined,
      reasoningDetailsCount: result.reasoningDetails.length ?? undefined,
      finishReason: result.finishReason,
      usage: result.usage
        ? { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens, totalTokens: result.usage.totalTokens }
        : null,
      providerMetadata: result.providerMetadata
        ? JSON.stringify(result.providerMetadata).slice(0, 500)
        : null,
      stepsCount: result.steps.length ?? undefined,
    });

    return {
      text: result.text,
      reasoning: result.reasoning ?? undefined,
      usage: result.usage
        ? {
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
          }
        : undefined,
    };
  } catch (error) {
    if (input.signal?.aborted) throw cancelled();
    throw providerError(error instanceof Error ? error.message : String(error));
  }
}
