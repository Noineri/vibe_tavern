import type { EventBus, ChatBranchId, MessageId } from "@vibe-tavern/domain";
import type { ChatModeStrategy } from "./chat-mode-strategy.js";

export function notifyUserMessageCreated(events: EventBus, chatId: string, message?: { id: MessageId; content: string }): void {
  if (!message) return;
  events.emit("message.created", {
    chatId,
    messageId: message.id,
    role: "user",
    content: message.content,
  });
}

export function notifyAssistantAppended(
  events: EventBus,
  resolveStrategy: (chatId: string) => Promise<ChatModeStrategy>,
  chatId: string,
  branchId: ChatBranchId,
  messageId: MessageId,
): void {
  events.emit("message.appended", { chatId, branchId, messageId, role: "assistant" });
  // Delegate mode-specific post-append work (no-op for RP/coauthor; future
  // hooks for novel/group). Resolved per-chat from `chat.mode`.
  void resolveStrategy(chatId).then((strategy) => strategy.onMessageAppended({ chatId, messageId, events }));
}
