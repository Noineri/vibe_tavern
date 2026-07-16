/**
 * Non-streaming provider executor using Vercel AI SDK generateText().
 *
 * Makes a single non-streaming API call and returns the complete response.
 * Avoids SSE stream collection issues with providers that don't terminate
 * their streaming responses correctly (e.g. nanoGPT).
 */

import { generateText, stepCountIs } from "ai";
import type { ProviderMetadata } from "ai";
import { ProviderExecutionError } from "./provider-execution-types.js";
import type { ExtractedToolCall, ExtractedToolResult, GenerationResult } from "./provider-execution-types.js";
import type { ProviderExecutionInput } from "./provider-execution-types.js";
import { resolveModel, toSdkMessages, prepareSdkMessages } from "./provider-executor-utils.js";
import { buildSamplerConfig } from "./sampler-mapper.js";
import { normalizeProviderType } from "@vibe-tavern/domain";
import { classifyProviderError, extractProviderErrorStatusCode } from "./provider-error-classifier.js";
import { extractProviderErrorMessage } from "./provider-error-message.js";
import { serializeProviderResponseTrace } from "./provider-response-trace.js";
import { cancelled } from "../../shared/errors.js";
import { logSendDebug } from "../../shared/send-debug-log.js";

interface NonstreamingToolStep {
  toolCalls?: ReadonlyArray<{
    toolCallId: string;
    toolName: string;
    input?: unknown;
    providerMetadata?: ProviderMetadata;
  }>;
  toolResults?: ReadonlyArray<{
    toolCallId: string;
    toolName: string;
    input?: unknown;
    output: unknown;
  }>;
}

/** Normalize AI SDK completed steps without dropping provider replay metadata. */
export function extractNonstreamingToolInteractions(
  steps: ReadonlyArray<NonstreamingToolStep>,
): { toolCalls: ExtractedToolCall[]; toolResults: ExtractedToolResult[] } {
  const toolCalls: ExtractedToolCall[] = [];
  const toolResults: ExtractedToolResult[] = [];

  for (const step of steps) {
    for (const tc of step.toolCalls ?? []) {
      toolCalls.push({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.input && typeof tc.input === "object" && !Array.isArray(tc.input)
          ? tc.input as Record<string, unknown>
          : {},
        ...(tc.providerMetadata ? { providerOptions: tc.providerMetadata } : {}),
      });
    }
    for (const tr of step.toolResults ?? []) {
      toolResults.push({
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        args: tr.input && typeof tr.input === "object" && !Array.isArray(tr.input)
          ? tr.input as Record<string, unknown>
          : {},
        result: tr.output,
        isError: false,
      });
    }
  }

  return { toolCalls, toolResults };
}

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
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.tools && input.maxSteps ? { stopWhen: stepCountIs(input.maxSteps) } : {}),
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

    // AI SDK v6 completed tool calls carry provider replay metadata separately
    // from their parsed input. Preserve both through the same persisted history
    // path used by streaming calls; Gemini 3 requires thoughtSignature on replay.
    const {
      toolCalls: extractedToolCalls,
      toolResults: extractedToolResults,
    } = extractNonstreamingToolInteractions(result.steps ?? []);

    const providerResponse = serializeProviderResponseTrace(
      "nonstream",
      result.steps.map((step) => ({
        response: step.response,
        providerMetadata: step.providerMetadata,
        finishReason: step.finishReason,
        rawFinishReason: step.rawFinishReason,
        usage: step.usage,
      })),
    );

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
      providerResponse,
      toolCalls: extractedToolCalls.length > 0 ? extractedToolCalls : undefined,
      toolResults: extractedToolResults.length > 0 ? extractedToolResults : undefined,
    };
  } catch (error) {
    if (input.signal?.aborted) throw cancelled();
    // Normalize at the execution boundary: classify once into ProviderExecutionError
    // so the category, providerType, and statusCode travel as structured data
    // (the SSE/HTTP emit sites and the global error handler read them).
    throw new ProviderExecutionError(
      extractProviderErrorMessage(error),
      classifyProviderError(error),
      normalizeProviderType(input.profile.providerPreset),
      { statusCode: extractProviderErrorStatusCode(error), cause: error },
    );
  }
}
