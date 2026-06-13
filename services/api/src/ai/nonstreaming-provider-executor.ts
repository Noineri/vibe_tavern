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
    let messages = toSdkMessages(input.prompt);
    const activeModel = input.cachedModels?.find((m) => m.modelSlug === input.model);
    const hasVision = activeModel?.capabilities?.vision ?? false;
    const visionModelSlug = input.visionModel ?? null;
    const hasAttachments = messages.some((m) => m.attachments?.length);

    let visionDescriptions: Array<{ attachmentId: string; name: string; type: "image" | "video"; description: string }> | undefined;
    const shouldDescribe = hasAttachments && visionModelSlug;

    if (shouldDescribe) {
      const allAttachments = messages
        .filter((m) => m.role === "user")
        .flatMap((m) => m.attachments ?? [])
        .filter((a) => (a.type === "image" || a.type === "video") && !a.description?.trim());
      if (allAttachments.length > 0 && input.assetLoader) {
        const { describeAttachments } = await import("./vision-gate.js");
        const descriptions = await describeAttachments(
          allAttachments,
          visionModelSlug,
          input.profile,
          input.assetLoader,
          input.visionDescribePrompt,
        );
        visionDescriptions = allAttachments
          .map((att) => {
            const description = descriptions.get(att.id);
            return description
              ? { attachmentId: att.id, name: att.name, type: att.type, description }
              : null;
          })
          .filter((item): item is { attachmentId: string; name: string; type: "image" | "video"; description: string } => item !== null);

        // Always persist descriptions back to the message
        if (input.onAttachmentDescriptions && visionDescriptions.length > 0) {
          await input.onAttachmentDescriptions(visionDescriptions.map(d => ({ attachmentId: d.attachmentId, description: d.description })));
        }

        // Only replace image attachments with text when the model lacks native vision
        if (!hasVision) {
          messages = messages.map((m) => ({
            ...m,
            attachments: m.attachments?.map((att) => {
              const desc = descriptions.get(att.id);
              if (desc) {
                return { ...att, type: "file" as const, description: desc };
              }
              return att;
            }),
          }));
        }
      }
    }

    const visionGate = { hasVision, visionModel: visionModelSlug };
    const { conversationMessages } = await prepareSdkMessages(messages, {
      prefill: input.prefill,
      providerType: normalizeProviderType(input.profile.providerPreset),
      ...(hasAttachments ? { visionGate, assetLoader: input.assetLoader } : {}),
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
      systemRole: conversationMessages.some((m) => m.role === "system") ? "system" as const : undefined,
      samplerConfig: samplerConfig as Record<string, unknown>,
      messageCount: conversationMessages.length,
      ...(visionDescriptions?.length ? { visionDescriptions } : {}),
    };
    logSendDebug("provider.nonstream.sentConfig", sentConfig);

    const result = await generateText({
      model,
      messages: conversationMessages,
      allowSystemInMessages: true,
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
