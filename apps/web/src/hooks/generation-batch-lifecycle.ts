import { useGenerationQueueStore } from "../stores/generation-queue-store.js";
import type { ChatId } from "@vibe-tavern/domain";
import type { AppSnapshot } from "../api/types.js";
import { fetchChatAction } from "../stores/api-actions/chat-actions.js";

/** Refresh helpers shared by every record settlement path in the controller. */
export async function refreshChatSnapshotCache(chatId: ChatId): Promise<AppSnapshot> {
  return fetchChatAction(chatId);
}

export async function refreshAfterAbort(chatId: ChatId): Promise<AppSnapshot> {
  await new Promise((resolve) => setTimeout(resolve, 200));
  return refreshChatSnapshotCache(chatId);
}

export function resetGenerationBatch(chatId: string): void {
  useGenerationQueueStore.getState().clearBatch(chatId);
}

export function startPlainRegenerateRecord(
  chatId: string,
  messageId: string,
  metadata: { model: string | null; presetName: string | null },
): string {
  return useGenerationQueueStore.getState().addRecord(chatId, {
    messageId,
    origin: "regenerate",
    status: "running",
    model: metadata.model,
    presetName: metadata.presetName,
    presetId: null,
  });
}

export function updatePlainRegenerateRecordMetadata(
  chatId: string,
  recordId: string,
  metadata: { model: string | null; presetName: string | null },
): void {
  useGenerationQueueStore.getState().updateRecord(chatId, recordId, metadata);
}

export function settleRunningQueueRecordFailure(chatId: string, messageId: string, error: string): void {
  const store = useGenerationQueueStore.getState();
  const record = store.recordsByChat[chatId]?.find(
    (item) => item.messageId === messageId && item.origin === "queue" && item.status === "running",
  );
  if (record) store.updateRecord(chatId, record.id, { status: "failed", error });
}

export function settlePlainRegenerateRecord(chatId: string, recordId: string, outcome: "done" | "failed" | "cancelled", error: string): void {
  const store = useGenerationQueueStore.getState();
  if (outcome === "done" || outcome === "cancelled") store.removeRecord(chatId, recordId);
  else store.updateRecord(chatId, recordId, { status: "failed", error });
}
