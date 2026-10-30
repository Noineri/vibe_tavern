import { useEffect, useRef } from "react";
import type { ChatControllerActions } from "./use-chat-controller.js";
import { fetchChat, isChatGenerationRunning } from "../api/chat-api.js";
import { useChatStore } from "../stores/chat-store.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";

/** Mounted ONCE by AppShell, not by every useChatController consumer. A live
 * local send keeps its existing reader across switches (BR-0); a missing reader
 * is rediscovered. Cleanup detaches only this hook's GET, never the producer. */
export function useChatGenerationAttachment(reattach: ChatControllerActions["reattachGeneration"]) {
  const chatId = useChatStore((s) => s.activeChatId);
  const snapshotChatId = useSnapshotStore((s) => s.activeChat?.id ?? null);
  const latest = useRef(reattach);
  latest.current = reattach;
  useEffect(() => {
    if (!chatId || snapshotChatId !== chatId || useChatStore.getState().generations[chatId]?.isSending) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const running = await isChatGenerationRunning(chatId, controller.signal);
        if (controller.signal.aborted || useChatStore.getState().generations[chatId]?.isSending) return;
        if (!running) {
          // A run can finish between navigation's snapshot and discovery.
          const snapshot = await fetchChat(chatId);
          if (!controller.signal.aborted && useChatStore.getState().activeChatId === chatId && !useChatStore.getState().generations[chatId]?.isSending)
            useSnapshotStore.getState().ingestSnapshot(snapshot);
          return;
        }
        await latest.current(chatId, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) console.warn("[chat-run] discovery failed", error);
      }
    })();
    return () => controller.abort();
  }, [chatId, snapshotChatId]);
}
