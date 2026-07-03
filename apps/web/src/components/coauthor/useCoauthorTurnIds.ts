import { useMemo } from "react";
import { useMessageOrder } from "../../stores/index.js";
import { useActiveGeneration, useIsSending } from "../../stores/chat-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";

/**
 * Co-Author turn grouping logic.
 * A turn is a single `user` message, OR a run of consecutive non-`user` messages
 * (e.g. assistant -> tool -> assistant).
 */
export function useCoauthorTurnIds(): string[] {
  const messageOrder = useMessageOrder();
  const activeGen = useActiveGeneration();
  const isSending = useIsSending();
  const pendingUserMessageContent = activeGen?.pendingUserMessageContent ?? null;
  const lastPersistedMessage = useSnapshotStore((s) => {
    const lastMessageId = s.messageOrder[s.messageOrder.length - 1];
    return lastMessageId ? s.messagesById[lastMessageId] : null;
  });

  return useMemo(() => {
    const state = useSnapshotStore.getState();
    const turnIds: string[] = [];
    
    let currentAssistantTurnId: string | null = null;

    for (const id of messageOrder) {
      const msg = state.messagesById[id];
      if (!msg) continue;
      
      if (msg.role === "user") {
        turnIds.push(id);
        currentAssistantTurnId = null;
      } else {
        if (!currentAssistantTurnId) {
          currentAssistantTurnId = id;
          turnIds.push(currentAssistantTurnId);
        }
      }
    }

    if (pendingUserMessageContent) {
      const alreadyPersisted =
        lastPersistedMessage?.role === "user" &&
        lastPersistedMessage.content.trim() === pendingUserMessageContent.trim();

      if (!alreadyPersisted) {
        turnIds.push("__pending-user");
      }
      turnIds.push("__pending-assistant");
    } else if (isSending) {
      if (lastPersistedMessage?.role === "user") {
        turnIds.push("__pending-assistant");
      }
    }

    return turnIds;
  }, [messageOrder, pendingUserMessageContent, lastPersistedMessage, isSending]);
}
