import { AGENT_PLAN_TASK_STATUS, normalizeAgentPlan, type AgentPlan } from "@vibe-tavern/domain";
import { unprocessable } from "../../shared/errors.js";

/**
 * The ONE normalize-or-422 path every agent-plan SAVE runs (DR-3a lifted it
 * out of the plan adapter so StoryPlanSync.applyPlan shares it — a second
 * hand-written copy would be a defect from copy #2): normalize via the shared
 * `normalizeAgentPlan` (the same validation the model's `plan` tool runs),
 * then throw the plan routes' two 422 codes when the shape is unusable.
 *
 * Consumers: `api/adapters/agent-plan-adapter.ts` (the script + branch plan
 * routes' full-replace save) and `domain/director/story-plan-sync.ts`
 * (StoryPlanSync.applyPlan). The 422 codes are the routes' public contract —
 * `agent_plan_multiple_active` / `agent_plan_invalid` — and must not drift
 * between the two.
 */

/** Counts raw tasks already marked active — used ONLY to pick the 422 code
 *  after `normalizeAgentPlan` has rejected the input. Validation itself stays
 *  the single shared path (the same function the model's `plan` tool runs). */
function countRawActiveTasks(raw: unknown): number {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return 0;
	const tasks = (raw as { tasks?: unknown }).tasks;
	if (!Array.isArray(tasks)) return 0;
	return tasks.filter(
		(task) =>
			typeof task === "object" &&
			task !== null &&
			(task as { status?: unknown }).status === AGENT_PLAN_TASK_STATUS.active,
	).length;
}

/**
 * Normalize a plan for a full-replace save, or throw the plan routes' 422:
 * more than one raw active task → `agent_plan_multiple_active`; any other
 * unusable shape → `agent_plan_invalid`.
 */
export function normalizePlanForSave(raw: unknown): AgentPlan {
	const normalized = normalizeAgentPlan(raw);
	if (normalized !== null) return normalized;
	const multipleActive = countRawActiveTasks(raw) > 1;
	throw unprocessable(
		multipleActive
			? "At most one task can be active."
			: "The plan is invalid.",
		{
			code: multipleActive ? "agent_plan_multiple_active" : "agent_plan_invalid",
		},
	);
}
