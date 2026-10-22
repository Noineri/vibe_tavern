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

import { deleteCopilotTurn, type AppDb } from "@vibe-tavern/db";
import { notFound, validation, conflict } from "../../shared/errors.js";
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
): Promise<ExperienceCopilotTurnDeleteResult> {
  const result = await deleteCopilotTurn({ db }, threadId, body.messageId, body.includeUserMessage);
  switch (result.status) {
    case "deleted":
      return {
        deletedMessageIds: [...result.deletedMessageIds],
        deletedUserMessageId: result.deletedUserMessageId,
      };
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
