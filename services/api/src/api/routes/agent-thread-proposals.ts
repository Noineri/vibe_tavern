/**
 * Thread proposal resolution routes (SIDECHAT_PLAN Wave 3 / SC-11):
 *
 *   POST /api/agent/threads/:threadId/proposals/:toolCallId/apply
 *   POST /api/agent/threads/:threadId/proposals/:toolCallId/reject
 *
 * The user-side Accept/Reject of a sidechat `propose_objective` proposal:
 * body-less (the proposal payload lives in the addressed tool row), both
 * delegate to the dedicated `AgentThreadProposalAdapter` member, which resolves through
 * `domain/sidechat/sidechat-objective-proposal.ts` — thread ownership
 * (chat-owned `sidechat-ooc`, the chat from the THREAD row), toolCallId
 * validation, Accept-time tracker state, the reused insights services and
 * the status write all live there (the route takes the SC-11 runtime
 * contract — its own adapter slice, like every sub-interface). Errors
 * surface as DomainErrors through
 * the app-level mapping: 404 for a foreign/non-proposal toolCallId, typed
 * 409s for a disabled tracker (`objective_tracker_disabled`) and an
 * already-resolved proposal (`objective_proposal_already_resolved`).
 */
import { Hono } from "hono";
import type { AgentThreadProposalsRuntimeApi } from "../contract/runtime-api.js";

export function createAgentThreadProposalRoutes(runtime: AgentThreadProposalsRuntimeApi) {
  return new Hono()
    .post("/api/agent/threads/:threadId/proposals/:toolCallId/apply", async (c) => {
      const { threadId, toolCallId } = c.req.param();
      return c.json(await runtime.agentThreadApplyObjectiveProposal(threadId, toolCallId));
    })
    .post("/api/agent/threads/:threadId/proposals/:toolCallId/reject", async (c) => {
      const { threadId, toolCallId } = c.req.param();
      return c.json(await runtime.agentThreadRejectObjectiveProposal(threadId, toolCallId));
    });
}
