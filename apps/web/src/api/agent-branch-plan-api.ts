/**
 * Chat-branch-owned agent plan client (SIDECHAT_PLAN SC-0i) — the typed twin
 * of the script plan client (`agent-plan-api.ts`), against the SC-0h routes:
 *
 *   GET /api/agent/chats/:chatId/branches/:branchId/plan
 *   PUT /api/agent/chats/:chatId/branches/:branchId/plan
 *
 * The plan content shape is shared (never re-declared here): both routes
 * carry the `{ plan }` envelope whose content the server validates against
 * the single `agentPlanSchema` source — this client only forwards it.
 * No-plan-yet reads return the empty plan (the script route's convention).
 */
import type { AgentPlan } from "@vibe-tavern/api-contracts";
import { client } from "./client.js";
import { unwrapRpc } from "./unwrap.js";

/** `GET /api/agent/chats/:chatId/branches/:branchId/plan` — the empty plan when the branch has none stored yet. */
export async function getAgentBranchPlan(chatId: string, branchId: string): Promise<AgentPlan> {
  const response = await client.api.agent.chats[":chatId"].branches[":branchId"].plan.$get({
    param: { chatId, branchId },
  });
  const data = await unwrapRpc(response);
  return data.plan;
}

/** `PUT /api/agent/chats/:chatId/branches/:branchId/plan` — full-replace write, returns the normalized plan. */
export async function updateAgentBranchPlan(chatId: string, branchId: string, plan: AgentPlan): Promise<AgentPlan> {
  const response = await client.api.agent.chats[":chatId"].branches[":branchId"].plan.$put({
    param: { chatId, branchId },
    json: { plan },
  });
  const data = await unwrapRpc(response);
  return data.plan;
}
