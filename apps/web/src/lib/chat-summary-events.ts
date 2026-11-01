import type { ChatNotification } from "@vibe-tavern/domain";

/** Live fanout from useChatEvents' existing SSE channel, not a second transport
 * or a persisted event cache. Modal listeners exist only while their scope is open. */
const listeners = new Set<(event: ChatNotification) => void>();

export function publishChatSummaryEvent(event: ChatNotification): void {
  for (const listener of listeners) listener(event);
}

export function subscribeChatSummaryEvents(listener: (event: ChatNotification) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
