/**
 * Script-owned agent plan contract (EXPERIENCE_COPILOT_PLAN_MODE_PLAN, PM-4).
 *
 * Extracted into its own module per the file-size ratchet (runtime-api.ts
 * grows only by re-export) — the same split the lorebook/script contracts
 * took. One plan per script, maintained both by the model's `plan` tool and
 * by the user editor — both paths validate through the same
 * `normalizeAgentPlan`. Reads return the empty plan when nothing is stored.
 */
export interface AgentPlanRuntimeApi {
	/** The stored plan, or the empty plan when the script has none yet. */
	getAgentPlan: (scriptId: string) => Promise<import("@vibe-tavern/api-contracts").AgentPlan>;
	/** Full-replace write. Throws NotFound for an unknown script and
	 *  Unprocessable with `details.code` `agent_plan_multiple_active` (more
	 *  than one active task) or `agent_plan_invalid` (unusable shape). */
	updateAgentPlan: (scriptId: string, plan: unknown) => Promise<import("@vibe-tavern/api-contracts").AgentPlan>;
}
