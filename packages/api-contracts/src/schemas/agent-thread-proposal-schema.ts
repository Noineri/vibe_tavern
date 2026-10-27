import { z } from "zod";

/**
 * The thread-proposal APPLY request body (DIRECTOR_MODE_PLAN DR-5).
 *
 * The whole body is optional: the route's original caller shape is a
 * body-less POST (the objective apply — SC-11 — never carried a body), so the
 * route registers this schema `.optional()` (the agent-chat-sessions
 * precedent) and a body-less request parses to `{}`.
 *
 * `enableAutoCheck` rides the story-plan Accept (A6): when true, the apply
 * also turns the goal tracker's auto-check on
 * (`ObjectiveService.updateObjectiveConfig(chatId, { autoCheckFrequency: 1 })`).
 * Only the `story-plan` record type reads it; other types ignore it.
 */
export const agentThreadProposalApplyRequestSchema = z.object({
  enableAutoCheck: z
    .boolean()
    .optional()
    .describe(
      "story-plan only: also enable the goal tracker's auto-check (frequency 1) with this apply.",
    ),
});
export type AgentThreadProposalApplyRequest = z.infer<typeof agentThreadProposalApplyRequestSchema>;
