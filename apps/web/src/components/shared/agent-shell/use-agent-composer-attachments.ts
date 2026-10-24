import { useState } from "react";
import type { ClipboardEvent, DragEvent } from "react";
import type { Attachment } from "@vibe-tavern/domain";
import { useAttachmentDraft } from "../../../hooks/use-attachment-draft.js";
import { estimateAttachmentOverflow } from "../../../hooks/attachment-overflow.js";
import { useImageRouteWarning } from "../../../hooks/use-image-route-warning.js";
import { fetchProfileImageRoute } from "../../../api/image-route-api.js";

/** The shell composer's shared attachment layer (CA-4e2) — the twin of the
 *  Co-Author's `useCoauthorInputArea` attachment block, used by BOTH composer
 *  arms (desktop + phone) so the logic is written once. Agent differences:
 *  no audio (no voice transcriber for agents — agent call 2026-10-24) and
 *  the draft attachments live in LOCAL state beside the composer's draft
 *  text (the shell keeps no store slice — they behave exactly like the draft
 *  text today).
 *
 *  `locked` is the answering-ask state (CA-4a1 ruling): an answer cannot
 *  carry attachments, so paste and drop add nothing and the paperclip is
 *  disabled — the drafted attachments stay for the next normal message. */

export interface AgentComposerMetrics {
  totalTokens: number;
  budgetTokens: number;
}

export function useAgentComposerAttachments({
  providerProfileId,
  model,
  contextMetrics,
  locked = false,
}: {
  providerProfileId: string | null;
  model?: string;
  /** The thread meter's numbers (`copilotContext.metrics`); null before the
   *  first turn → no overflow warning (no budget to overflow). */
  contextMetrics?: AgentComposerMetrics | null;
  locked?: boolean;
}) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const add = (attachment: Attachment) => setAttachments((prev) => [...prev, attachment]);
  const remove = (id: string) => setAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
  const clear = () => setAttachments([]);

  const draft = useAttachmentDraft({ attachments, add, remove, allowedKinds: ["image", "file"] });

  const routeKey = JSON.stringify([providerProfileId, model]);
  const visionWarning = useImageRouteWarning(attachments, routeKey, () =>
    providerProfileId
      ? fetchProfileImageRoute(providerProfileId, model)
      : Promise.reject(new Error("No provider profile selected")));

  const overflow = estimateAttachmentOverflow({
    totalUsed: contextMetrics?.totalTokens ?? 0,
    availableBudget: contextMetrics?.budgetTokens ?? 0,
    attachments,
  });

  return {
    attachments, add, remove, clear,
    fileInputRef: draft.fileInputRef,
    accept: draft.accept,
    onFileInputChange: draft.onFileInputChange,
    handlePaste: (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (locked) return;
      draft.handlePaste(event);
    },
    isDragOver: draft.isDragOver,
    handleDragOver: (event: DragEvent) => {
      if (locked) return;
      draft.handleDragOver(event);
    },
    handleDragLeave: (event: DragEvent) => draft.handleDragLeave(event),
    handleDrop: (event: DragEvent) => {
      if (locked) return;
      draft.handleDrop(event);
    },
    attachmentOverflow: overflow,
    attachmentVisionWarning: visionWarning,
  };
}
