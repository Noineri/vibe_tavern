import { brandId, EventBus } from "@vibe-tavern/domain";
import type { ChatId, MessageId, PromptPresetId } from "@vibe-tavern/domain";
import type { ChatRuntime } from "../../runtime/session/session-runtime-chat.js";
import type { SessionSnapshot, MessageResponse } from "../../api/contract/session-types.js";
import type { ProviderOrchestrator } from "../providers/provider-orchestrator.js";
import type { StoredProviderProfileRecord } from "@vibe-tavern/domain";
import type { ProviderExecutionInput, ProviderStreamResult } from "../../infrastructure/ai/provider-execution-types.js";
import type { ChatModeStrategy } from "./chat-mode-strategy.js";
import { nonstreamingProviderExecute } from "../../infrastructure/ai/nonstreaming-provider-executor.js";
import { streamProviderExecutor } from "../../infrastructure/ai/stream-provider-executor.js";
import { logSendDebug } from "../../shared/send-debug-log.js";
import { extractThinkingTags } from "../../infrastructure/ai/extract-thinking-tags.js";
import { ensurePrefillInResponse } from "../../infrastructure/ai/ensure-prefill-in-response.js";
import { extractProviderErrorMessage } from "../../infrastructure/ai/provider-error-message.js";

/**
 * Coordinates the prepare → execute → append cycle for all AI generation paths:
 * send, generate (continue), regenerate — each with streaming and non-streaming variants.
 *
 * Delegates prompt assembly to {@link ChatRuntime}, AI execution to the provider layer,
 * and mode-specific behavior to {@link ChatModeStrategy}.
 */
export class LiveChatOrchestrator {
  constructor(
    private readonly chatRuntime: ChatRuntime,
    private readonly chatApp: import("./chat-application-service.js").ChatApplicationService,
    private readonly providers: ProviderOrchestrator,
    private readonly events: EventBus,
    private readonly strategy: ChatModeStrategy,
  ) {}

  // ─── Non-streaming methods ────────────────────────────────────────────

  /** Non-streaming send: prepare → execute → append reply → return snapshot. */
  async sendMessage(input: {
    chatId: string;
    content: string;
    attachments?: any[];
    profile: StoredProviderProfileRecord;
    model: string;
    prefill?: string;
    signal?: AbortSignal;
    visionAssets?: { cachedModels: any[]; visionModel: string | null; assetLoader: (assetId: string) => Promise<Buffer | null>; visionDescribePrompt?: string };
  }): Promise<{
    preparedMessageCount: number;
    promptMessageCount: number;
    reply: string;
    snapshot: MessageResponse;
  }> {
    const provider = await this.resolveProvider(input);
    logSendDebug("live.send.prepare.start", { chatId: input.chatId, model: provider.model });
    const prepared = await this.chatRuntime.prepareLiveTurn(brandId<ChatId>(input.chatId), input.content, provider.model, provider.profile.maxTokens, input.attachments);
    this.notifyUserMessageCreated(input.chatId, prepared.userMessage);
    logSendDebug("live.send.prepare.done", {
      chatId: input.chatId,
      snapshotMessageCount: prepared.snapshot.messages.length,
      promptMessageCount: countPromptMessages(prepared.prompt),
    });
    const startedAt = Date.now();
    logSendDebug("live.send.provider.start", { chatId: input.chatId, providerId: provider.profile.id, model: provider.model });
    const prefill = prepared.prompt.prefill ?? undefined;
    let reply: string;
    let reasoning: string | undefined;
    try {
      // Non-streaming path: generateText() awaits the full reply, returned as JSON.
      // The streaming equivalent (SSE text/reasoning deltas) lives in sendMessageStream() / startStream().
      const result = await nonstreamingProviderExecute({
        profile: provider.profile,
        model: provider.model,
        prompt: prepared.prompt,
        signal: input.signal,
        prefill,
        cachedModels: input.visionAssets?.cachedModels,
        visionModel: input.visionAssets?.visionModel,
        assetLoader: input.visionAssets?.assetLoader,
        visionDescribePrompt: input.visionAssets?.visionDescribePrompt,
        onAttachmentDescriptions: (prepared.userMessage && input.attachments?.length)
          ? async (descriptions) => {
              await this.chatApp.updateAttachmentDescriptions(prepared.userMessage!.id, input.attachments!, descriptions);
            }
          : undefined,
      });
      reply = ensurePrefillInResponse(result.text, prefill);
      reasoning = result.reasoning;
      if (result.sentConfig) {
        this.chatRuntime.patchPendingTrace(brandId<ChatId>(input.chatId), { sentConfig: result.sentConfig });
      }
    } catch (err) {
      this.chatRuntime.discardPendingPromptTrace(brandId<ChatId>(input.chatId));
      throw err;
    }

    // Extract thinking tags from content (some models embed <thinking> in text)
    const { mainContent: sendText, reasoning: sendReasoning } = extractThinkingTags(reply, reasoning);
    reply = sendText;
    reasoning = sendReasoning;

    const latencyMs = Date.now() - startedAt;
    logSendDebug("live.send.provider.done", { chatId: input.chatId, latencyMs, replyLength: reply.length });
    const snapshot = await this.chatRuntime.appendAssistantReply(brandId<ChatId>(input.chatId), reply, latencyMs, {
      reasoning,
    });
    logSendDebug("live.send.append.done", { chatId: input.chatId, messageCount: snapshot.messages.length });
    this.notifyAssistantAppended(input.chatId, snapshot.messages[snapshot.messages.length - 1]?.id ?? "");

    return {
      preparedMessageCount: prepared.snapshot.messages.length,
      promptMessageCount: countPromptMessages(prepared.prompt),
      reply,
      snapshot,
    };
  }

  /** Non-streaming continue: assemble prompt without user message → execute → append reply. */
  async generateReply(input: {
    chatId: string;
    profile: StoredProviderProfileRecord;
    model: string;
    prefill?: string;
    signal?: AbortSignal;
  }): Promise<{
    promptMessageCount: number;
    reply: string;
    snapshot: MessageResponse;
  }> {
    const provider = await this.resolveProvider(input);
    logSendDebug("live.generateReply.start", { chatId: input.chatId, model: provider.model });
    const prompt = await this.chatRuntime.assemblePromptPreview(brandId<ChatId>(input.chatId), {
      model: provider.model,
      contextBudget: provider.profile.contextBudget,
      responseReserve: provider.profile.maxTokens,
    });
    const prefill = prompt.prefill ?? undefined;
    const startedAt = Date.now();
    let reply: string;
    let reasoning: string | undefined;
    try {
      const result = await nonstreamingProviderExecute({
        profile: provider.profile,
        model: provider.model,
        prompt,
        signal: input.signal,
        prefill,
      });
      reply = ensurePrefillInResponse(result.text, prefill);
      reasoning = result.reasoning;
      if (result.sentConfig) {
        this.chatRuntime.patchPendingTrace(brandId<ChatId>(input.chatId), { sentConfig: result.sentConfig });
      }
    } catch (err) {
      this.chatRuntime.discardPendingPromptTrace(brandId<ChatId>(input.chatId));
      throw err;
    }

    // Extract thinking tags from content (some models embed <thinking> in text)
    const { mainContent: genText, reasoning: genReasoning } = extractThinkingTags(reply, reasoning);
    reply = genText;
    reasoning = genReasoning;

    const latencyMs = Date.now() - startedAt;
    logSendDebug("live.generateReply.done", { chatId: input.chatId, latencyMs, replyLength: reply.length });
    const snapshot = await this.chatRuntime.appendAssistantReply(brandId<ChatId>(input.chatId), reply, latencyMs, {
      reasoning,
    });
    this.notifyAssistantAppended(input.chatId, snapshot.messages[snapshot.messages.length - 1]?.id ?? "");
    return {
      promptMessageCount: countPromptMessages(prompt),
      reply,
      snapshot,
    };
  }

  /** Non-streaming regenerate: exclude target message from prompt → execute → add as variant. */
  async regenerateMessage(input: {
    chatId: string;
    messageId: string;
    profile: StoredProviderProfileRecord;
    model: string;
    /**
     * Optional per-request prompt preset override (Wave Q1b). When set, the
     * assembled prompt uses this preset instead of the chat's `promptPresetId`,
     * WITHOUT mutating the chat row. Undefined → existing cascade (unchanged).
     * Wired into assemblePromptPreview in Q1b; accepted here from Q1a so the
     * adapter can thread it without a second signature change.
     */
    presetId?: PromptPresetId;
    prefill?: string;
    signal?: AbortSignal;
  }): Promise<{
    promptMessageCount: number;
    reply: string;
    snapshot: MessageResponse;
  }> {
    const provider = await this.resolveProvider(input);
    logSendDebug("live.regenerate.start", { chatId: input.chatId, messageId: input.messageId, model: provider.model });
    const prompt = await this.chatRuntime.assemblePromptPreview(brandId<ChatId>(input.chatId), {
      excludeMessageId: brandId<MessageId>(input.messageId),
      model: provider.model,
      contextBudget: provider.profile.contextBudget,
      responseReserve: provider.profile.maxTokens,
      presetId: input.presetId,
    });
    logSendDebug("live.regenerate.prompt.ready", {
      chatId: input.chatId,
      messageId: input.messageId,
      promptMessageCount: countPromptMessages(prompt),
    });
    const prefill = prompt.prefill ?? undefined;
    const startedAt = Date.now();
    logSendDebug("live.regenerate.provider.start", { chatId: input.chatId, providerId: provider.profile.id, model: provider.model });
    let reply: string;
    let reasoning: string | undefined;
    try {
      const result = await nonstreamingProviderExecute({
        profile: provider.profile,
        model: provider.model,
        prompt,
        signal: input.signal,
        prefill,
      });
      reply = ensurePrefillInResponse(result.text, prefill);
      reasoning = result.reasoning;
      if (result.sentConfig) {
        this.chatRuntime.patchPendingTrace(brandId<ChatId>(input.chatId), { sentConfig: result.sentConfig });
      }
    } catch (err) {
      this.chatRuntime.discardPendingPromptTrace(brandId<ChatId>(input.chatId));
      throw err;
    }

    // Extract thinking tags from content (some models embed <thinking> in text)
    const { mainContent: regenText, reasoning: regenReasoning } = extractThinkingTags(reply, reasoning);
    reply = regenText;
    reasoning = regenReasoning;

    const latencyMs = Date.now() - startedAt;
    logSendDebug("live.regenerate.provider.done", { chatId: input.chatId, latencyMs, replyLength: reply.length });
    const snapshot = await this.chatRuntime.appendMessageVariant(brandId<ChatId>(input.chatId), brandId<MessageId>(input.messageId), {
      content: reply,
      latencyMs,
      reasoning,
      presetId: input.presetId,
    });
    logSendDebug("live.regenerate.append.done", { chatId: input.chatId, messageId: input.messageId, messageCount: snapshot.messages.length });

    return {
      promptMessageCount: countPromptMessages(prompt),
      reply,
      snapshot,
    };
  }

  // ─── Streaming methods ────────────────────────────────────────────────

  /** Streaming send: prepare → execute stream → yield SSE events → append on finish/abort. */
  async *sendMessageStream(input: {
    chatId: string;
    content: string;
    attachments?: any[];
    profile: StoredProviderProfileRecord;
    model: string;
    prefill?: string;
    signal?: AbortSignal;
    visionAssets?: { cachedModels: any[]; visionModel: string | null; assetLoader: (assetId: string) => Promise<Buffer | null>; visionDescribePrompt?: string };
  }): AsyncGenerator<{ event: string; data: string }> {
    const provider = await this.resolveProvider(input);
    logSendDebug("live.send-stream.prepare.start", { chatId: input.chatId, model: provider.model });
    const prepared = await this.chatRuntime.prepareLiveTurn(brandId<ChatId>(input.chatId), input.content, provider.model, provider.profile.maxTokens, input.attachments);
    this.notifyUserMessageCreated(input.chatId, prepared.userMessage);
    const prefill = prepared.prompt.prefill ?? undefined;
    const onAttachmentDescriptions = (prepared.userMessage && input.attachments?.length)
      ? async (descriptions: Array<{ attachmentId: string; description: string }>) => {
          await this.chatApp.updateAttachmentDescriptions(prepared.userMessage!.id, input.attachments!, descriptions);
        }
      : undefined;
    const { streamResult, startedAt } = await this.startStream({ ...input, ...provider, onAttachmentDescriptions }, prepared.prompt);
    if (streamResult.sentConfig) { this.chatRuntime.patchPendingTrace(brandId<ChatId>(input.chatId), { sentConfig: streamResult.sentConfig }); }

    yield* this.drainStream({
      chatId: input.chatId,
      streamResult,
      signal: input.signal,
      startedAt,
      debugLabel: "live.send-stream",
      prefill,
      onAbort: async (text, reasoning, reasoningDurationMs, latencyMs) => {
        if (text) {
          await this.chatRuntime.appendAssistantReply(brandId<ChatId>(input.chatId), text, latencyMs, {
            reasoning: reasoning || undefined,
            reasoningDurationMs,
          });
          this.notifyAssistantAppended(input.chatId, "");
        }
      },
      onFinal: async (text, reasoning, reasoningDurationMs, latencyMs) => {
        const snapshot = await this.chatRuntime.appendAssistantReply(brandId<ChatId>(input.chatId), text, latencyMs, {
          reasoning,
          reasoningDurationMs,
        });
        logSendDebug("live.send-stream.done", { chatId: input.chatId, latencyMs, replyLength: text.length });
        this.notifyAssistantAppended(input.chatId, snapshot.messages[snapshot.messages.length - 1]?.id ?? "");
        return snapshot;
      },
    });
  }

  /** Streaming continue: assemble without user message → stream → append. */
  async *generateReplyStream(input: {
    chatId: string;
    profile: StoredProviderProfileRecord;
    model: string;
    prefill?: string;
    signal?: AbortSignal;
  }): AsyncGenerator<{ event: string; data: string }> {
    const provider = await this.resolveProvider(input);
    logSendDebug("live.generateReply-stream.start", { chatId: input.chatId, model: provider.model });
    const prompt = await this.chatRuntime.assemblePromptPreview(brandId<ChatId>(input.chatId), {
      model: provider.model,
      contextBudget: provider.profile.contextBudget,
      responseReserve: provider.profile.maxTokens,
    });
    const prefill = prompt.prefill ?? undefined;
    const { streamResult, startedAt } = await this.startStream({ ...input, ...provider }, prompt);
    if (streamResult.sentConfig) { this.chatRuntime.patchPendingTrace(brandId<ChatId>(input.chatId), { sentConfig: streamResult.sentConfig }); }

    yield* this.drainStream({
      chatId: input.chatId,
      streamResult,
      signal: input.signal,
      startedAt,
      debugLabel: "live.generateReply-stream",
      prefill,
      onAbort: async (text, reasoning, reasoningDurationMs, latencyMs) => {
        if (text) {
          await this.chatRuntime.appendAssistantReply(brandId<ChatId>(input.chatId), text, latencyMs, {
            reasoning: reasoning || undefined,
            reasoningDurationMs,
          });
          this.notifyAssistantAppended(input.chatId, "");
        }
      },
      onFinal: async (text, reasoning, reasoningDurationMs, latencyMs) => {
        const snapshot = await this.chatRuntime.appendAssistantReply(brandId<ChatId>(input.chatId), text, latencyMs, {
          reasoning,
          reasoningDurationMs,
        });
        logSendDebug("live.generateReply-stream.done", { chatId: input.chatId, latencyMs, replyLength: text.length });
        this.notifyAssistantAppended(input.chatId, snapshot.messages[snapshot.messages.length - 1]?.id ?? "");
        return snapshot;
      },
    });
  }

  /** Streaming regenerate: exclude target message → stream → add as variant. */
  async *regenerateMessageStream(input: {
    chatId: string;
    messageId: string;
    profile: StoredProviderProfileRecord;
    model: string;
    /** Optional per-request prompt preset override (Wave Q1b). See regenerateMessage. */
    presetId?: PromptPresetId;
    prefill?: string;
    signal?: AbortSignal;
  }): AsyncGenerator<{ event: string; data: string }> {
    const provider = await this.resolveProvider(input);
    logSendDebug("live.regenerate-stream.start", { chatId: input.chatId, messageId: input.messageId, model: provider.model });
    const prompt = await this.chatRuntime.assemblePromptPreview(brandId<ChatId>(input.chatId), {
      excludeMessageId: brandId<MessageId>(input.messageId),
      model: provider.model,
      contextBudget: provider.profile.contextBudget,
      responseReserve: provider.profile.maxTokens,
      presetId: input.presetId,
    });
    const prefill = prompt.prefill ?? undefined;
    const { streamResult, startedAt } = await this.startStream({ ...input, ...provider }, prompt);
    if (streamResult.sentConfig) { this.chatRuntime.patchPendingTrace(brandId<ChatId>(input.chatId), { sentConfig: streamResult.sentConfig }); }

    yield* this.drainStream({
      chatId: input.chatId,
      streamResult,
      signal: input.signal,
      startedAt,
      debugLabel: "live.regenerate-stream",
      omitMessageCountInFinish: true,
      prefill,
      onAbort: async (text, reasoning, reasoningDurationMs, latencyMs) => {
        if (text) {
          await this.chatRuntime.appendMessageVariant(brandId<ChatId>(input.chatId), brandId<MessageId>(input.messageId), {
            content: text,
            latencyMs,
            reasoning: reasoning || undefined,
            reasoningDurationMs,
            presetId: input.presetId,
          });
        }
      },
      onFinal: async (text, reasoning, reasoningDurationMs, latencyMs) => {
        const snapshot = await this.chatRuntime.appendMessageVariant(brandId<ChatId>(input.chatId), brandId<MessageId>(input.messageId), {
          content: text,
          latencyMs,
          reasoning,
          reasoningDurationMs,
          presetId: input.presetId,
        });
        logSendDebug("live.regenerate-stream.done", { chatId: input.chatId, messageId: input.messageId, latencyMs });
        return snapshot;
      },
    });
  }

  // ─── Shared streaming helpers ─────────────────────────────────────────

  /**
   * Starts a stream provider execution with error handling.
   * Discards the pending prompt trace on failure.
   */
  private async resolveProvider(input: {
    chatId: string;
    profile: StoredProviderProfileRecord;
    model: string;
  }): Promise<{ profile: StoredProviderProfileRecord; model: string }> {
    return this.strategy.resolveProvider(input);
  }

  private notifyUserMessageCreated(chatId: string, message?: { id: MessageId; content: string }): void {
    if (!message) return;
    this.events.emit("message.created", {
      chatId,
      messageId: message.id,
      role: "user",
      content: message.content,
    });
  }

  private notifyAssistantAppended(chatId: string, messageId: string): void {
    this.events.emit("message.appended", { chatId, messageId, role: "assistant" });
    // Delegate mode-specific post-append work (no-op for RP, future hooks for Novel/Group)
    void this.strategy.onMessageAppended({ chatId, messageId, events: this.events });
  }

  private async startStream(
    input: { chatId: string; profile: StoredProviderProfileRecord; model: string; signal?: AbortSignal; prefill?: string; visionAssets?: { cachedModels: any[]; visionModel: string | null; assetLoader: (assetId: string) => Promise<Buffer | null>; visionDescribePrompt?: string }; onAttachmentDescriptions?: ProviderExecutionInput["onAttachmentDescriptions"] },
    prompt: Parameters<typeof streamProviderExecutor>[0]["prompt"],
  ): Promise<{ streamResult: ProviderStreamResult; startedAt: number }> {
    const startedAt = Date.now();
    try {
      const streamResult = await streamProviderExecutor({
        profile: input.profile,
        model: input.model,
        prompt,
        signal: input.signal,
        prefill: input.prefill ?? (prompt as { prefill?: string }).prefill ?? undefined,
        cachedModels: input.visionAssets?.cachedModels,
        visionModel: input.visionAssets?.visionModel,
        assetLoader: input.visionAssets?.assetLoader,
        visionDescribePrompt: input.visionAssets?.visionDescribePrompt,
        onAttachmentDescriptions: input.onAttachmentDescriptions,
      });
      return { streamResult, startedAt };
    } catch (err) {
      this.chatRuntime.discardPendingPromptTrace(brandId<ChatId>(input.chatId));
      throw err;
    }
  }

  /**
   * Drains a provider stream: collects text and reasoning chunks,
   * handles aborts via `onAbort`, saves the final result via `onFinal`,
   * and yields SSE events (text-delta, reasoning-delta, reasoning-done, finish).
   */
  private async *drainStream(input: {
    chatId: string;
    streamResult: ProviderStreamResult;
    signal?: AbortSignal | undefined;
    startedAt: number;
    debugLabel: string;
    omitMessageCountInFinish?: boolean;
    prefill?: string;
    onAbort: (text: string, reasoning: string, reasoningDurationMs: number | undefined, latencyMs: number) => Promise<void>;
    onFinal: (text: string, reasoning: string | undefined, reasoningDurationMs: number | undefined, latencyMs: number) => Promise<MessageResponse>;
  }): AsyncGenerator<{ event: string; data: string }> {
    const { streamResult, signal, startedAt, debugLabel, onAbort, onFinal, omitMessageCountInFinish, prefill } = input;

    let textAccumulator = "";
    let reasoningAccumulator = "";
    let reasoningStartMs: number | null = null;
    let reasoningDurationMs: number | null = null;

    // ── Collect stream chunks ──
    try {
      for await (const chunk of streamResult.stream) {
        if (signal?.aborted) {
          const latencyMs = Date.now() - startedAt;
          const { mainContent: abortText, reasoning: abortReasoning } = extractThinkingTags(textAccumulator, reasoningAccumulator);
          await onAbort(
            abortText,
            abortReasoning ?? "",
            reasoningStartMs ? Date.now() - reasoningStartMs : undefined,
            latencyMs,
          );
          yield { event: "abort", data: JSON.stringify({ partialLength: textAccumulator.length }) };
          return;
        }
        if (chunk.type === "text-delta" && chunk.delta) {
          if (reasoningStartMs && reasoningAccumulator) {
            reasoningDurationMs = Date.now() - reasoningStartMs;
          }
          textAccumulator += chunk.delta;
          yield { event: "text-delta", data: JSON.stringify({ delta: chunk.delta }) };
        }
        if (chunk.type === "reasoning-delta") {
          if (!reasoningStartMs) reasoningStartMs = Date.now();
          reasoningAccumulator += chunk.textDelta;
          yield { event: "reasoning-delta", data: JSON.stringify({ delta: chunk.textDelta }) };
        }
        if (chunk.type === "tool-call") {
          yield { event: "tool-call", data: JSON.stringify({ toolCallId: chunk.toolCallId, toolName: chunk.toolName }) };
        }
        if (chunk.type === "tool-result") {
          yield { event: "tool-result", data: JSON.stringify({ toolCallId: chunk.toolCallId, toolName: chunk.toolName, isError: chunk.isError ?? false }) };
        }
      }
    } catch (err) {
      if (signal?.aborted) {
        const latencyMs = Date.now() - startedAt;
        const { mainContent: abortText, reasoning: abortReasoning } = extractThinkingTags(textAccumulator, reasoningAccumulator);
        await onAbort(
          abortText,
          abortReasoning ?? "",
          reasoningStartMs ? Date.now() - reasoningStartMs : undefined,
          latencyMs,
        );
        yield { event: "abort", data: JSON.stringify({ partialLength: textAccumulator.length }) };
        return;
      }

      const message = extractProviderErrorMessage(err);
      logSendDebug(`${debugLabel}.provider-error`, { chatId: input.chatId, message });
      this.chatRuntime.discardPendingPromptTrace(brandId<ChatId>(input.chatId));
      yield { event: "error", data: JSON.stringify({ message }) };
      return;
    }

    if (signal?.aborted) {
      const latencyMs = Date.now() - startedAt;
      const { mainContent: abortText, reasoning: abortReasoning } = extractThinkingTags(textAccumulator, reasoningAccumulator);
      await onAbort(
        abortText,
        abortReasoning ?? "",
        reasoningStartMs ? Date.now() - reasoningStartMs : undefined,
        latencyMs,
      );
      yield { event: "abort", data: JSON.stringify({ partialLength: textAccumulator.length }) };
      return;
    }

    // ── Finalize ──
    const latencyMs = Date.now() - startedAt;
    let finish: Awaited<typeof streamResult.finished>;
    try {
      finish = await streamResult.finished;
    } catch {
      finish = { finishReason: "error" } as Awaited<typeof streamResult.finished>;
    }
    let rawText: string;
    try {
      rawText = textAccumulator || (await streamResult.text);
    } catch {
      rawText = textAccumulator;
    }
    let rawReasoning: string | undefined;
    try {
      rawReasoning = reasoningAccumulator || (await streamResult.reasoning) || undefined;
    } catch {
      rawReasoning = reasoningAccumulator || undefined;
    }

    // Some providers return <thinking> tags in content instead of reasoning_content
    const textWithPrefill = ensurePrefillInResponse(rawText, prefill);
    const { mainContent: finalText, reasoning: finalReasoning } = extractThinkingTags(textWithPrefill, rawReasoning);

    if (reasoningStartMs && reasoningDurationMs === null) {
      reasoningDurationMs = Date.now() - reasoningStartMs;
    }

    const snapshot = await onFinal(finalText, finalReasoning, reasoningDurationMs ?? undefined, latencyMs);

    // ── Yield reasoning-done + finish ──
    if (reasoningAccumulator || streamResult.hasRedactedReasoning) {
      yield {
        event: "reasoning-done",
        data: JSON.stringify({
          durationMs: reasoningDurationMs,
          redacted: streamResult.hasRedactedReasoning,
        }),
      };
    }

    const finishData: Record<string, unknown> = {
      finishReason: finish.finishReason,
      usage: finish.usage,
    };
    if (!omitMessageCountInFinish) {
      finishData.messageCount = snapshot.messages.length;
    }
    yield { event: "finish", data: JSON.stringify(finishData) };
  }
}

/** Extracts the message count from a prompt's finalPayload. */
function countPromptMessages(prompt: { finalPayload?: unknown }): number {
  const payload = prompt.finalPayload as { messages?: unknown };
  return Array.isArray(payload?.messages) ? payload.messages.length : 0;
}
