/**
 * Branch-sidechat fork routes (SIDECHAT_PLAN Wave 5 / SC-20) — the chat-owner
 * family of SC-0b's session routes:
 *
 *   POST /api/agent/chats/:chatId/branches/:branchId/fork-sidechat  { targetBranchId }
 *   GET  /api/agent/chats/:chatId/branches/:branchId/sidechat-summary
 *
 * Both delegate to the `ExperienceCopilotRuntimeApi` members, which wire
 * `domain/sidechat/branch-sidechat-fork.ts`: the fork copies the source
 * branch's ACTIVE sidechat threads (messages, events, context links, todo;
 * metrics reset) plus the branch plan onto the target branch, appending the
 * `branch_forked { at }` separator; the summary answers
 * `{ hasSessions, count }` for SC-21's web confirms.
 *
 * Error shapes, inherited from the domain module through the app-level
 * mapping: 404 for a missing chat / source branch / target branch (the
 * SC-0b family's `notFound`s), the typed 400
 * `target_branch_not_child_of_source` when the target is not a child of the
 * source (the lowercase family of `attached_variant_not_in_branch`). No
 * agent-kind segment here: the fork serves EVERY kind the store has active
 * threads for, never a hand-enumerated list.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";
import type { ExperienceCopilotRuntimeApi } from "../contract/runtime-api.js";

export function createAgentBranchSidechatRoutes(runtime: ExperienceCopilotRuntimeApi) {
  return new Hono()
    .post(
      "/api/agent/chats/:chatId/branches/:branchId/fork-sidechat",
      zValidator("json", schemas.agentBranchForkSidechatRequestSchema),
      async (c) => {
        const { chatId, branchId } = c.req.param();
        const body = c.req.valid("json");
        return c.json(await runtime.agentBranchForkSidechat(chatId, branchId, body.targetBranchId));
      },
    )
    .get("/api/agent/chats/:chatId/branches/:branchId/sidechat-summary", async (c) => {
      const { chatId, branchId } = c.req.param();
      return c.json(await runtime.agentBranchSidechatSummary(chatId, branchId));
    });
}
