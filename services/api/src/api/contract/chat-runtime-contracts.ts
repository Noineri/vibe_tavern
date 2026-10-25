import type { CoauthorEditorState, RegenerateOverride } from "@vibe-tavern/api-contracts";
import type { Attachment, ImageRoute } from "@vibe-tavern/domain";
import type { MessageResponse, VariantResponse } from "./session-types.js";

/** Validated HTTP send body retained by both live-send adapter methods. */
export interface ChatSendBody {
  content: string;
  attachments?: Attachment[];
  diceMode?: "normal" | "immersive";
  pendingRevision?: number;
  prefill?: string;
  coauthorEditorState?: CoauthorEditorState;
}

/** Message mutation segment of the route/runtime contract. */
export interface ChatMessageRuntimeApi {
  getImageRoute: (chatId: string) => Promise<{ route: ImageRoute }>;
  sendMessage: (chatId: string, body: ChatSendBody, signal?: AbortSignal) => Promise<MessageResponse>;
  sendMessageStream: (chatId: string, body: ChatSendBody, signal?: AbortSignal) => AsyncIterable<{ event: string; data: string }>;
  regenerateMessage: (chatId: string, messageId: string, override: RegenerateOverride, signal?: AbortSignal) => Promise<MessageResponse>;
  regenerateMessageStream: (chatId: string, messageId: string, override: RegenerateOverride, signal?: AbortSignal) => AsyncIterable<{ event: string; data: string }>;
  /** LS-4a: continue the last assistant reply from its selected variant's text
   *  (the variant text rides as the pushed-assistant continuation point); the
   *  result appends as a NEW variant of the target message. */
  continueMessage: (chatId: string, messageId: string, signal?: AbortSignal) => Promise<MessageResponse>;
  continueMessageStream: (chatId: string, messageId: string, signal?: AbortSignal) => AsyncIterable<{ event: string; data: string }>;
  generateReply: (chatId: string, signal?: AbortSignal) => Promise<MessageResponse>;
  generateReplyStream: (chatId: string, signal?: AbortSignal) => AsyncIterable<{ event: string; data: string }>;
  selectVariant: (chatId: string, messageId: string, variantIndex: number) => Promise<VariantResponse>;
  setVariantTtsAnnotation: (chatId: string, messageId: string, variantIndex: number, text: string | null) => Promise<VariantResponse>;
  addEditorVariant: (chatId: string, messageId: string, body: {
    readonly content: string;
    readonly sourceVariantIds: readonly import("@vibe-tavern/domain").MessageVariantId[];
    readonly modelId?: string;
    readonly promptPresetId?: string;
    readonly finishReason?: string;
  }) => Promise<MessageResponse>;
  deleteVariant: (chatId: string, messageId: string, variantIndex: number) => Promise<MessageResponse>;
  editMessage: (chatId: string, messageId: string, content: string, expectedVariantId?: import("@vibe-tavern/domain").MessageVariantId) => Promise<MessageResponse>;
  deleteMessage: (chatId: string, messageId: string) => Promise<MessageResponse>;
  updateAttachmentDescription: (chatId: string, messageId: string, attachmentId: string, description: string) => Promise<{ ok: boolean }>;
  updateAttachmentIncludeInPrompt: (chatId: string, messageId: string, attachmentId: string, includeInPrompt: boolean) => Promise<{ ok: boolean }>;
  updateAttachmentPrompt: (chatId: string, messageId: string, attachmentId: string, prompt: string) => Promise<{ ok: boolean }>;
  deleteAttachment: (chatId: string, messageId: string, attachmentId: string) => Promise<{ ok: boolean }>;
  regenerateAttachmentDescription: (chatId: string, messageId: string, attachmentId: string) => Promise<{ description: string }>;
  summarizeAttachment: (chatId: string, messageId: string, attachmentId: string, signal?: AbortSignal) => Promise<Attachment>;
  clearAttachmentSummary: (chatId: string, messageId: string, attachmentId: string) => Promise<Attachment>;
}
