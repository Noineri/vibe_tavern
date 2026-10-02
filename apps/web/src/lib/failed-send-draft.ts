/**
 * Where the draft goes after a failed send (extracted from
 * hooks/use-chat-controller.ts — the file-size ratchet; both send paths call
 * it). The server keeps a stored user message on a provider failure (and a
 * partial reply on a provider cut), so when the error says the turn is kept
 * the chat is reloaded to show it; restoring the draft beside an invisible
 * stored message invited a duplicate resend (owner 2026-10-02). Otherwise —
 * the failure came before the store — the draft comes back.
 */
import type { Attachment, ChatId } from "@vibe-tavern/domain";
import { useChatStore } from "../stores/chat-store.js";
import { isTurnKeptOnServer } from "./provider-error-toast.js";

/** Put a failed send's text and attachments back into an empty composer. */
export function restoreDraftAfterSendError(content?: string | null, attachments?: Attachment[]): void {
  const store = useChatStore.getState();
  if (content != null && store.draft.length === 0) {
    store.setDraft(content);
  }
  if (attachments?.length) {
    const existingIds = new Set(useChatStore.getState().draftAttachments.map((att) => att.id));
    attachments.forEach((att) => {
      if (!existingIds.has(att.id)) store.addDraftAttachment(att);
    });
  }
}

export async function settleFailedSendDraft(
  error: unknown,
  chatId: ChatId,
  refreshChat: (chatId: ChatId) => Promise<unknown>,
  content?: string | null,
  attachments?: Attachment[],
): Promise<void> {
  if (isTurnKeptOnServer(error)) {
    useChatStore.getState().setPendingContent(chatId, null);
    await refreshChat(chatId);
    return;
  }
  restoreDraftAfterSendError(content, attachments);
}
