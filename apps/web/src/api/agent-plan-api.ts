/**
 * Typed RPC client for the script-owned agent plan endpoints
 * (EXPERIENCE_COPILOT_PLAN_MODE_PLAN, PM-4). Mirrors the script links client
 * (`getScriptLinks`/`setScriptLinks` in `script-api.ts`) — same
 * `client.api.scripts[":scriptId"]…` chain, same `{ plan }` envelope.
 */
import type { AgentPlan } from "@vibe-tavern/api-contracts";
import { client } from "./client.js";
import { unwrapRpc } from "./unwrap.js";

/** `GET /api/scripts/:scriptId/agent-plan` — the empty plan when none is stored. */
export async function getAgentPlan(scriptId: string): Promise<AgentPlan> {
  const response = await client.api.scripts[":scriptId"]["agent-plan"].$get({
    param: { scriptId },
  });
  const data = await unwrapRpc(response);
  return data.plan;
}

/** `PUT /api/scripts/:scriptId/agent-plan` — full-replace write, returns the normalized plan. */
export async function updateAgentPlan(scriptId: string, plan: AgentPlan): Promise<AgentPlan> {
  const response = await client.api.scripts[":scriptId"]["agent-plan"].$put({
    param: { scriptId },
    json: { plan },
  });
  const data = await unwrapRpc(response);
  return data.plan;
}
