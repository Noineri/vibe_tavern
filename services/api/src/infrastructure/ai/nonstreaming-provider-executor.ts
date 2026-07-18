/**
 * Non-streaming provider executor using Vercel AI SDK generateText().
 *
 * Makes a single non-streaming API call and returns the complete response.
 * Avoids SSE stream collection issues with providers that don't terminate
 * their streaming responses correctly (e.g. nanoGPT).
 */

import { generateText, stepCountIs } from "ai";
import type { ProviderMetadata } from "ai";
import type { ExtractedToolCall, ExtractedToolResult, GenerationResult } from "./provider-execution-types.js";
import type { ProviderExecutionInput } from "./provider-execution-types.js";
import { resolveModel, toSdkMessages, prepareSdkMessages } from "./provider-executor-utils.js";
import { buildSamplerConfig } from "./sampler-mapper.js";
import { normalizeProviderType } from "@vibe-tavern/domain";
import { wrapProviderExecutionError } from "./provider-error-wrapper.js";
import { serializeProviderResponseTrace } from "./provider-response-trace.js";
import { cancelled } from "../../shared/errors.js";
import { logSendDebug } from "../../shared/send-debug-log.js";

/** Loose `step.content` part shape — we only consume `tool-error` parts. */
type NonstreamingToolContentPart = {
  type: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  error?: unknown;
};

interface NonstreamingToolStep {
  toolCalls?: ReadonlyArray<{
    toolCallId: string;
    toolName: string;
    input?: unknown;
    providerMetadata?: ProviderMetadata;
  }>;
  // AI SDK v6: toolResults holds SUCCESSFUL executions only. A failed execute()
  // surfaces as a `tool-error` part in `content`, NOT a toolResults entry.
  // Reading only toolResults orphaned failed calls (their toolCall was recorded
  // but no result), which broke the next turn's history reconstruction with
  // "Tool result is missing for tool call X" — see extractNonstreamingToolInteractions.
  toolResults?: ReadonlyArray<{
    toolCallId: string;
    toolName: string;
    input?: unknown;
    output: unknown;
  }>;
  content?: ReadonlyArray<NonstreamingToolContentPart>;
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
    // AI SDK v6: a failed execute() is a `tool-error` part in step.content, not
    // a toolResults entry. Synthesize an error result so the call is not
    // orphaned (its toolCall was already recorded above). Without this, the
    // next turn's history reconstruction throws "Tool result is missing for
    // tool call X" and the chat deadlocks after any failed tool call.
    for (const part of step.content ?? []) {
      if (part.type !== "tool-error") continue;
      const id = part.toolCallId;
      if (!id) continue;
      if (toolResults.some((r) => r.toolCallId === id)) continue; // already has a (success) result
      const matchedCall = toolCalls.find((c) => c.toolCallId === id);
      toolResults.push({
        toolCallId: id,
        toolName: part.toolName ?? matchedCall?.toolName ?? "",
        args: matchedCall?.args ?? {},
        result: part.error instanceof Error
          ? { error: part.error.message }
          : { error: part.error != null ? String(part.error) : "tool execution error" },
        isError: true,
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
    throw wrapProviderExecutionError(error, input.profile.providerPreset);
  }
}
