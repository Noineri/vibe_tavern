// forks: 1 — experience-copilot-attachment-actions.ts (agent ownership/profile ladder).
import type { MessageStore } from "@vibe-tavern/db";
import type { StoredProviderProfileRecord } from "@vibe-tavern/domain";
import type { ChatApplicationService } from "../../domain/chat/chat-application-service.js";
import { clearSummary, setIncluded, summarize, type AttachmentMessagePort } from "../../domain/attachment/attachment-actions-service.js";
import { nonstreamingProviderExecute } from "../../infrastructure/ai/nonstreaming-provider-executor.js";
import { buildOneShotPrompt } from "../../infrastructure/ai/one-shot-prompt.js";
import type { ProviderExecutionInput } from "../../infrastructure/ai/provider-execution-types.js";
import type { AttachmentAssetLoader } from "../../infrastructure/ai/vision-gate.js";
import { notFound } from "../../shared/errors.js";

/** Same executor seam as the one-shot delegates; production uses the real
 * provider boundary, while route tests inject only the external model call. */
export type AttachmentSummaryExecutor = (input: ProviderExecutionInput) => Promise<{ text: string }>;

export function createChatAttachmentActions(deps: {
  chatApp: Pick<ChatApplicationService, "findAttachment" | "updateSingleAttachment">;
  messages: Pick<MessageStore, "getMessageById">;
  resolveProfile: (chatId: string) => Promise<{ profile: StoredProviderProfileRecord & { defaultModel: string } }>;
  assetLoader: AttachmentAssetLoader;
  execute?: AttachmentSummaryExecutor;
}) {
  const port: AttachmentMessagePort = {
    find: (messageId, attachmentId) => deps.chatApp.findAttachment(messageId, attachmentId),
    update: (messageId, attachmentId, patch) => deps.chatApp.updateSingleAttachment(messageId, attachmentId, patch),
  };
  const execute = deps.execute ?? nonstreamingProviderExecute;
  async function requireMessage(chatId: string, messageId: string) {
    const message = await deps.messages.getMessageById(messageId);
    if (!message || (chatId !== "_" && message.chatId !== chatId)) throw notFound("Message");
    return message;
  }
  return {
    async summarizeAttachment(chatId: string, messageId: string, attachmentId: string, signal?: AbortSignal) {
      const message = await requireMessage(chatId, messageId);
      const { profile } = await deps.resolveProfile(message.chatId);
      return summarize(port, {
        messageId, attachmentId, signal, assetLoader: deps.assetLoader,
        generate: async ({ systemPrompt, text, signal }) => (await execute({
          profile, model: profile.defaultModel, prompt: buildOneShotPrompt(systemPrompt, text), signal,
        })).text,
      });
    },
    async clearAttachmentSummary(chatId: string, messageId: string, attachmentId: string) {
      await requireMessage(chatId, messageId);
      return clearSummary(port, { messageId, attachmentId });
    },
    async setIncluded(messageId: string, attachmentId: string, included: boolean) {
      await setIncluded(port, { messageId, attachmentId, included });
      return { ok: true };
    },
  };
}
