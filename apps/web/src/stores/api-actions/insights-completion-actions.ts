import type { ChatId } from "@vibe-tavern/domain";
import {
  logClientSendDebug,
  refreshInsightsCompletion,
  type AppSnapshot,
  type InsightsCompletionTarget,
} from "../../app-client.js";
import { useSnapshotStore } from "../snapshot-store.js";

interface PendingCompletionRefresh {
  controller: AbortController;
  target: InsightsCompletionTarget;
}

const pendingByChat = new Map<string, PendingCompletionRefresh>();

function sameTarget(
  left: InsightsCompletionTarget,
  right: InsightsCompletionTarget,
): boolean {
  return (
    left.branchId === right.branchId &&
    left.messageId === right.messageId &&
    left.variantId === right.variantId
  );
}

export function findInsightsCompletionTarget(
  chatId: ChatId,
  snapshot: AppSnapshot,
): InsightsCompletionTarget | null {
  const messages = snapshot.messages;
  if (!messages) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "assistant" &&
      message.chatId === chatId &&
      message.branchId &&
      message.id
    ) {
      const variantId = message.variants[message.selectedVariantIndex ?? -1]?.id;
      return {
        branchId: message.branchId,
        messageId: message.id,
        ...(variantId ? { variantId } : {}),
      };
    }
  }
  return null;
}

export function findCurrentInsightsCompletionTarget(
  chatId: ChatId,
): InsightsCompletionTarget | null {
  const store = useSnapshotStore.getState();
  if (store.activeChat?.id !== chatId) return null;
  for (let index = store.messageOrder.length - 1; index >= 0; index -= 1) {
    const message = store.messagesById[store.messageOrder[index] ?? ""];
    if (message?.role === "assistant" && message.chatId === chatId) {
      const variantId = message.variants[message.selectedVariantIndex ?? -1]?.id;
      return {
        branchId: message.branchId,
        messageId: message.id,
        ...(variantId ? { variantId } : {}),
      };
    }
  }
  return null;
}

/**
 * Join and apply one committed assistant response's background insight patch.
 * A newer response for the same chat detaches this waiter; it never cancels the
 * backend's shared forward-state job.
 */
export async function refreshInsightsCompletionAction(
  chatId: ChatId,
  target: InsightsCompletionTarget,
): Promise<boolean> {
  const previous = pendingByChat.get(chatId);
  previous?.controller.abort();

  const controller = new AbortController();
  const pending = { controller, target };
  pendingByChat.set(chatId, pending);

  try {
    const response = await refreshInsightsCompletion(chatId, target, {
      signal: controller.signal,
    });
    const latest = pendingByChat.get(chatId);
    if (
      controller.signal.aborted ||
      latest !== pending ||
      response.target.chatId !== chatId ||
      !sameTarget(response.target, target)
    ) {
      return false;
    }
    return useSnapshotStore.getState().applyInsightsCompletionPatch(response);
  } catch (error) {
    if (!controller.signal.aborted) {
      logClientSendDebug("web.insights.completion-refresh.error", {
        chatId,
        branchId: target.branchId,
        messageId: target.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return false;
  } finally {
    if (pendingByChat.get(chatId) === pending) pendingByChat.delete(chatId);
  }
}

export function startInsightsCompletionRefresh(
  chatId: ChatId,
  target: InsightsCompletionTarget,
): void {
  void refreshInsightsCompletionAction(chatId, target);
}

export function startInsightsCompletionRefreshFromSnapshot(
  chatId: ChatId,
  snapshot: AppSnapshot,
  previousTarget?: InsightsCompletionTarget | null,
): void {
  const activeChat = useSnapshotStore.getState().activeChat;
  const insights = activeChat?.insightsConfig;
  if (
    activeChat?.id !== chatId ||
    (!insights?.objectiveEnabled && !insights?.trackerEnabled)
  ) {
    return;
  }
  const target = findInsightsCompletionTarget(chatId, snapshot);
  if (target && (!previousTarget || !sameTarget(target, previousTarget))) {
    startInsightsCompletionRefresh(chatId, target);
  }
}

export function cancelInsightsCompletionRefresh(chatId: ChatId): void {
  const pending = pendingByChat.get(chatId);
  pending?.controller.abort();
  if (pending) pendingByChat.delete(chatId);
}
