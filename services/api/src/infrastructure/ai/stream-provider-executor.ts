/**
 * Streaming-native provider executor using Vercel AI SDK.
 *
 * Uses streamText() and exposes the chunk stream so the orchestrator can forward
 * text/reasoning deltas as SSE. The non-streaming path uses a separate executor
 * (nonstreaming-provider-executor.ts, generateText()).
 */

import { streamText, isStepCount } from "ai";
import type { ProviderExecutor, ProviderStreamResult, SentConfigSnapshot } from "./provider-execution-types.js";
import { resolveModel, resolveCompletionFormatHandoff, toSdkMessages, prepareSdkMessages, prepareProviderTools } from "./provider-executor-utils.js";
import { buildSamplerConfig } from "./sampler-mapper.js";
import { COAUTHOR_TRANSPORT, normalizeProviderType } from "@vibe-tavern/domain";
import { log } from "@vibe-tavern/domain";
import { cancelled } from "../../shared/errors.js";
import { createMappedStream, mapFinish, safeStreamTextPromise, safeReasoningPromise } from "./stream-helpers.js";
import { prepareAttachmentMedia } from "./attachment-media.js";
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
    // LS-3b/c: thread the preset's generation format (TC mode only) to the
    // completion seam — manual sequences render through it; auto resolves per
    // protocol capability (backend template on llama-server, default else).
    const format = resolveCompletionFormatHandoff(input.profile, input.prompt.completionFormat);
    const model = resolveModel(input.profile, input.model, input.transport, providerFetch, format);
    const { messages, visionGate, hasAttachments, visionDescriptions } = await prepareAttachmentMedia(toSdkMessages(input.prompt), input, providerFetch);

    const { conversationMessages } = await prepareSdkMessages(messages, {
      prefill: input.prefill,
      continuationFallback: input.continuationFallback,
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
      : buildSamplerConfig(input.profile, input.model);
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
    const providerTools = prepareProviderTools(input.tools);
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
      ...(providerTools ? { tools: providerTools } : {}),
      toolCallConcurrency: 1,
      ...(providerTools && input.maxSteps ? { stopWhen: isStepCount(input.maxSteps) } : {}),
      include: { rawChunks: true },
    });

    const { stream, state } = createMappedStream(result.stream);

    // Observe collection rejections before returning, including aborted streams.
    const finished = mapFinish(result, input.signal);
    const text = safeStreamTextPromise(result.text, input.signal);
    const reasoning = safeReasoningPromise(result.reasoningText, input.signal);

    return {
      stream,
      finished,
      text,
      reasoning,
      sentConfig,
      providerResponse: state.providerResponse,
    };
  } catch (error) {
    if (input.signal?.aborted) throw cancelled();
    // Setup error (streamText() failed before iteration began): normalize at the
    // execution boundary into ProviderExecutionError. Iteration errors surface
    // later in LiveChatOrchestrator.drainStream, which classifies inline.
    throw wrapProviderExecutionError(error, input.profile.providerPreset);
  }
};
