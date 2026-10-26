import type { AgentPlanRuntimeApi } from "../contract/runtime-api.js";
import type { StoreContainer } from "@vibe-tavern/db";
import {
	EMPTY_AGENT_PLAN,
	brandId,
	type AgentPlan,
	type AgentPlanOwner,
	type ChatBranchId,
	type ChatId,
} from "@vibe-tavern/domain";
import { notFound } from "../../shared/errors.js";
import { requireChatBranch } from "../../domain/chat/chat-branch-ownership.js";
import { normalizePlanForSave } from "../../domain/agent-plan/agent-plan-validation.js";
import type { StoryPlanSync } from "../../domain/director/story-plan-sync.js";

/**
 * Thin adapter between the `AgentPlanRuntimeApi` contract and the
 * `@vibe-tavern/db` `agentPlans` store (EXPERIENCE_COPILOT_PLAN_MODE_PLAN,
 * PM-4; branch owners SIDECHAT_PLAN SC-0h). Mirrors the copilot-profile
 * adapter's role: routes stay thin, the store stays a dumb row layer, and
 * every rule lives here — the owner must exist (404 otherwise: the script
 * for script owners, the chat+branch pair for branch owners), a missing row
 * reads as the empty plan, and writes run the shared normalize-or-422
 * validation (domain/agent-plan/agent-plan-validation.ts — the same
 * normalizeAgentPlan path the model's `plan` tool feeds, now also shared
 * with StoryPlanSync.applyPlan per DR-3a). DR-3b: the branch-plan PUT
 * delegates to `StoryPlanSync.applyPlan` when a sync is injected — the same
 * validation/ownership codes, plus the ACTIVE-branch projection (A5) and
 * the non-active-branch saves-without-touching-the-tracker rule, which then
 * live in the service alone (one rule, one home).
 */
export class AgentPlanAdapter implements AgentPlanRuntimeApi {
	constructor(
		private readonly stores: StoreContainer,
		/** DR-3b: the branch-plan PUT's sync delegate (StoryPlanSync.applyPlan).
		 * Optional so lifecycle-only harnesses and the plan-route
		 * characterization suites construct without it and keep the plain
		 * store-save path (byte-identical to the pre-DR-3b route); production
		 * (server-runtime → RuntimeApiAdapter) always injects the real sync.
		 */
		private readonly branchPlanSync?: Pick<StoryPlanSync, "applyPlan">,
	) {}

	getAgentPlan = async (scriptId: string): Promise<AgentPlan> => {
		await this.requireScript(scriptId);
		return (
			(await this.stores.agentPlans.get({ kind: "script", scriptId })) ?? EMPTY_AGENT_PLAN
		);
	};

	updateAgentPlan = async (scriptId: string, plan: unknown): Promise<AgentPlan> => {
		await this.requireScript(scriptId);
		return this.savePlan({ kind: "script", scriptId }, plan);
	};

	getAgentBranchPlan = async (chatId: string, branchId: string): Promise<AgentPlan> => {
		await requireChatBranch(this.stores.chats, chatId, branchId);
		return (
			(await this.stores.agentPlans.get({ kind: "chatBranch", chatId, branchId })) ??
			EMPTY_AGENT_PLAN
		);
	};

	updateAgentBranchPlan = async (
		chatId: string,
		branchId: string,
		plan: unknown,
	): Promise<AgentPlan> => {
		// DR-3b: through the sync — the same normalize-or-422 and ownership
		// 404 the fallback below runs, plus the ACTIVE-branch projection (A5:
		// goals mode + goal replacement + tracker ON when events exist); a
		// non-active branch saves without touching the tracker (the service's
		// own rule). The branded ids enter at this API edge, as everywhere.
		if (this.branchPlanSync) {
			return this.branchPlanSync.applyPlan(
				brandId<ChatId>(chatId),
				brandId<ChatBranchId>(branchId),
				plan,
			);
		}
		await requireChatBranch(this.stores.chats, chatId, branchId);
		return this.savePlan({ kind: "chatBranch", chatId, branchId }, plan);
	};

	/** The shared full-replace write both owners run: normalize-or-422 (the
	 *  shared `normalizePlanForSave`, same codes the routes have always
	 *  returned), then store. The store layer picks the table from the owner
	 *  kind. */
	private async savePlan(owner: AgentPlanOwner, plan: unknown): Promise<AgentPlan> {
		const normalized = normalizePlanForSave(plan);
		await this.stores.agentPlans.save(owner, normalized);
		return normalized;
	}

	private readonly requireScript = async (scriptId: string): Promise<void> => {
		const script = await this.stores.scripts.getById(scriptId);
		if (!script) throw notFound("Script", `Script '${scriptId}' was not found.`);
	};
}
