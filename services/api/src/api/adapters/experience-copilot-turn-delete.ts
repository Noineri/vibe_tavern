/**
 * Turn-delete wiring (AP-8) — the adapter-side half of "delete a turn",
 * extracted into its own module (the `experience-copilot-context-links.ts`
 * helper pattern) because experience-copilot-adapter.ts sits at the arch-gate
 * size cap and keeps only a thin delegating member. Owns the store-result →
 * HTTP error mapping: the store sibling (packages/db,
 * `deleteCopilotTurn`) answers a discriminated union; every non-success
 * status maps onto the shared DomainError vocabulary the global handler
 * serializes — the compact endpoint's error family (400 validation / 409
 * conflict), never a new error style.
 */

import { deleteCopilotTurn, type AppDb, type ExperienceCopilotStore } from "@vibe-tavern/db";
import { cleanupUnreferencedAgentAssets, type AttachmentAssetCleanup } from "./experience-copilot-attachment-actions.js";
import { notFound, validation, conflict } from "../../shared/errors.js";
import type { AgentTurnDeleteTurn } from "../../domain/agent/agent-regenerate.js";
import type {
  ExperienceCopilotTurnDeleteRequest,
  ExperienceCopilotTurnDeleteResult,
} from "../contract/experience-copilot-contracts.js";

/** Delete one turn through the store sibling and map the outcome onto the
 *  wire: `{ deletedMessageIds, deletedUserMessageId }` on success, else the
 *  DomainError for the refusal family (the branded store ids are phantom
 *  string brands — already wire-assignable). */
export async function deleteCopilotTurnWire(
  db: AppDb,
  threadId: string,
  body: ExperienceCopilotTurnDeleteRequest,
  attachments?: {
    store: Pick<ExperienceCopilotStore, "listMessages" | "hasMessageAttachmentAssetReference">;
    cleanup?: AttachmentAssetCleanup;
  },
): Promise<ExperienceCopilotTurnDeleteResult> {
  // Capture before deletion, but only successful deleted ids are eligible for
  // cleanup. Refused deletes never reach cleanup; forks retain shared assets.
  // CA-4e1 `keepAttachmentFiles` (edit-last's delete-before-resend) skips the
  // asset cleanup entirely — the rows still go.
  const skipCleanup = body.keepAttachmentFiles === true;
  const priorMessages = attachments?.cleanup && body.includeUserMessage && !skipCleanup
    ? await attachments.store.listMessages(threadId) : [];
  const result = await deleteCopilotTurn({ db }, threadId, body.messageId, body.includeUserMessage);
  switch (result.status) {
    case "deleted": {
      if (attachments?.cleanup && !skipCleanup) {
        const deletedIds = new Set<string>(result.deletedMessageIds);
        const assetIds = priorMessages.filter((message) => deletedIds.has(message.id))
          .flatMap((message) => message.attachments?.map((attachment) => attachment.assetId) ?? []);
        await cleanupUnreferencedAgentAssets(attachments.store, assetIds, attachments.cleanup);
      }
      return {
        deletedMessageIds: [...result.deletedMessageIds],
        deletedUserMessageId: result.deletedUserMessageId,
      };
    }
    case "refused-digest":
      throw conflict(
        "This turn is folded into a context digest (or is the digest itself) — delete from the newest turn backward.",
      );
    case "refused-user-row":
      throw validation(
        "`messageId` is a user message row; pass `includeUserMessage: true` to delete it with its turn.",
      );
    case "missing-thread":
      throw notFound("ExperienceCopilotThread", `Copilot thread '${threadId}' was not found.`);
    case "missing-message":
      throw notFound(
        "ExperienceCopilotMessage",
        `Copilot message '${body.messageId}' was not found in thread '${threadId}'.`,
      );
  }
}

/** AP-9: the regenerate row-deletion seam the adapter wires into every kind's
 *  stream deps — the SAME store sibling over the SAME db the delete endpoint
 *  reads (the ONE row-deletion path; the stream's regenerate mode resolves the
 *  last turn through it and maps the refusals itself, in the domain sibling
 *  `agent-regenerate.ts`). Built here so the adapter's three kind wirings
 *  share one derivation instead of three closures. */
export function makeRegenerateDeleteTurn(db: AppDb): AgentTurnDeleteTurn {
  return (threadId, messageId, includeUserMessage) =>
    deleteCopilotTurn({ db }, threadId, messageId, includeUserMessage);
}
