/**
 * Streaming-native provider executor using Vercel AI SDK.
 *
 * Uses streamText() and exposes the chunk stream so the orchestrator can forward
 * text/reasoning deltas as SSE. The non-streaming path uses a separate executor
 * (nonstreaming-provider-executor.ts, generateText()).
 */

import { streamText, isStepCount } from "ai";
import type { ProviderExecutor, ProviderStreamResult, SentConfigSnapshot } from "./provider-execution-types.js";
import { resolveModel, toSdkMessages, prepareSdkMessages } from "./provider-executor-utils.js";
import { buildSamplerConfig } from "./sampler-mapper.js";
import { COAUTHOR_TRANSPORT, normalizeProviderType } from "@vibe-tavern/domain";
import { log } from "@vibe-tavern/domain";
import { cancelled } from "../../shared/errors.js";
import { createMappedStream, mapFinish, safeStreamTextPromise, safeReasoningPromise } from "./stream-helpers.js";
import { describeAttachments } from "./vision-gate.js";
import type { VisionGateConfig } from "./vision-gate.js";
import { wrapProviderExecutionError } from "./provider-error-wrapper.js";
import { resolveProviderFetchForProfile } from "../../domain/providers/provider-fetch-factory.js";

/**
 * Streaming-native provider executor.
 *
 * Returns a ProviderStreamResult with an async iterable stream of text chunks,
 * a collected text promise, reasoning promise, and a finish metadata promise.
 */
export const streamProviderExecutor: ProviderExecutor = async (input) => {
  try {
    const providerFetch = await resolveProviderFetchForProfile(input.profile);
    const model = resolveModel(input.profile, input.model, input.transport, providerFetch);
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
          input.signal, providerFetch,
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

    // --- Voice-note transcription (STT_PLAN ST-6) ---
    // Mirror of the describe step above: voice notes are ALWAYS transcribed
    // before assembly (no capability routing — the transcript is prompt input
    // for every model). Music/ambient clips are skipped inside
    // transcribeAttachments (playback-only). Absent voiceTranscriber = no STT
    // profile configured — the undescribed note then fails at assembly with
    // VoiceTranscribeUnavailableError (the honest configuration error).
    const voiceNotes = messages
      .filter((m) => m.role === "user")
      .flatMap((m) => m.attachments ?? [])
      .filter((a) => a.type === "audio" && (a.purpose ?? "voice") === "voice" && !a.description?.trim());

    if (voiceNotes.length > 0 && input.voiceTranscriber && input.assetLoader) {
      const { transcribeAttachments } = await import("./stt-gate.js");
      const transcripts = await transcribeAttachments(voiceNotes, input.voiceTranscriber, input.assetLoader, input.signal);
      const audioDescriptions = voiceNotes
        .map((att) => {
          const transcript = transcripts.get(att.id);
          return transcript !== undefined && transcript !== ""
            ? { attachmentId: att.id, name: att.name, type: "audio" as const, description: transcript }
            : null;
        })
        .filter((item): item is { attachmentId: string; name: string; type: "audio"; description: string } => item !== null);

      // Persist transcripts through the SAME seam image descriptions use.
      if (input.onAttachmentDescriptions && audioDescriptions.length > 0) {
        await input.onAttachmentDescriptions(audioDescriptions.map((d) => ({ attachmentId: d.attachmentId, description: d.description })));
      }

      // Patch the in-memory copies so this turn's assembly sees the
      // transcripts (the DB row was written above via the callback).
      messages = messages.map((m) => ({
        ...m,
        attachments: m.attachments?.map((att) => {
          const transcript = transcripts.get(att.id);
          return transcript !== undefined ? { ...att, description: transcript } : att;
        }),
      }));
    }

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

    // Responses rejects OpenAI-compatible advanced sampler/provider options.
    // Co-Author keeps only its explicit output-token limit on this transport.
    const samplerConfig = input.transport === COAUTHOR_TRANSPORT.responses
      ? { maxOutputTokens: input.profile.maxTokens }
      : buildSamplerConfig(input.profile);
    // Responses API multi-step tool calling: the SDK defaults `store` to true,
    // which assumes stateful continuation via `previousResponseId`. We send
    // full history each turn with NO previousResponseId, so force `store:
    // false` — the SDK then serializes the complete function_call +
    // function_call_output pair into each follow-up request (stateless
    // multi-step). Without this the server cannot resolve a tool result to its
    // call_id → 400 "function_call_output references unknown call_id" on the
    // second tool step.
    const responsesProviderOptions =
      input.transport === COAUTHOR_TRANSPORT.responses ? { openai: { store: false } } : undefined;
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
      ...(responsesProviderOptions ? { providerOptions: responsesProviderOptions } : {}),
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.tools && input.maxSteps ? { stopWhen: isStepCount(input.maxSteps) } : {}),
      include: { rawChunks: true },
    });

    const { stream, state } = createMappedStream(result.stream);

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
      get hasRedactedReasoning() {
        return state.hasRedacted;
      },
      sentConfig,
      providerResponse: state.providerResponse,
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
    throw wrapProviderExecutionError(error, input.profile.providerPreset);
  }
};
