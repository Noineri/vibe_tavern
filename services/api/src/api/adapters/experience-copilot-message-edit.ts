/**
 * Assistant-message edit wiring (AP-30) — the adapter-side half of "edit an
 * assistant message", extracted into its own module (the
 * `experience-copilot-turn-delete.ts` sibling pattern) because
 * experience-copilot-adapter.ts sits at the arch-gate size cap and keeps only
 * a thin delegating member. Owns the store-result → HTTP error mapping: the
 * store sibling (packages/db, `updateAssistantMessageContent`) answers a
 * discriminated union; every non-success status maps onto the shared
 * DomainError vocabulary the global handler serializes. The refusal families
 * are 400 Validation with a machine-readable `details.reason` code
 * (not_assistant_row / tool_call_row / empty_content / empty_row /
 * folded_row) so the web client (AP-31) can map them; the missing families
 * are the 404s, byte-identical to the delete's.
 */

import type { ExperienceCopilotStore } from "@vibe-tavern/db";
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { notFound, validation } from "../../shared/errors.js";
import { toMessageWire } from "./experience-copilot-wire-mappers.js";

/** Edit one assistant text row through the store sibling and map the outcome
 *  onto the wire: the updated message wire on success, else the DomainError
 *  for the refusal family (the branded store ids are phantom string brands —
 *  already wire-assignable). */
export async function editCopilotMessageWire(
  store: ExperienceCopilotStore,
  threadId: string,
  messageId: string,
  content: string,
): Promise<ExperienceCopilotMessageWire> {
  const result = await store.updateAssistantContent(threadId, messageId, content);
  switch (result.status) {
    case "edited":
      return toMessageWire(result.message);
    case "refused-not-assistant":
      throw validation(
        `Only an assistant text row can be edited — message '${messageId}' is a '${result.role}' row.`,
        { reason: "not_assistant_row", role: result.role },
      );
    case "refused-tool-call-row":
      throw validation(
        `Only an assistant text row can be edited — message '${messageId}' carries tool calls.`,
        { reason: "tool_call_row" },
      );
    case "refused-empty-content":
      throw validation("The replacement content must not be empty.", { reason: "empty_content" });
    case "refused-empty-row":
      throw validation(
        `Only an assistant text row can be edited — message '${messageId}' has no text to edit.`,
        { reason: "empty_row" },
      );
    case "refused-folded":
      throw validation(
        `Message '${messageId}' is folded into a context digest and cannot be edited.`,
        { reason: "folded_row" },
      );
    case "missing-thread":
      throw notFound("ExperienceCopilotThread", `Copilot thread '${threadId}' was not found.`);
    case "missing-message":
      throw notFound(
        "ExperienceCopilotMessage",
        `Copilot message '${messageId}' was not found in thread '${threadId}'.`,
      );
  }
}
