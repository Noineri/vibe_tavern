/**
 * Director message-proposal resolution handlers (DIRECTOR_MESSAGE_TOOLS_PLAN
 * Wave 2 / DMT-22) — the `message-edit` and `message-variant` entries of the
 * ONE record-proposal registry ({@link SIDECHAT_RECORD_PROPOSAL_REGISTRY},
 * sidechat-objective-proposal.ts). The generic pipeline (thread ownership,
 * toolCallId validation, pending status, per-proposal serialization, the
 * status write through setToolResultOutput) stays there untouched; this
 * module only supplies the two entries' apply/reject behavior.
 *
 * `message-edit` APPLY — the ordinary guarded edit, reused verbatim: the
 * frozen source identity (messageId/variantId) plus the REVIEWED diff base
 * (`sourceText`) go into ChatApplicationService.editMessage, whose store
 * transaction refuses (409) when the swipe is no longer selected OR its
 * content changed since the user reviewed the proposal — a newer edit to the
 * same still-selected variant id is never overwritten. The candidate runs
 * through the ordinary volatile-macro freeze; the write is the editor path,
 * not a second implementation.
 *
 * `message-variant` APPLY (Save) — the ordinary add-variant path
 * (ChatApplicationService.addEditorVariant): appends + selects a separate
 * swipe, validating every frozen source variant id still exists on the
 * message (the shared source-existence check — a deleted source refuses the
 * save, never a partial append). NO provenance is passed: the new variant's
 * modelId/presetName/finishReason stay null — the alternative records
 * DIRECTOR authorship, never an RP-model or preset claim, and no pending RP
 * prompt-trace preset is attached. Every source byte is left untouched.
 *
 * Ownership: BOTH applies revalidate the persisted proposal against the
 * THREAD's own chat + branch (ctx.chatId / ctx.branchId — never
 * request-supplied ids): every frozen messageId must still be a row of the
 * proposal's branch, else the same 404 a missing row gets (deleted or moved
 * target — nothing at that identity to resolve). Reject runs NO read and NO
 * write: only the pipeline's status change.
 *
 * Companion: an accepted resolution returns the TARGET-SCOPED message
 * companion ({@link SidechatProposalMessageCompanion}) — the affected message
 * row + its full variant list post-write, scoped by chat/branch so a client
 * can refuse to ingest it into a different open chat. Never a branch/chat
 * snapshot.
 */

import {
  DIRECTOR_MESSAGE_RECORD_TYPES,
  DIRECTOR_MESSAGE_TOOLS,
  directorMessageEditProposalSchema,
  directorMessageVariantProposalSchema,
  type DirectorMessageRecordType,
} from "@vibe-tavern/api-contracts";
import { notFound } from "../../shared/errors.js";
import type { Message, MessageStore, MessageVariant } from "@vibe-tavern/db";
import type {
  SidechatProposalMessageCompanion,
  SidechatRecordProposalEntry,
} from "../sidechat/sidechat-objective-proposal.js";

/** The narrow RP-message reads the ownership revalidation and the companion
 *  run through — a structural Pick of the real MessageStore (the
 *  director-message-target.ts seam convention). */
export type DirectorMessageProposalReads = Pick<
  MessageStore,
  "getMessages" | "getMessageById" | "getVariants"
>;

/** The thread's own branch, required for the message-target revalidation —
 *  a chat-owned sidechat thread always carries one; null on corrupt rows is
 *  the same 404 a missing target gets (nowhere to resolve the message in). */
function requireBranchId(branchId: string | null): string {
  if (branchId === null) {
    throw notFound(
      "ExperienceCopilotThread",
      "This thread carries no RP branch to resolve a message proposal in.",
    );
  }
  return branchId;
}

/** Load the proposal's target message scoped to the THREAD's own branch —
 *  the ownership revalidation. The frozen messageId must still be a row of
 *  THIS branch: a deleted reply, a reply moved to another branch, or a
 *  hand-corrupted row naming a foreign chat's message all land here — the
 *  same 404, never a write to some other chat's message. */
async function requireBranchMessage(
  reads: DirectorMessageProposalReads,
  branchId: string,
  messageId: string,
): Promise<Message> {
  const message = (await reads.getMessages(branchId)).find((row) => row.id === messageId);
  if (!message) {
    throw notFound(
      "Message",
      `Message '${messageId}' was not found in the proposal's branch '${branchId}'.`,
    );
  }
  return message;
}

/** The refreshed target-scoped companion (message row + full variant list,
 *  post-write). Scoped by the thread's chat/branch so the client can verify
 *  the affected conversation before merging it into its local state. */
async function readMessageCompanion(
  reads: DirectorMessageProposalReads,
  chatId: string,
  branchId: string,
  messageId: string,
): Promise<SidechatProposalMessageCompanion> {
  const message = await reads.getMessageById(messageId);
  if (!message) {
    throw notFound("Message", `Message '${messageId}' was not found.`);
  }
  const variants = await reads.getVariants(messageId);
  const messageView = {
    id: message.id,
    position: message.position,
    content: message.content,
    updatedAt: message.updatedAt,
  };
  const variantViews = variants.map((variant: MessageVariant) => ({
    id: variant.id,
    variantIndex: variant.variantIndex,
    content: variant.content,
    isSelected: variant.isSelected,
    modelId: variant.modelId,
    presetName: variant.presetName,
  }));
  return { chatId, branchId, message: messageView, variants: variantViews };
}

/** The two Director message entries, keyed by their DMT-11 recordType — the
 *  registry spread ({@link SIDECHAT_RECORD_PROPOSAL_REGISTRY}) consumes this
 *  verbatim, so there is exactly one dispatch table and one recognition rule
 *  per type (the DMT-11 payload schemas are the shared shape source — the
 *  `matches` gate is a safeParse, never a second hand-written derivation). */
export const DIRECTOR_MESSAGE_PROPOSAL_ENTRIES: Readonly<
  Record<DirectorMessageRecordType, SidechatRecordProposalEntry>
> = {
  [DIRECTOR_MESSAGE_RECORD_TYPES.messageEdit]: {
    toolName: DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit,
    matches: (proposal) =>
      proposal.op === "update" &&
      typeof proposal.targetId === "string" &&
      directorMessageEditProposalSchema.safeParse(proposal.payload).success,
    apply: async ({ deps, chatId, branchId, proposal }) => {
      const payload = directorMessageEditProposalSchema.parse(proposal.payload);
      const ownerBranchId = requireBranchId(branchId);
      // Ownership first: the frozen source must still live on the thread's
      // own branch (deleted/moved/foreign → 404, nothing written).
      const reads = deps.messages;
      await requireBranchMessage(reads, ownerBranchId, payload.source.messageId);
      // The ordinary guarded edit: selected-source id + reviewed base content,
      // both checked INSIDE the store transaction. A moved selection or a
      // newer edit to the same swipe refuses the whole write (409) — never an
      // overwrite, never a fallback to a different source.
      await deps.editMessage(
        payload.source.messageId,
        payload.candidate,
        payload.source.variantId,
        payload.sourceText,
      );
      return {
        message: await readMessageCompanion(reads, chatId, ownerBranchId, payload.source.messageId),
      };
    },
    reject: async () => ({}),
  },

  [DIRECTOR_MESSAGE_RECORD_TYPES.messageVariant]: {
    toolName: DIRECTOR_MESSAGE_TOOLS.proposeMessageVariant,
    matches: (proposal) =>
      proposal.op === "create" &&
      typeof proposal.targetId === "string" &&
      directorMessageVariantProposalSchema.safeParse(proposal.payload).success,
    apply: async ({ deps, chatId, branchId, proposal }) => {
      const payload = directorMessageVariantProposalSchema.parse(proposal.payload);
      const ownerBranchId = requireBranchId(branchId);
      const reads = deps.messages;
      // Ownership first: the target message AND every frozen source identity
      // must still live on the thread's own branch (sources name swipes of
      // the one target reply — the tool froze them together).
      const targetMessageId = proposal.targetId as string;
      const messageIds = [
        ...new Set([targetMessageId, ...payload.sources.map((source) => source.messageId)]),
      ];
      for (const messageId of messageIds) {
        await requireBranchMessage(reads, ownerBranchId, messageId);
      }
      // The ordinary add-variant path with its source-existence checks, and
      // NO provenance input: the appended variant's modelId/presetName/
      // finishReason stay null — DIRECTOR authorship, never an RP-model or
      // preset claim, and no pending RP prompt-trace preset is attached.
      await deps.addEditorVariant(targetMessageId, {
        content: payload.content,
        sourceVariantIds: payload.sources.map((source) => source.variantId),
      });
      return {
        message: await readMessageCompanion(reads, chatId, ownerBranchId, targetMessageId),
      };
    },
    reject: async () => ({}),
  },
};
