import { toExperienceMessageReport, type ChatId, type ExperienceMessageReport } from "@vibe-tavern/domain";
import type { ExperienceSendCommitIntent } from "../api/types.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";
import { useExperienceStore } from "../stores/experience-store.js";

/** Capture the exact send scope once: identifiers alone go to the server;
 * the public report stays local for pending UI. A transient active-chat or
 * attachment scope mismatch must never capture another chat's attachment. */
export function readExperienceSendState(expectedChatId: ChatId): {
  commitIntent: ExperienceSendCommitIntent | undefined;
  pendingReport: ExperienceMessageReport | null;
  scope: { chatId: string; branchId: string } | null;
} {
  const snapshot = useSnapshotStore.getState();
  if (snapshot.activeChat?.id !== expectedChatId) return { commitIntent: undefined, pendingReport: null, scope: null };
  const chatId = snapshot.activeChat.id;
  const branchId = snapshot.activeBranch?.id ?? null;
  if (!branchId) return { commitIntent: undefined, pendingReport: null, scope: null };
  const attachment = useExperienceStore.getState().byScope[JSON.stringify([chatId, branchId])]?.queuedAttachment ?? null;
  if (!attachment || attachment.chatId !== chatId || attachment.branchId !== branchId) {
    return { commitIntent: undefined, pendingReport: null, scope: { chatId, branchId } };
  }
  return {
    commitIntent: {
      experienceAttachmentId: attachment.id,
      experienceQueueRevision: attachment.queueRevision,
      experienceSessionRevision: attachment.sessionRevision,
    },
    pendingReport: attachment.publicReport ? toExperienceMessageReport(attachment.publicReport) : null,
    scope: { chatId, branchId },
  };
}
