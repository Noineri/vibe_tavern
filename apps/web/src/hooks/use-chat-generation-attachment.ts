import { useEffect, useRef } from "react";
import type { ChatControllerActions } from "./use-chat-controller.js";
import { fetchChat, isChatGenerationRunning } from "../api/chat-api.js";
import { useChatStore } from "../stores/chat-store.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";
import { useGenerationQueueStore } from "../stores/generation-queue-store.js";

/** Mounted ONCE by AppShell, not by every useChatController consumer. A live
 * local send keeps its existing reader across switches (BR-0); a missing reader
 * is rediscovered. Cleanup detaches only this hook's GET, never the producer. */
export function useChatGenerationAttachment(reattach: ChatControllerActions["reattachGeneration"]) {
  const chatId = useChatStore((s) => s.activeChatId);
  const snapshotChatId = useSnapshotStore((s) => s.activeChat?.id ?? null);
  const latest = useRef(reattach);
  latest.current = reattach;
  useEffect(() => {
    if (!chatId || snapshotChatId !== chatId) return;
    const controller = new AbortController();
    let discovering = false, dirty = false, queueWake = false;
    const discover = async () => {
      dirty = true;
      if (discovering) return;
      discovering = true;
      try {
        do {
          dirty = false;
          if (controller.signal.aborted || useChatStore.getState().generations[chatId]?.isSending) return;
          queueWake = false;
          const running = await isChatGenerationRunning(chatId, controller.signal);
          if (controller.signal.aborted || useChatStore.getState().generations[chatId]?.isSending) return;
          if (!running) {
            // A run can finish between navigation/queue invalidation and discovery.
            const snapshot = await fetchChat(chatId);
            if (!controller.signal.aborted && useChatStore.getState().activeChatId === chatId && !useChatStore.getState().generations[chatId]?.isSending)
              useSnapshotStore.getState().ingestSnapshot(snapshot);
          } else await latest.current(chatId, controller.signal);
        } while (dirty && !controller.signal.aborted);
      } catch (error) {
        if (!controller.signal.aborted) console.warn("[chat-run] discovery failed", error);
      } finally { discovering = false; }
    };
    // A new queue job can start while the old reader is still revealing its
    // final text. Wake again on local settlement; never detach a reader just
    // because isSending changed as a result of attaching it.
    const unsubscribeChat = useChatStore.subscribe((state, previous) => {
      if (queueWake && previous.generations[chatId]?.isSending && !state.generations[chatId]?.isSending) void discover();
    });
    const runningJob = () => useGenerationQueueStore.getState().jobsByChat[chatId]?.find((job) => job.status === "running")?.id;
    let previousJob = runningJob();
    queueWake = previousJob !== undefined;
    const unsubscribeQueue = useGenerationQueueStore.subscribe(() => {
      const next = runningJob();
      if (next !== previousJob) { previousJob = next; queueWake = true; void discover(); }
    });
    void discover();
    return () => { unsubscribeChat(); unsubscribeQueue(); controller.abort(); };
  }, [chatId, snapshotChatId]);
}
