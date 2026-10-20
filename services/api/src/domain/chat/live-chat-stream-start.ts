import { brandId } from "@vibe-tavern/domain";
import type { ChatId } from "@vibe-tavern/domain";
import { streamProviderExecutor } from "../../infrastructure/ai/stream-provider-executor.js";
import type { ProviderStreamResult } from "../../infrastructure/ai/provider-execution-types.js";
import { resolveEffectivePrefill } from "./continue-fallback.js";
import type { StreamStartInput } from "./continue-fallback.js";

interface StreamStartDependencies {
  executeStream: typeof streamProviderExecutor;
  discardPendingPromptTrace: (chatId: ChatId) => void;
}

/** Runs the provider stream request and discards its pending trace if startup fails. */
export async function startProviderStream(
  dependencies: StreamStartDependencies,
  input: StreamStartInput,
  prompt: Parameters<typeof streamProviderExecutor>[0]["prompt"],
): Promise<{ streamResult: ProviderStreamResult; startedAt: number }> {
  const startedAt = Date.now();
  try {
    const streamResult = await dependencies.executeStream({
      profile: input.profile,
      model: input.model,
      transport: input.transport,
      prompt,
      signal: input.signal,
      // LS-4 capability gate: same rule as the non-stream paths. CPF-2b
      // fallback: no prefill may ride (mutual exclusion is enforced at
      // prepareSdkMessages; suppressing the cascade here keeps it honest).
      prefill: input.continuationFallback
        ? undefined
        : resolveEffectivePrefill(input.profile, input.prefill ?? (prompt as { prefill?: string }).prefill ?? undefined),
      ...(input.continuationFallback ? { continuationFallback: true } : {}),
      tools: input.tools,
      maxSteps: input.maxSteps,
      cachedModels: input.visionAssets?.cachedModels,
      visionModel: input.visionAssets?.visionModel,
      assetLoader: input.visionAssets?.assetLoader,
      visionDescribePrompt: input.visionAssets?.visionDescribePrompt,
      voiceTranscriber: input.voiceTranscriber,
      onAttachmentDescriptions: input.onAttachmentDescriptions,
    });
    return { streamResult, startedAt };
  } catch (err) {
    dependencies.discardPendingPromptTrace(brandId<ChatId>(input.chatId));
    throw err;
  }
}
