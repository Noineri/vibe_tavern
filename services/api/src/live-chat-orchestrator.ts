import type { SessionRuntime, SessionSnapshot } from "./session-runtime.js";
import type { ProviderOrchestrator } from "./provider-orchestrator.js";
import { logSendDebug } from "./send-debug-log.js";

interface StoredProviderProfileRecord {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  apiKey: string | null;
  defaultModel?: string | null;
  contextBudget?: number | null;
  maxTokens?: number | null;
  temperature?: number | null;
  topP?: number | null;
  minP?: number | null;
  topK?: number | null;
  typicalP?: number | null;
  repPen?: number | null;
  freqPen?: number | null;
  presPen?: number | null;
  stopSeq?: string | null;
  seed?: number | string | null;
  reasoningEffort?: string | null;
}

export class LiveChatOrchestrator {
  constructor(
    private readonly runtime: SessionRuntime,
    private readonly providers: ProviderOrchestrator,
  ) {}

  async sendMessage(input: {
    chatId: string;
    content: string;
    profile: StoredProviderProfileRecord;
    model: string;
  }): Promise<{
    preparedMessageCount: number;
    promptMessageCount: number;
    reply: string;
    snapshot: SessionSnapshot;
  }> {
    logSendDebug("live.send.prepare.start", { chatId: input.chatId, model: input.model });
    const prepared = this.runtime.prepareLiveTurn(input.chatId, input.content, input.model);
    logSendDebug("live.send.prepare.done", {
      chatId: input.chatId,
      snapshotMessageCount: prepared.snapshot.messages.length,
      promptMessageCount: countPromptMessages(prepared.prompt),
    });
    const startedAt = Date.now();
    logSendDebug("live.send.provider.start", { chatId: input.chatId, providerId: input.profile.id, model: input.model });
    const reply = await this.providers.generateProfileReply(input.profile, {
      model: input.model,
      prompt: prepared.prompt,
    });
    const latencyMs = Date.now() - startedAt;
    logSendDebug("live.send.provider.done", { chatId: input.chatId, latencyMs, replyLength: reply.length });
    const snapshot = this.runtime.appendAssistantReply(input.chatId, reply, latencyMs);
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
  }): Promise<{
    promptMessageCount: number;
    reply: string;
    snapshot: SessionSnapshot;
  }> {
    logSendDebug("live.regenerate.start", { chatId: input.chatId, messageId: input.messageId, model: input.model });
    const prompt = this.runtime.assemblePromptPreview(input.chatId, {
      excludeMessageId: input.messageId,
      model: input.model,
    });
    logSendDebug("live.regenerate.prompt.ready", {
      chatId: input.chatId,
      messageId: input.messageId,
      promptMessageCount: countPromptMessages(prompt),
    });
    const startedAt = Date.now();
    logSendDebug("live.regenerate.provider.start", { chatId: input.chatId, providerId: input.profile.id, model: input.model });
    const reply = await this.providers.generateProfileReply(input.profile, {
      model: input.model,
      prompt,
    });
    const latencyMs = Date.now() - startedAt;
    logSendDebug("live.regenerate.provider.done", { chatId: input.chatId, latencyMs, replyLength: reply.length });
    const snapshot = this.runtime.appendMessageVariant(input.chatId, input.messageId, {
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
}

function countPromptMessages(prompt: { finalPayload?: unknown }): number {
  const payload = prompt.finalPayload as { messages?: unknown };
  return Array.isArray(payload?.messages) ? payload.messages.length : 0;
}
