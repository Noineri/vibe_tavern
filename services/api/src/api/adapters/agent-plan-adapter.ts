import type { AgentPlanRuntimeApi } from "../contract/runtime-api.js";
import type { StoreContainer } from "@vibe-tavern/db";
import {
	AGENT_PLAN_TASK_STATUS,
	EMPTY_AGENT_PLAN,
	normalizeAgentPlan,
	type AgentPlan,
} from "@vibe-tavern/domain";
import { notFound, unprocessable } from "../../shared/errors.js";

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
 * Thin adapter between the `AgentPlanRuntimeApi` contract and the
 * `@vibe-tavern/db` `agentPlans` store (EXPERIENCE_COPILOT_PLAN_MODE_PLAN,
 * PM-4). Mirrors the copilot-profile adapter's role: routes stay thin, the
 * store stays a dumb row layer, and every rule lives here — the script must
 * exist (404 otherwise), a missing row reads as the empty plan, and writes
 * run the same `normalizeAgentPlan` validation as the model's `plan` tool.
 */
export class AgentPlanAdapter implements AgentPlanRuntimeApi {
	constructor(private readonly stores: StoreContainer) {}

	getAgentPlan = async (scriptId: string): Promise<AgentPlan> => {
		await this.requireScript(scriptId);
		return (
			(await this.stores.agentPlans.get({ kind: "script", scriptId })) ?? EMPTY_AGENT_PLAN
		);
	};

	updateAgentPlan = async (scriptId: string, plan: unknown): Promise<AgentPlan> => {
		await this.requireScript(scriptId);
		const normalized = normalizeAgentPlan(plan);
		if (normalized === null) {
			const multipleActive = countRawActiveTasks(plan) > 1;
			throw unprocessable(
				multipleActive
					? "At most one task can be active."
					: "The plan is invalid.",
				{
					code: multipleActive ? "agent_plan_multiple_active" : "agent_plan_invalid",
				},
			);
		}
		await this.stores.agentPlans.save({ kind: "script", scriptId }, normalized);
		return normalized;
	};

	private readonly requireScript = async (scriptId: string): Promise<void> => {
		const script = await this.stores.scripts.getById(scriptId);
		if (!script) throw notFound("Script", `Script '${scriptId}' was not found.`);
	};
}
