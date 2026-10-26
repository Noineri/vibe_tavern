import type { ChatId } from "@vibe-tavern/domain";
import { useChatStore } from "../stores/chat-store.js";

/** Imperative chat-store reads for controller async actions. */
export function getActiveChatId(): ChatId | null {
  return useChatStore.getState().activeChatId;
}

export function getDraft(): string {
  return useChatStore.getState().draft;
}

export function getEditingDraft(): string {
  return useChatStore.getState().editingDraft;
}

export function getEditingMessageId(): string | null {
  return useChatStore.getState().editingMessageId;
}

export function getIsSending(chatId: string): boolean {
  return useChatStore.getState().generations[chatId]?.isSending ?? false;
}
