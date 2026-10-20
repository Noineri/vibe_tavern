/**
 * The sidechat-OOC kind's objective-proposal tool (SIDECHAT_PLAN Wave 3 /
 * SC-11) — `propose_objective`, the kind's first PROPOSAL-returning tool:
 * unlike the search pair (which answers the model's question), this tool
 * hands the USER a decision. Its execute never writes anything; it returns
 * the `RecordProposal` the generic loop persists as the tool row
 * (`{ toolName, output }` — the same wrapper every tool result rides), and
 * the apply/reject routes (`api/routes/agent-thread-proposals.ts`, through
 * `domain/sidechat/sidechat-objective-proposal.ts`) are the only writers of
 * the tracker.
 *
 * The proposal `id` is the tool call's own `toolCallId` (the SDK hands it to
 * execute): one stable id shared by the persisted row and the route that
 * resolves it, with no second id space to keep in sync. `payload` is the
 * tool input verbatim (`{ description, reason? }` — `reason` omitted from
 * the payload when the model omitted it), `recordType: "objective"`,
 * `op: "create"`, `status: "pending"` — SC-13 renders this exact shape and
 * the review card's Accept/Reject posts back the `toolCallId`.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { log } from "@vibe-tavern/domain";
import type { RecordProposal } from "@vibe-tavern/api-contracts";

/** Same observability discipline as the search pair (CA-17/CANARY): without
 *  the IN/OK lines a sidechat tool call is invisible server-side. */
const logger = log.tag("sidechat.tool");

/** The tool's wire name — the `SIDECHAT_OOC_TOOL_KEYS` toggle key and the
 *  `toolName` the persisted proposal row carries. The one spelling the
 *  stream's gating, the row parse (sidechat-objective-proposal.ts) and the
 *  apply/reject status write all read. */
export const SIDECHAT_OBJECTIVE_TOOL_NAME = "propose_objective";

/** The tool's input contract (the plan's object root): the proposed item
 *  plus an optional one-line reason for the user's review. The description
 *  validators are the insights family's own `nonEmptyDescriptionSchema`
 *  shape (`z.string().trim().min(1)` — insights-schema.ts): objective text
 *  is user-facing content, trimmed and non-empty exactly like the add-task
 *  route's body. Exported so the validation pins run against the same
 *  schema the loop enforces. */
export const sidechatObjectiveProposalInputSchema = z.object({
  description: z.string().trim().min(1).describe("The objective item to add — one concrete, self-contained next step for the story."),
  reason: z.string().trim().min(1).optional().describe("One line for the user explaining why this step now. Omit when the description already says it."),
});

/**
 * Build the sidechat's `propose_objective`. `toolSet` is the RESOLVED
 * profile's set (the kind's toggles, SC-5): the tool is served only when
 * `propose_objective` is enabled — the same filter the search pair applies
 * (a tool landed with its toggle off is not landed).
 */
export function buildSidechatObjectiveTools(input: {
  toolSet: Record<string, boolean>;
}): ToolSet {
  const allTools = {
    [SIDECHAT_OBJECTIVE_TOOL_NAME]: tool({
      description:
        "Propose adding ONE item to the user's Objective Tracker for this chat. " +
        "The tracker's mode decides what the item becomes when the user accepts: 'route' mode a task on the route, 'goals' mode a short-term goal — you do not need to know which; propose the step itself. " +
        "Call it when the discussion surfaces a concrete next step worth tracking (not every suggestion — one clear, actionable item per call). " +
        "This is only a PROPOSAL: the user reviews it and decides; nothing reaches the tracker until they accept it, so never assume it was added or mention accepting it as done.",
      inputSchema: sidechatObjectiveProposalInputSchema,
      execute: async ({ description, reason }, options): Promise<RecordProposal> => {
        logger.info("propose_objective IN descriptionLen=%d reason=%s", description.length, reason === undefined ? "(none)" : "yes");
        const proposal: RecordProposal = {
          kind: "record",
          id: options.toolCallId,
          recordType: "objective",
          op: "create",
          payload: reason !== undefined ? { description, reason } : { description },
          status: "pending",
        };
        logger.info("propose_objective OK id=%s", options.toolCallId);
        return proposal;
      },
    }),
  };

  // The kind's toggles (the resolved profile's set): only enabled keys are
  // served — the same filter the search pair applies.
  return Object.fromEntries(
    Object.entries(allTools).filter(([name]) => input.toolSet[name] === true),
  ) as typeof allTools;
}
