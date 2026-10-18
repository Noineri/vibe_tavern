import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AgentPlanRuntimeApi } from "../contract/runtime-api.js";

/**
 * Chat-branch-owned agent plan routes (SIDECHAT_PLAN SC-0h) — the chat-branch
 * twin of the script plan routes in agent-plan.ts:
 *
 *  - `GET /api/agent/chats/:chatId/branches/:branchId/plan` — `{ plan }` (the
 *    empty plan when the branch has none stored yet — the script route's
 *    no-plan-yet convention, consistency over invention).
 *  - `PUT /api/agent/chats/:chatId/branches/:branchId/plan` — body `{ plan }`,
 *    full-replace write, returns `{ plan }` normalized. An unknown chat, an
 *    unknown branch, or a branch belonging to a different chat is a 404 (the
 *    adapter throws the `NotFound` DomainError the app-level handler maps —
 *    the same pair check the SC-0b session routes apply); a plan with more
 *    than one active task 422s (`agent_plan_multiple_active`); an unusable
 *    shape 422s (`agent_plan_invalid`).
 *
 * The body envelope is deliberately loose (`plan: unknown`), exactly like the
 * script twin: strict `agentPlanSchema` validation here would 400 shapes that
 * must 422 as `agent_plan_invalid`, and `normalizeAgentPlan` is intentionally
 * lenient (drops bad tasks, defaults missing statuses). The adapter runs that
 * same shared validation the model's `plan` tool runs — this file only
 * forwards the (chat, branch) path pair.
 */
export function createAgentBranchPlanRoutes(runtime: AgentPlanRuntimeApi) {
	return new Hono()
		.get("/api/agent/chats/:chatId/branches/:branchId/plan", async (c) => {
			const { chatId, branchId } = c.req.param();
			return c.json({ plan: await runtime.getAgentBranchPlan(chatId, branchId) });
		})
		.put(
			"/api/agent/chats/:chatId/branches/:branchId/plan",
			zValidator("json", z.object({ plan: z.unknown() })),
			async (c) => {
				const { chatId, branchId } = c.req.param();
				return c.json({
					plan: await runtime.updateAgentBranchPlan(chatId, branchId, c.req.valid("json").plan),
				});
			},
		);
}
