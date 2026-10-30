import { useEffect } from "react";
import { toast } from "sonner";
import { useChatStore } from "../stores/chat-store.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";
import { useGenerationQueueStore } from "../stores/generation-queue-store.js";
import { cancelGenerationJob, clearGenerationQueue, enqueueGenerationJob } from "../api/chat-generation-queue-api.js";
import { inGenerationQueueLane, readGenerationQueue, refreshGenerationQueue } from "../lib/chat-generation-queue-client.js";
import { getT } from "../i18n/locale-helpers.js";

/** BR-4g: no browser pump. The server runs every job, even when another chat
 * is visible or this tab is closed. These entry points send intent only;
 * canonical GETs/events project the existing manager, and BR-4c owns replay. */
function report(error: unknown): void { toast.error(error instanceof Error ? error.message : getT()("request_failed")); }

export async function enqueueGenerateMore(messageId: string, model: string, promptPresetId: string | null): Promise<void> {
  const chatId = useChatStore.getState().activeChatId;
  if (!chatId) return;
  const queue = useGenerationQueueStore.getState();
  const message = useSnapshotStore.getState().messagesById[messageId];
  queue.startBatch(chatId, messageId, message?.variants.map((variant) => variant.id) ?? []);
  const generation = useChatStore.getState().generations[chatId];
  if (generation?.isSending && generation.streamingMessageId === messageId
    && !queue.recordsByChat[chatId]?.some((record) => record.status === "running")) {
    queue.addRecord(chatId, { messageId, origin: "regenerate", status: "running", model: generation.modelId, presetName: generation.presetName, presetId: null });
  }
  try {
    await inGenerationQueueLane(chatId, async () => {
      await enqueueGenerationJob(chatId, { messageId, model, promptPresetId });
      await readGenerationQueue(chatId);
    });
  } catch (error) { report(error); }
}

export async function cancelQueueJob(jobId: string): Promise<void> {
  const job = Object.values(useGenerationQueueStore.getState().jobsByChat).flat().find((item) => item.id === jobId);
  if (!job) return;
  try {
    await inGenerationQueueLane(job.chatId, async () => {
      await cancelGenerationJob(job.chatId, job.id);
      await readGenerationQueue(job.chatId);
    });
  } catch (error) { report(error); }
}

export async function clearQueuePending(): Promise<void> {
  const chatId = useChatStore.getState().activeChatId;
  if (!chatId) return;
  try {
    await inGenerationQueueLane(chatId, async () => {
      await clearGenerationQueue(chatId);
      await readGenerationQueue(chatId);
    });
  } catch (error) { report(error); }
}

/** AppShell-only hydration; chat notifications also refresh on changes and
 * EventSource reconnect. Neither unmount nor navigation sends Stop. */
export function useGenerationQueue(): void {
  const chatId = useChatStore((state) => state.activeChatId);
  const snapshotId = useSnapshotStore((state) => state.activeChat?.id);
  const branchId = useSnapshotStore((state) => state.activeBranch?.id);
  useEffect(() => {
    if (chatId && chatId === snapshotId) void refreshGenerationQueue(chatId).catch(report);
  }, [chatId, snapshotId, branchId]);
}
