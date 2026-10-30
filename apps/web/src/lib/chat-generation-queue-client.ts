import { getGenerationQueue } from "../api/chat-generation-queue-api.js";
import { useGenerationQueueStore } from "../stores/generation-queue-store.js";
import { useBootstrapStore } from "../stores/api-actions/bootstrap-actions.js";

/** One ordered lane per chat for reads AND writes. A slow hydration can never
 * overwrite a later cancellation/enqueue result; errors do not poison the lane. */
const lanes = new Map<string, Promise<unknown>>();
export function inGenerationQueueLane<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
  const next = (lanes.get(chatId) ?? Promise.resolve()).catch(() => undefined).then(operation);
  lanes.set(chatId, next);
  void next.finally(() => { if (lanes.get(chatId) === next) lanes.delete(chatId); }).catch(() => undefined);
  return next;
}
export async function readGenerationQueue(chatId: string): Promise<void> {
  const jobs = await getGenerationQueue(chatId);
  const names = Object.fromEntries((useBootstrapStore.getState().data?.promptPresets ?? []).map((preset) => [preset.id, preset.name]));
  useGenerationQueueStore.getState().replaceServerJobs(chatId, jobs, names);
}
export function refreshGenerationQueue(chatId: string): Promise<void> {
  return inGenerationQueueLane(chatId, () => readGenerationQueue(chatId));
}
