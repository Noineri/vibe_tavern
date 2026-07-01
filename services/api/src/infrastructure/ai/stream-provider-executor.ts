/**
 * Streaming-native provider executor using Vercel AI SDK.
 *
 * Uses streamText() and exposes the chunk stream so the orchestrator can forward
 * text/reasoning deltas as SSE. The non-streaming path uses a separate executor
 * (nonstreaming-provider-executor.ts, generateText()).
 */

import { streamText, stepCountIs } from "ai";
import { ProviderExecutionError } from "./provider-execution-types.js";
import type { ProviderExecutor, ProviderStreamResult, SentConfigSnapshot } from "./provider-execution-types.js";
import { resolveModel, toSdkMessages, prepareSdkMessages } from "./provider-executor-utils.js";
import { buildSamplerConfig } from "./sampler-mapper.js";
import { normalizeProviderType } from "@vibe-tavern/domain";
import { log } from "@vibe-tavern/domain";
import { classifyProviderError, extractProviderErrorStatusCode } from "./provider-error-classifier.js";
import { extractProviderErrorMessage } from "./provider-error-message.js";
import { cancelled } from "../../shared/errors.js";
import { createMappedStream, mapFinish, safeStreamTextPromise, safeReasoningPromise } from "./stream-helpers.js";
import { describeAttachments } from "./vision-gate.js";
import type { VisionGateConfig } from "./vision-gate.js";

/**
 * Streaming-native provider executor.
 *
 * Returns a ProviderStreamResult with an async iterable stream of text chunks,
 * a collected text promise, reasoning promise, and a finish metadata promise.
 */
export const streamProviderExecutor: ProviderExecutor = async (input) => {
  try {
    const model = resolveModel(input.profile, input.model);
    let messages = toSdkMessages(input.prompt);

    // --- Vision attachment handling ---
    const activeModel = input.cachedModels?.find(m => m.modelSlug === input.model);
    const hasVision = activeModel?.capabilities?.vision ?? false;
    const visionModelSlug = input.visionModel ?? null;
    const hasAttachments = messages.some(m => m.attachments?.length);

    let visionDescriptions: Array<{ attachmentId: string; name: string; type: "image" | "video"; description: string }> | undefined;
    const shouldDescribe = hasAttachments && visionModelSlug;

    if (shouldDescribe) {
      // Collect all image/video attachments from user messages
      const allAttachments = messages
        .filter(m => m.role === "user")
        .flatMap(m => m.attachments ?? [])
        .filter(a => (a.type === "image" || a.type === "video") && !a.description?.trim());

      if (allAttachments.length > 0) {
        const descriptions = await describeAttachments(
          allAttachments, visionModelSlug, input.profile, input.assetLoader!, input.visionDescribePrompt,
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
          messages = messages.map(m => ({
            ...m,
            attachments: m.attachments?.map(att => {
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

    const visionGate: VisionGateConfig = { hasVision, visionModel: visionModelSlug };

    const { conversationMessages } = await prepareSdkMessages(messages, {
      prefill: input.prefill,
      providerType: normalizeProviderType(input.profile.providerPreset),
      ...(hasAttachments ? { visionGate, assetLoader: input.assetLoader } : {}),
    });

    // DEBUG: log what actually goes to the provider
    const contentLen = (m: typeof conversationMessages[number]) => typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
    const messageLen = conversationMessages.reduce((s, m) => s + contentLen(m), 0);
    const hasSystemMessages = conversationMessages.some((m) => m.role === "system");
    const logger = log.tag("stream");
    logger.debug("%d msgs sent in trace order (%d chars total)", conversationMessages.length, messageLen);
    for (const m of conversationMessages) {
      logger.debug("  [msg] role=%s len=%d", m.role, contentLen(m));
    }

    const samplerConfig = buildSamplerConfig(input.profile);
    const sentConfig: SentConfigSnapshot = {
      systemRole: hasSystemMessages ? "system" : undefined,
      samplerConfig: samplerConfig as Record<string, unknown>,
      messageCount: conversationMessages.length,
      ...(visionDescriptions?.length ? { visionDescriptions } : {}),
    };
    logger.debug("sentConfig: %o", sentConfig);

    const result = streamText({
      model,
      messages: conversationMessages,
      allowSystemInMessages: true,
      abortSignal: input.signal,
      ...samplerConfig,
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.tools && input.maxSteps ? { stopWhen: stepCountIs(input.maxSteps) } : {}),
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
    // Setup error (streamText() failed before iteration began): normalize at the
    // execution boundary into ProviderExecutionError. Iteration errors surface
    // later in LiveChatOrchestrator.drainStream, which classifies inline.
    throw new ProviderExecutionError(
      extractProviderErrorMessage(error),
      classifyProviderError(error),
      normalizeProviderType(input.profile.providerPreset),
      { statusCode: extractProviderErrorStatusCode(error), cause: error },
    );
  }
};
