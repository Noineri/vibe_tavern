import type { Attachment } from "@vibe-tavern/domain";
import { getGatewayBaseUrl } from "./client.js";
import { appendTokenQuery } from "../lib/mobile-token.js";
import { unwrapError } from "./unwrap.js";

async function attachmentAction(chatId: string, messageId: string, attachmentId: string, action: string, signal?: AbortSignal): Promise<Attachment> {
  const response = await fetch(appendTokenQuery(`${getGatewayBaseUrl()}/api/chats/${chatId}/messages/${messageId}/attachments/${attachmentId}/${action}`), { method: "POST", signal });
  if (!response.ok) {
    throw await unwrapError(response);
  }
  return response.json();
}

export function summarizeAttachment(chatId: string, messageId: string, attachmentId: string, signal: AbortSignal): Promise<Attachment> {
  return attachmentAction(chatId, messageId, attachmentId, "summarize", signal);
}

export function clearAttachmentSummary(chatId: string, messageId: string, attachmentId: string): Promise<Attachment> {
  return attachmentAction(chatId, messageId, attachmentId, "clear-summary");
}
