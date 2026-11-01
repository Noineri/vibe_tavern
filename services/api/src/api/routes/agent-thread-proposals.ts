/**
 * Thread proposal resolution routes (SIDECHAT_PLAN Wave 3 / SC-11;
 * DIRECTOR_MODE_PLAN DR-5):
 *
 *   POST /api/agent/threads/:threadId/proposals/:toolCallId/apply
 *   POST /api/agent/threads/:threadId/proposals/:toolCallId/reject
 *
 * The user-side Accept/Reject of a sidechat record proposal. The route never
 * branches on the proposal's `recordType`: both decisions delegate to the
 * dedicated `AgentThreadProposalAdapter` member, which resolves through the
 * ONE dispatch table (`SIDECHAT_RECORD_PROPOSAL_REGISTRY` — G1) in
 * `domain/sidechat/sidechat-objective-proposal.ts` — thread ownership
 * (chat-owned `sidechat-ooc`, the chat from the THREAD row), toolCallId
 * validation, pending status, the recordType's domain write and the status
 * write (after it) all live there.
 *
 * The apply body is optional (`.optional()` on the validator — the
 * agent-chat-sessions precedent: a body-less POST parses as `{}`): the
 * objective apply never carried one; `enableAutoCheck` rides the story-plan
 * Accept (A6, DR-5). Reject stays body-less.
 *
 * Errors surface as DomainErrors through the app-level mapping: 404 for a
 * foreign/non-proposal toolCallId, typed 409s for a disabled tracker
 * (`objective_tracker_disabled`) and an already-resolved proposal
 * (`objective_proposal_already_resolved`), and the typed 422
 * `unknown_proposal_record_type` for a recordType the registry does not
 * know (refused before any write).
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";
import type { AgentThreadProposalsRuntimeApi } from "../contract/runtime-api.js";

export function createAgentThreadProposalRoutes(runtime: AgentThreadProposalsRuntimeApi) {
  return new Hono()
    .post(
      "/api/agent/threads/:threadId/proposals/:toolCallId/apply",
      zValidator("json", schemas.agentThreadProposalApplyRequestSchema.optional()),
      async (c) => {
        const { threadId, toolCallId } = c.req.param();
        return c.json(
          await runtime.agentThreadApplyProposal(threadId, toolCallId, c.req.valid("json") ?? {}),
        );
      },
    )
    .post("/api/agent/threads/:threadId/proposals/:toolCallId/reject", async (c) => {
      const { threadId, toolCallId } = c.req.param();
      return c.json(await runtime.agentThreadRejectProposal(threadId, toolCallId));
    });
}
