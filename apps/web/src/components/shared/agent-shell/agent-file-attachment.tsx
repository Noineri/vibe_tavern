// fork #1 of chat-file-attachment.tsx (components/chat) — the agent-shell
// mount of the SAME surface-independent SentFileAttachment over the agent
// attachment routes (CA-4d1). Named deviations from the source:
// - actions address (threadId, messageId, attachmentId) through the CA-4f
//   client (`api/agent-attachment-actions-api.ts`), not the chat routes;
// - summarize carries the shell picker's CURRENT providerProfileId + model
//   (a thread whose first turn failed has no last-used pair to inherit);
// - onUpdated/onRemoved re-read the thread through the shell's ONE settle
//   refresh (context `refreshMessages` = AgentShell.handleTurnSettled's
//   reload) — never a second refetch path, and never a snapshot-store write
//   (the agent shell owns no message store).
import type { Attachment } from "@vibe-tavern/domain";
import {
  clearAgentAttachmentSummary,
  removeAgentAttachment,
  setAgentAttachmentIncluded,
  summarizeAgentAttachment,
} from "../../../api/agent-attachment-actions-api.js";
import { FileAttachmentChip } from "../../chat/file-attachment-chip.js";
import { SentFileAttachment } from "../../chat/sent-file-attachment.js";
import { useAgentAttachmentActions } from "./agent-attachment-actions-context.js";

export function AgentFileAttachment({ attachment, messageId }: { attachment: Attachment; messageId: string }) {
  const ctx = useAgentAttachmentActions();
  if (ctx === null) return <FileAttachmentChip attachment={attachment} />;
  const { threadId, providerProfileId, model, refreshMessages } = ctx;
  const options = {
    ...(providerProfileId !== null ? { providerProfileId } : {}),
    ...(model !== undefined ? { model } : {}),
  };
  return <SentFileAttachment attachment={attachment} actions={{
    summarize: (signal) => summarizeAgentAttachment(threadId, messageId, attachment.id, options, signal),
    clearSummary: () => clearAgentAttachmentSummary(threadId, messageId, attachment.id),
    setIncluded: async (included) => { await setAgentAttachmentIncluded(threadId, messageId, attachment.id, included); },
    remove: async () => { await removeAgentAttachment(threadId, messageId, attachment.id); },
  }} onUpdated={refreshMessages} onRemoved={refreshMessages} />;
}
