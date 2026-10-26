/**
 * The regenerate-turn mechanism (AGENT_SHELL_POLISH, AP-9) — the THIRD
 * exclusive stream-request mode (with content and answer): rerun the last
 * turn with NO new user row. This module owns everything the mode needs
 * below the kind seams; the loop (`agent-stream.ts`) only dispatches to
 * {@link applyAgentTurnRegenerate} — the same loop→sibling split the answer
 * mode has with `agent-split-turn.ts`.
 *
 * WHAT THE MODE REPLACES — the thread's LAST turn, resolved through the
 * AP-8 store sibling (`deleteCopilotTurn`, packages/db — the ONE row-deletion
 * path; there is no second one here). The resolution addresses the thread's
 * LAST message row with `includeUserMessage: false`, so the store's span
 * resolution derives the same span it derives for an explicit delete: every
 * row after the thread's last user row (the replaced turn's own rows —
 * assistant text, tool-call carriers, tool results, continuation rows after
 * an ask/permission answer alike). The last user row itself STAYS: it is the
 * input the regenerated turn runs against.
 *
 * THE FAILED-TURN SHAPE — a thread whose last row IS a user row (the
 * previous run produced nothing before failing) has no rows after its user
 * row: nothing is deleted, the deletion seam is never called, and the turn
 * simply re-executes against that row.
 *
 * THE DIGEST FLOOR — a regenerate whose implicit deletion would remove rows
 * a context digest already folded (or the anchor row, or the digest row
 * itself) is refused exactly like an explicit AP-8 delete, through the store
 * sibling's own check inside its transaction: the digest is a floor for
 * deletion, hence for regenerate's implicit deletion. The refusal maps to
 * the same 409 conflict family the delete endpoint answers with.
 *
 * Kind-agnostic by construction: no kind imports, no buffer names, no tool
 * names. The deletion runs through the injected seam over the store family;
 * chat-owned event preservation is the store sibling's own rule (context
 * events are never deleted with a turn).
 */

import type { CopilotTurnDeleteResult } from "@vibe-tavern/db";
import { validation, conflict, notFound } from "../../shared/errors.js";

// ─── Structural subsets (the loop's rows/seams satisfy these) ────────────────

/** Structural view of a stored message row the regenerate resolution reads —
 *  `agent-stream.ts`'s `AgentStreamStoredMessage` satisfies this without
 *  adapters (kept structural so this module imports nothing from the loop;
 *  the loop imports this module — never the reverse, the split-turn rule). */
export interface AgentRegenerateRow {
  id: string;
  role: string;
}

/** The thread's row-deletion seam — the AP-8 store sibling
 *  (`deleteCopilotTurn`) over the real db, supplied by each kind's wiring
 *  through the loop deps. The result union is imported from the store family
 *  (ONE derivation of the deletion contract — no structural copy here). */
export type AgentTurnDeleteTurn = (
  threadId: string,
  messageId: string,
  includeUserMessage: boolean,
) => Promise<CopilotTurnDeleteResult>;

// ─── The regenerate application step (the loop's dispatch target) ────────────

/** What {@link applyAgentTurnRegenerate} did: the deleted row ids in timeline
 *  order — empty when there was nothing to delete (the failed-turn shape). */
export interface AgentRegenerateOutcome {
  readonly deletedMessageIds: readonly string[];
}

/**
 * Apply the regenerate mode's implicit deletion (AP-9): resolve the thread's
 * last turn and delete its rows after the last user row through the deletion
 * seam, keeping the user row. Called by the generic loop BEFORE the history +
 * kind-context load (the trimmed state is what this turn's assembly — and the
 * sidechat's per-turn RP sync — must see), with the provider inputs already
 * resolved: like content mode's input persistence, the destructive write
 * never happens for a request that cannot run.
 *
 * @throws {@link validation} when the thread is empty (nothing to
 *   regenerate) or the wiring carries no deletion seam (legacy harnesses).
 * @throws {@link conflict} when the last turn intersects the digest floor
 *   (the same 409 family as an explicit turn delete).
 * @throws {@link notFound} when the thread or the addressed row vanished
 *   between the read and the delete (the store sibling's 404 statuses).
 */
export async function applyAgentTurnRegenerate(input: {
  readonly threadId: string;
  readonly listMessages: () => Promise<readonly AgentRegenerateRow[]>;
  readonly deleteTurn?: AgentTurnDeleteTurn;
}): Promise<AgentRegenerateOutcome> {
  if (input.deleteTurn === undefined) {
    throw validation(
      "This agent wiring serves no regenerate mode (no turn-deletion seam is wired).",
    );
  }
  const rows = await input.listMessages();
  const last = rows[rows.length - 1];
  if (last === undefined) {
    throw validation("There is no turn to regenerate: the thread has no messages.");
  }
  if (last.role === "user") {
    // The failed-turn shape: the last row IS the user row, so the turn has no
    // rows after it — nothing to delete, the run re-executes against it.
    return { deletedMessageIds: [] };
  }
  const result = await input.deleteTurn(input.threadId, last.id, false);
  switch (result.status) {
    case "deleted":
      return { deletedMessageIds: [...result.deletedMessageIds] };
    case "refused-digest":
      throw conflict(
        "The turn to regenerate is folded into a context digest (or is the digest itself) — " +
          "regenerate is available only on turns after the latest digest.",
      );
    case "refused-user-row":
      // Unreachable by construction (the addressed row is the thread's last
      // row and non-user) — kept defensive so a future seam change cannot
      // silently delete a user row instead of refusing.
      throw validation("The regenerate resolution refused to delete through a user row.");
    case "missing-thread":
      throw notFound(
        "ExperienceCopilotThread",
        `Copilot thread '${input.threadId}' was not found.`,
      );
    case "missing-message":
      throw notFound(
        "ExperienceCopilotMessage",
        `Copilot message '${last.id}' was not found in thread '${input.threadId}'.`,
      );
  }
}
