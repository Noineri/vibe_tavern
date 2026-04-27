import type { SessionRuntime, SessionSnapshot } from "./session-runtime.js";
import type { ProviderOrchestrator } from "./provider-orchestrator.js";

interface StoredProviderProfileRecord {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  apiKey: string | null;
  defaultModel?: string | null;
  contextBudget?: number | null;
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
    const prepared = this.runtime.prepareLiveTurn(input.chatId, input.content, input.model);
    const startedAt = Date.now();
    const reply = await this.providers.generateProfileReply(input.profile, {
      model: input.model,
      prompt: prepared.prompt,
    });
    const latencyMs = Date.now() - startedAt;
    const snapshot = this.runtime.appendAssistantReply(input.chatId, reply, latencyMs);

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
    const prompt = this.runtime.assemblePromptPreview(input.chatId, {
      excludeMessageId: input.messageId,
      model: input.model,
    });
    const startedAt = Date.now();
    const reply = await this.providers.generateProfileReply(input.profile, {
      model: input.model,
      prompt,
    });
    const latencyMs = Date.now() - startedAt;
    const snapshot = this.runtime.appendMessageVariant(input.chatId, input.messageId, {
      content: reply,
      latencyMs,
    });

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
