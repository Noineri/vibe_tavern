import { z } from "zod";

/**
 * Wire shapes for the branch-sidechat fork pair (SIDECHAT_PLAN Wave 5 /
 * SC-20):
 *
 *   POST /api/agent/chats/:chatId/branches/:branchId/fork-sidechat
 *        body `agentBranchForkSidechatRequestSchema` → `agentBranchForkSidechatResultSchema`
 *   GET  /api/agent/chats/:chatId/branches/:branchId/sidechat-summary
 *        → `agentBranchSidechatSummarySchema`
 *
 * The fork copies the source branch's (`:branchId`) ACTIVE sidechat threads
 * onto the target branch named in the body — the target must be a CHILD of
 * the source (its `parent_branch_id`), else the typed 400
 * `target_branch_not_child_of_source`. The summary feeds SC-21's web
 * confirms: does this branch have sidechat sessions of its own?
 * `.strict()` rejects unknown keys (the api-contracts norm).
 */

/** Fork request body: the branch the sidechat copies ONTO (a child of the
 *  path's source branch). */
export const agentBranchForkSidechatRequestSchema = z
  .object({
    targetBranchId: z.string().min(1),
  })
  .strict();
export type AgentBranchForkSidechatRequest = z.infer<typeof agentBranchForkSidechatRequestSchema>;

/** Fork response: every thread the fork created on the target branch — its
 *  new thread id and its agent kind (the kinds the store actually had ACTIVE
 *  source threads for, never a hand-enumerated list). */
export const agentBranchForkSidechatResultSchema = z
  .object({
    copiedThreads: z.array(
      z.object({
        threadId: z.string(),
        agentKind: z.string(),
      }),
    ),
  })
  .strict();
export type AgentBranchForkSidechatResult = z.infer<typeof agentBranchForkSidechatResultSchema>;

/** Summary response: whether the branch has any ACTIVE (non-archived)
 *  chat-owned thread sessions, and how many. */
export const agentBranchSidechatSummarySchema = z
  .object({
    hasSessions: z.boolean(),
    count: z.number().int().nonnegative(),
  })
  .strict();
export type AgentBranchSidechatSummary = z.infer<typeof agentBranchSidechatSummarySchema>;
