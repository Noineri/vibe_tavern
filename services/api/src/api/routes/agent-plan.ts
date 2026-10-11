import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { brandId, type ScriptId } from "@vibe-tavern/domain";
import type { AgentPlanRuntimeApi } from "../contract/runtime-api.js";

/**
 * Script-owned agent plan routes (EXPERIENCE_COPILOT_PLAN_MODE_PLAN, PM-4).
 *
 * Mirrors the script links sub-resource pair (`/api/scripts/:scriptId/links`
 * in `script.ts`) — same path-param shape, same `{ envelope }` JSON bodies:
 *
 *  - `GET /api/scripts/:scriptId/agent-plan` — `{ plan }` (the empty plan
 *    when the script has none stored yet).
 *  - `PUT /api/scripts/:scriptId/agent-plan` — body `{ plan }`, full-replace
 *    write, returns `{ plan }` normalized. Unknown scripts 404; a plan with
 *    more than one active task 422s (`agent_plan_multiple_active`); an
 *    unusable shape 422s (`agent_plan_invalid`).
 *
 * The body envelope is deliberately loose (`plan: unknown`): strict
 * `agentPlanSchema` validation here would 400 shapes that must 422 as
 * `agent_plan_invalid`, and `normalizeAgentPlan` is intentionally lenient
 * (drops bad tasks, defaults missing statuses). The adapter runs that same
 * shared validation the model's `plan` tool runs — this file only brands the
 * script id at the edge and forwards.
 */
export function createAgentPlanRoutes(runtime: AgentPlanRuntimeApi) {
	return new Hono()
		.get("/api/scripts/:scriptId/agent-plan", async (c) => {
			const scriptId = brandId<ScriptId>(c.req.param("scriptId"));
			return c.json({ plan: await runtime.getAgentPlan(scriptId) });
		})
		.put(
			"/api/scripts/:scriptId/agent-plan",
			zValidator("json", z.object({ plan: z.unknown() })),
			async (c) => {
				const scriptId = brandId<ScriptId>(c.req.param("scriptId"));
				return c.json({ plan: await runtime.updateAgentPlan(scriptId, c.req.valid("json").plan) });
			},
		);
}
