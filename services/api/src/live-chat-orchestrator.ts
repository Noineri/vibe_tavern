import { brandId } from "@rp-platform/domain";
import type { ChatId, MessageId } from "@rp-platform/domain";
import type { ChatRuntime } from "./session-runtime-chat.js";
import type { SessionSnapshot } from "./session-runtime.js";
import type { ProviderOrchestrator } from "./provider-orchestrator.js";
import type { StoredProviderProfileRecord } from "@rp-platform/domain";
import type { ProviderStreamResult } from "./ai/provider-execution-types.js";
import type { RawToolCall } from "./ai/provider-execution-types.js";
import type { ExecutedToolCall } from "./ai/tool-registry.js";
import { ToolRegistry } from "./ai/tool-registry.js";
import { executeToolCalls } from "./ai/tool-executor.js";
import { nonstreamingProviderExecute } from "./ai/nonstreaming-provider-executor.js";
import { streamProviderExecutor } from "./ai/stream-provider-executor.js";
import { logSendDebug } from "./send-debug-log.js";
import { extractThinkingTags } from "./ai/extract-thinking-tags.js";

/**
 * Coordinates the prepare → execute → append cycle for all AI generation paths:
 * send, generate (continue), regenerate — each with streaming and non-streaming variants.
 *
 * Delegates prompt assembly to {@link ChatRuntime} and AI execution to the provider layer.
 */
export class LiveChatOrchestrator {
  constructor(
    private readonly chatRuntime: ChatRuntime,
    private readonly providers: ProviderOrchestrator,
    private readonly toolRegistry: ToolRegistry = new ToolRegistry(),
  ) {}

  // ─── Non-streaming methods ────────────────────────────────────────────

  /** Non-streaming send: prepare → execute → append reply → return snapshot. */
  async sendMessage(input: {
    chatId: string;
    content: string;
    profile: StoredProviderProfileRecord;
    model: string;
    prefill?: string;
    signal?: AbortSignal;
  }): Promise<{
    preparedMessageCount: number;
    promptMessageCount: number;
    reply: string;
    snapshot: SessionSnapshot;
  }> {
    logSendDebug("live.send.prepare.start", { chatId: input.chatId, model: input.model });
    const prepared = await this.chatRuntime.prepareLiveTurn(brandId<ChatId>(input.chatId), input.content, input.model, input.profile.maxTokens);
    logSendDebug("live.send.prepare.done", {
      chatId: input.chatId,
      snapshotMessageCount: prepared.snapshot.messages.length,
      promptMessageCount: countPromptMessages(prepared.prompt),
    });
    const startedAt = Date.now();
    logSendDebug("live.send.provider.start", { chatId: input.chatId, providerId: input.profile.id, model: input.model });
    let reply: string;
    try {
      // TODO FW-AI5: when stream preference is true, forward the stream as SSE instead of collecting
      const result = await nonstreamingProviderExecute({
        profile: input.profile,
        model: input.model,
        prompt: prepared.prompt,
        signal: input.signal,
        prefill: prepared.prompt.prefill ?? undefined,
      });
      reply = result.text;
    } catch (err) {
      this.chatRuntime.discardPendingPromptTrace(brandId<ChatId>(input.chatId));
      throw err;
    }
    const latencyMs = Date.now() - startedAt;
    logSendDebug("live.send.provider.done", { chatId: input.chatId, latencyMs, replyLength: reply.length });
    const snapshot = await this.chatRuntime.appendAssistantReply(brandId<ChatId>(input.chatId), reply, latencyMs);
    logSendDebug("live.send.append.done", { chatId: input.chatId, messageCount: snapshot.messages.length });

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
    snapshot: SessionSnapshot;
  }> {
    logSendDebug("live.generateReply.start", { chatId: input.chatId, model: input.model });
    const prompt = await this.chatRuntime.assemblePromptPreview(brandId<ChatId>(input.chatId), {
      model: input.model,
      contextBudget: input.profile.contextBudget,
      responseReserve: input.profile.maxTokens,
    });
    const startedAt = Date.now();
    let reply: string;
    try {
      const result = await nonstreamingProviderExecute({
        profile: input.profile,
        model: input.model,
        prompt,
        signal: input.signal,
        prefill: prompt.prefill ?? undefined,
      });
      reply = result.text;
    } catch (err) {
      this.chatRuntime.discardPendingPromptTrace(brandId<ChatId>(input.chatId));
      throw err;
    }
    const latencyMs = Date.now() - startedAt;
    logSendDebug("live.generateReply.done", { chatId: input.chatId, latencyMs, replyLength: reply.length });
    const snapshot = await this.chatRuntime.appendAssistantReply(brandId<ChatId>(input.chatId), reply, latencyMs);
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
    prefill?: string;
    signal?: AbortSignal;
  }): Promise<{
    promptMessageCount: number;
    reply: string;
    snapshot: SessionSnapshot;
  }> {
    logSendDebug("live.regenerate.start", { chatId: input.chatId, messageId: input.messageId, model: input.model });
    const prompt = await this.chatRuntime.assemblePromptPreview(brandId<ChatId>(input.chatId), {
      excludeMessageId: brandId<MessageId>(input.messageId),
      model: input.model,
      contextBudget: input.profile.contextBudget,
      responseReserve: input.profile.maxTokens,
    });
    logSendDebug("live.regenerate.prompt.ready", {
      chatId: input.chatId,
      messageId: input.messageId,
      promptMessageCount: countPromptMessages(prompt),
    });
    const startedAt = Date.now();
    logSendDebug("live.regenerate.provider.start", { chatId: input.chatId, providerId: input.profile.id, model: input.model });
    let reply: string;
    try {
      const result = await nonstreamingProviderExecute({
        profile: input.profile,
        model: input.model,
        prompt,
        signal: input.signal,
        prefill: prompt.prefill ?? undefined,
      });
      reply = result.text;
    } catch (err) {
      this.chatRuntime.discardPendingPromptTrace(brandId<ChatId>(input.chatId));
      throw err;
    }
    const latencyMs = Date.now() - startedAt;
    logSendDebug("live.regenerate.provider.done", { chatId: input.chatId, latencyMs, replyLength: reply.length });
    const snapshot = await this.chatRuntime.appendMessageVariant(brandId<ChatId>(input.chatId), brandId<MessageId>(input.messageId), {
      content: reply,
      latencyMs,
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
    profile: StoredProviderProfileRecord;
    model: string;
    prefill?: string;
    signal?: AbortSignal;
  }): AsyncGenerator<{ event: string; data: string }> {
    logSendDebug("live.send-stream.prepare.start", { chatId: input.chatId, model: input.model });
    const prepared = await this.chatRuntime.prepareLiveTurn(brandId<ChatId>(input.chatId), input.content, input.model, input.profile.maxTokens);
    const { streamResult, startedAt } = await this.startStream(input, prepared.prompt);

    yield* this.drainStream({
      chatId: input.chatId,
      streamResult,
      signal: input.signal,
      startedAt,
      debugLabel: "live.send-stream",
      onAbort: async (text, reasoning, reasoningDurationMs, latencyMs) => {
        if (text) {
          await this.chatRuntime.appendAssistantReply(brandId<ChatId>(input.chatId), text, latencyMs, {
            reasoning: reasoning || undefined,
            reasoningDurationMs,
          });
        }
      },
      onFinal: async (text, reasoning, reasoningDurationMs, latencyMs) => {
        const snapshot = await this.chatRuntime.appendAssistantReply(brandId<ChatId>(input.chatId), text, latencyMs, {
          reasoning,
          reasoningDurationMs,
        });
        logSendDebug("live.send-stream.done", { chatId: input.chatId, latencyMs, replyLength: text.length });
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
    logSendDebug("live.generateReply-stream.start", { chatId: input.chatId, model: input.model });
    const prompt = await this.chatRuntime.assemblePromptPreview(brandId<ChatId>(input.chatId), {
      model: input.model,
      contextBudget: input.profile.contextBudget,
      responseReserve: input.profile.maxTokens,
    });
    const { streamResult, startedAt } = await this.startStream(input, prompt);

    yield* this.drainStream({
      chatId: input.chatId,
      streamResult,
      signal: input.signal,
      startedAt,
      debugLabel: "live.generateReply-stream",
      onAbort: async (text, reasoning, reasoningDurationMs, latencyMs) => {
        if (text) {
          await this.chatRuntime.appendAssistantReply(brandId<ChatId>(input.chatId), text, latencyMs, {
            reasoning: reasoning || undefined,
            reasoningDurationMs,
          });
        }
      },
      onFinal: async (text, reasoning, reasoningDurationMs, latencyMs) => {
        const snapshot = await this.chatRuntime.appendAssistantReply(brandId<ChatId>(input.chatId), text, latencyMs, {
          reasoning,
          reasoningDurationMs,
        });
        logSendDebug("live.generateReply-stream.done", { chatId: input.chatId, latencyMs, replyLength: text.length });
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
    prefill?: string;
    signal?: AbortSignal;
  }): AsyncGenerator<{ event: string; data: string }> {
    logSendDebug("live.regenerate-stream.start", { chatId: input.chatId, messageId: input.messageId, model: input.model });
    const prompt = await this.chatRuntime.assemblePromptPreview(brandId<ChatId>(input.chatId), {
      excludeMessageId: brandId<MessageId>(input.messageId),
      model: input.model,
      contextBudget: input.profile.contextBudget,
      responseReserve: input.profile.maxTokens,
    });
    const { streamResult, startedAt } = await this.startStream(input, prompt);

    yield* this.drainStream({
      chatId: input.chatId,
      streamResult,
      signal: input.signal,
      startedAt,
      debugLabel: "live.regenerate-stream",
      omitMessageCountInFinish: true,
      onAbort: async (text, reasoning, reasoningDurationMs, latencyMs) => {
        if (text) {
          await this.chatRuntime.appendMessageVariant(brandId<ChatId>(input.chatId), brandId<MessageId>(input.messageId), {
            content: text,
            latencyMs,
            reasoning: reasoning || undefined,
            reasoningDurationMs,
          });
        }
      },
      onFinal: async (text, reasoning, reasoningDurationMs, latencyMs) => {
        const snapshot = await this.chatRuntime.appendMessageVariant(brandId<ChatId>(input.chatId), brandId<MessageId>(input.messageId), {
          content: text,
          latencyMs,
          reasoning,
          reasoningDurationMs,
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
  private async startStream(
    input: { chatId: string; profile: StoredProviderProfileRecord; model: string; signal?: AbortSignal; prefill?: string },
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
    onAbort: (text: string, reasoning: string, reasoningDurationMs: number | undefined, latencyMs: number) => Promise<void>;
    onFinal: (text: string, reasoning: string | undefined, reasoningDurationMs: number | undefined, latencyMs: number) => Promise<SessionSnapshot>;
  }): AsyncGenerator<{ event: string; data: string }> {
    const { streamResult, signal, startedAt, debugLabel, onAbort, onFinal, omitMessageCountInFinish } = input;

    let textAccumulator = "";
    let reasoningAccumulator = "";
    let reasoningStartMs: number | null = null;
    let reasoningDurationMs: number | null = null;
    const pendingToolCalls: RawToolCall[] = [];

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
          if (!reasoningStartMs && reasoningAccumulator) {
            reasoningDurationMs = Date.now() - reasoningStartMs!;
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
          pendingToolCalls.push({ toolCallId: chunk.toolCallId, toolName: chunk.toolName, args: chunk.args });
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
      throw err;
    }

    // ── Finalize ──
    const latencyMs = Date.now() - startedAt;
    const finish = await streamResult.finished;
    const rawText = textAccumulator || (await streamResult.text);
    const rawReasoning = reasoningAccumulator || (await streamResult.reasoning) || undefined;

    // Some providers return <thinking> tags in content instead of reasoning_content
    const { mainContent: finalText, reasoning: finalReasoning } = extractThinkingTags(rawText, rawReasoning);

    if (reasoningStartMs && reasoningDurationMs === null) {
      reasoningDurationMs = Date.now() - reasoningStartMs;
    }

    const snapshot = await onFinal(finalText, finalReasoning, reasoningDurationMs ?? undefined, latencyMs);

    // ── Execute tool calls if present ──
    const toolCallsToExecute = pendingToolCalls.length > 0
      ? pendingToolCalls
      : streamResult.toolCalls;

    if (finish.finishReason === "tool-calls" && toolCallsToExecute.length > 0 && this.toolRegistry.size > 0) {
      const executed = await executeToolCalls(toolCallsToExecute, this.toolRegistry);
      yield {
        event: "tool-calls",
        data: JSON.stringify({
          calls: executed.map((tc) => ({
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            isError: tc.result.isError ?? false,
            latencyMs: tc.latencyMs,
          })),
        }),
      };
      logSendDebug(`${debugLabel}.tool-calls.executed`, {
        chatId: input.chatId,
        count: executed.length,
        errors: executed.filter((tc) => tc.result.isError).length,
      });
    }

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
