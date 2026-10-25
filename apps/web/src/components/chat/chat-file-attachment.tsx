import type { Attachment } from "@vibe-tavern/domain";
import { summarizeAttachment, clearAttachmentSummary } from "../../api/attachment-actions-api.js";
import { deleteAttachment, updateAttachmentIncludeInPrompt } from "../../api/chat-api.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { SentFileAttachment } from "./sent-file-attachment.js";

// forks: 1 — agent-shell twin `agent-file-attachment.tsx` (CA-4f).
/** RP mount: all completion writes use the current canonical set, never the
 * render's pre-await attachment list (other chips can finish in parallel). */
export function ChatFileAttachment({ attachment, messageId }: { attachment: Attachment; messageId: string }) {
  return <SentFileAttachment attachment={attachment} actions={{
    summarize: (signal) => summarizeAttachment("_", messageId, attachment.id, signal),
    clearSummary: () => clearAttachmentSummary("_", messageId, attachment.id),
    setIncluded: async (included) => { await updateAttachmentIncludeInPrompt("_", messageId, attachment.id, included); },
    remove: async () => { await deleteAttachment("_", messageId, attachment.id); },
  }} onUpdated={(updated) => {
    const state = useSnapshotStore.getState();
    const current = state.messagesById[messageId]?.attachments;
    if (current) state.updateMessage(messageId, { attachments: current.map((att) => att.id === updated.id ? updated : att) });
  }} onRemoved={(id) => {
    const state = useSnapshotStore.getState();
    const current = state.messagesById[messageId]?.attachments;
    if (current) state.updateMessage(messageId, { attachments: current.filter((att) => att.id !== id) });
  }} />;
}
