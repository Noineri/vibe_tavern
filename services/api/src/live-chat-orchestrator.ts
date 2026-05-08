import { brandId } from "@rp-platform/domain";
import type { ChatId, MessageId } from "@rp-platform/domain";
import type { ChatRuntime } from "./session-runtime-chat.js";
import type { SessionSnapshot } from "./session-runtime.js";
import type { ProviderOrchestrator } from "./provider-orchestrator.js";
import type { StoredProviderProfileRecord } from "./session-runtime-dto.js";
import { nonstreamingProviderExecute } from "./ai/nonstreaming-provider-executor.js";
import { streamProviderExecutor } from "./ai/stream-provider-executor.js";
import { logSendDebug } from "./send-debug-log.js";

export class LiveChatOrchestrator {
  constructor(
    private readonly chatRuntime: ChatRuntime,
    private readonly providers: ProviderOrchestrator,
  ) {}

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
    const prepared = await this.chatRuntime.prepareLiveTurn(brandId<ChatId>(input.chatId), input.content, input.model);
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

  async *sendMessageStream(input: {
    chatId: string;
    content: string;
    profile: StoredProviderProfileRecord;
    model: string;
    prefill?: string;
    signal?: AbortSignal;
  }): AsyncGenerator<{ event: string; data: string }> {
    logSendDebug("live.send-stream.prepare.start", { chatId: input.chatId, model: input.model });
    const prepared = await this.chatRuntime.prepareLiveTurn(brandId<ChatId>(input.chatId), input.content, input.model);
    const startedAt = Date.now();

    let streamResult;
    try {
      streamResult = await streamProviderExecutor({
        profile: input.profile,
        model: input.model,
        prompt: prepared.prompt,
        signal: input.signal,
        prefill: prepared.prompt.prefill ?? undefined,
      });
    } catch (err) {
      this.chatRuntime.discardPendingPromptTrace(brandId<ChatId>(input.chatId));
      throw err;
    }

    let collected = "";
    try {
      for await (const chunk of streamResult.stream) {
        if (chunk.type === "text-delta" && chunk.delta) {
          collected += chunk.delta;
          yield { event: "text-delta", data: JSON.stringify({ delta: chunk.delta }) };
        }
      }
    } catch (err) {
      if (input.signal?.aborted) {
        // Abort — save partial text
        const latencyMs = Date.now() - startedAt;
        if (collected) {
          await this.chatRuntime.appendAssistantReply(brandId<ChatId>(input.chatId), collected, latencyMs);
        }
        yield { event: "abort", data: JSON.stringify({ partialLength: collected.length }) };
        return;
      }
      throw err;
    }

    const latencyMs = Date.now() - startedAt;
    const finish = await streamResult.finished;
    const finalText = (await streamResult.text) || collected;

    const snapshot = await this.chatRuntime.appendAssistantReply(brandId<ChatId>(input.chatId), finalText, latencyMs);
    logSendDebug("live.send-stream.done", { chatId: input.chatId, latencyMs, replyLength: finalText.length });

    yield {
      event: "finish",
      data: JSON.stringify({
        finishReason: finish.finishReason,
        usage: finish.usage,
        messageCount: snapshot.messages.length,
      }),
    };
  }

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
    });
    const startedAt = Date.now();

    let streamResult;
    try {
      streamResult = await streamProviderExecutor({
        profile: input.profile,
        model: input.model,
        prompt,
        signal: input.signal,
        prefill: prompt.prefill ?? undefined,
      });
    } catch (err) {
      this.chatRuntime.discardPendingPromptTrace(brandId<ChatId>(input.chatId));
      throw err;
    }

    let collected = "";
    try {
      for await (const chunk of streamResult.stream) {
        if (chunk.type === "text-delta" && chunk.delta) {
          collected += chunk.delta;
          yield { event: "text-delta", data: JSON.stringify({ delta: chunk.delta }) };
        }
      }
    } catch (err) {
      if (input.signal?.aborted) {
        const latencyMs = Date.now() - startedAt;
        if (collected) {
          await this.chatRuntime.appendMessageVariant(brandId<ChatId>(input.chatId), brandId<MessageId>(input.messageId), {
            content: collected,
            latencyMs,
          });
        }
        yield { event: "abort", data: JSON.stringify({ partialLength: collected.length }) };
        return;
      }
      throw err;
    }

    const latencyMs = Date.now() - startedAt;
    const finish = await streamResult.finished;
    const finalText = (await streamResult.text) || collected;

    await this.chatRuntime.appendMessageVariant(brandId<ChatId>(input.chatId), brandId<MessageId>(input.messageId), {
      content: finalText,
      latencyMs,
    });
    logSendDebug("live.regenerate-stream.done", { chatId: input.chatId, messageId: input.messageId, latencyMs });

    yield {
      event: "finish",
      data: JSON.stringify({
        finishReason: finish.finishReason,
        usage: finish.usage,
      }),
    };
  }
}

function countPromptMessages(prompt: { finalPayload?: unknown }): number {
  const payload = prompt.finalPayload as { messages?: unknown };
  return Array.isArray(payload?.messages) ? payload.messages.length : 0;
}
