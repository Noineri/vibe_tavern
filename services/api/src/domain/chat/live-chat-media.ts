import type { AssemblePromptResponse, Attachment } from "@vibe-tavern/domain";
import type { ProviderExecutionInput } from "../../infrastructure/ai/provider-execution-types.js";
import type { LiveChatMediaInput } from "./live-chat-send-input.js";

/** The executor-facing projection of the send path's media dependencies. */
export function visionExecutionOptions(input: LiveChatMediaInput) {
  return {
    cachedModels: input.visionAssets?.cachedModels,
    visionModel: input.visionAssets?.visionModel,
    assetLoader: input.visionAssets?.assetLoader,
    visionDescribePrompt: input.visionAssets?.visionDescribePrompt,
    voiceTranscriber: input.voiceTranscriber,
  };
}

/** Structural so fallback code never imports the runtime or API layer. */
export interface AttachmentDescriptionWriter {
  updateSingleAttachmentDescription(messageId: string, attachmentId: string, description: string): Promise<void>;
}

/** The assembled prompt already identifies each visible history attachment's
 *  owning message. Persist through the existing variant-aware single writer;
 *  never rewrite a stale attachment set or guess an owner from the reply. */
export function historyAttachmentDescriptions(
  prompt: AssemblePromptResponse,
  writer?: AttachmentDescriptionWriter,
): ProviderExecutionInput["onAttachmentDescriptions"] {
  if (!writer) return undefined;
  const owners = new Map<string, string>();
  const payload = prompt.finalPayload as { messages?: unknown } | undefined;
  for (const record of Array.isArray(payload?.messages) ? payload.messages : []) {
    if (!record || typeof record !== "object") continue;
    const message = record as { role?: unknown; messageId?: unknown; attachments?: Attachment[] };
    if (message.role !== "user" || typeof message.messageId !== "string" || !Array.isArray(message.attachments)) continue;
    for (const attachment of message.attachments) owners.set(attachment.id, message.messageId);
  }
  if (owners.size === 0) return undefined;
  return async (descriptions) => {
    for (const { attachmentId, description } of descriptions) {
      const messageId = owners.get(attachmentId);
      if (messageId) await writer.updateSingleAttachmentDescription(messageId, attachmentId, description);
    }
  };
}

export function replyExecutionOptions(input: LiveChatMediaInput, prompt: AssemblePromptResponse, writer?: AttachmentDescriptionWriter) {
  const onAttachmentDescriptions = historyAttachmentDescriptions(prompt, writer);
  return { ...visionExecutionOptions(input), ...(onAttachmentDescriptions ? { onAttachmentDescriptions } : {}) };
}
