import { brandId, OBJECTIVE_TASK_STATUS, type ChatId, type ObjectiveTaskStatus } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import type { SessionRuntime } from "../../runtime/session/session-runtime.js";
import type { ProviderProfileService } from "../../domain/providers/provider-profile-service.js";
import type { ConfigPatchResponse } from "../contract/session-types.js";
import { notFound, validation } from "../../shared/errors.js";
import { OBJECTIVE_CONTEXT_WINDOW, ObjectiveService } from "../../domain/insights/objective-service.js";

// ────────────────────────────────────────────────────────────────────────────
// InsightsAdapter — RPC surface for the Objective Tracker (INSIGHTS_PLAN INS-4)
// ────────────────────────────────────────────────────────────────────────────
// Thin glue over ObjectiveService: the manual generate/check routes need
// provider resolution + context building before calling the service's pure-ish
// generateTasks/checkCompletion (which take an already-built context + resolved
// profile). The CRUD operations (add/update/delete task, set description)
// delegate directly. Every method persists the new state (inside the service)
// and returns a ConfigPatchResponse so the UI refreshes the chat row — no SSE
// (manual actions return via RPC; auto checks persist + refresh on snapshot).
// ────────────────────────────────────────────────────────────────────────────

export class InsightsAdapter {
	constructor(
		private readonly stores: StoreContainer,
		private readonly sessionRuntime: SessionRuntime,
		private readonly providerProfiles: ProviderProfileService,
		private readonly objectiveService: ObjectiveService,
	) {}

	/** Generate a task route from the conversation. */
	generateObjectiveTasks = async (
		chatId: string,
		body: { providerProfileId?: string; model?: string },
		signal?: AbortSignal,
	): Promise<ConfigPatchResponse> => {
		await this.ensureChat(chatId);
		const { profile, model } = await this.resolveProvider(body);
		const context = await this.buildContext(chatId, model);
		await this.objectiveService.generateTasks({ chatId: brandId<ChatId>(chatId), profile, model, context, signal });
		return this.refresh(chatId);
	};

	/** Manually check whether the active task is complete (advancing if so). */
	checkObjectiveCompletion = async (
		chatId: string,
		body: { providerProfileId?: string; model?: string },
		signal?: AbortSignal,
	): Promise<ConfigPatchResponse> => {
		await this.ensureChat(chatId);
		const { profile, model } = await this.resolveProvider(body);
		const context = await this.buildContext(chatId, model);
		await this.objectiveService.checkCompletion({ chatId: brandId<ChatId>(chatId), profile, model, context, signal });
		return this.refresh(chatId);
	};

	addObjectiveTask = async (chatId: string, body: { description: string }): Promise<ConfigPatchResponse> => {
		await this.ensureChat(chatId);
		const description = body.description?.trim();
		if (!description) throw validation("Task description is required.");
		await this.objectiveService.addTask(brandId<ChatId>(chatId), description);
		return this.refresh(chatId);
	};

	updateObjectiveTask = async (
		chatId: string,
		taskId: string,
		body: { description?: string; status?: string },
	): Promise<ConfigPatchResponse> => {
		await this.ensureChat(chatId);
		const patch: { description?: string; status?: ObjectiveTaskStatus } = {};
		if (body.description !== undefined) patch.description = body.description.trim();
		if (body.status !== undefined) {
			const status = body.status as ObjectiveTaskStatus;
			// Guard against an unknown status string corrupting the state machine —
			// the four valid values are the only transitions the UI should send.
			const valid = [OBJECTIVE_TASK_STATUS.pending, OBJECTIVE_TASK_STATUS.active, OBJECTIVE_TASK_STATUS.completed, OBJECTIVE_TASK_STATUS.abandoned];
			if (!valid.includes(status)) throw validation(`Unknown objective task status: '${body.status}'.`);
			patch.status = status;
		}
		await this.objectiveService.updateTask(brandId<ChatId>(chatId), taskId, patch);
		return this.refresh(chatId);
	};

	deleteObjectiveTask = async (chatId: string, taskId: string): Promise<ConfigPatchResponse> => {
		await this.ensureChat(chatId);
		await this.objectiveService.deleteTask(brandId<ChatId>(chatId), taskId);
		return this.refresh(chatId);
	};

	setObjectiveDescription = async (chatId: string, body: { objectiveDescription: string }): Promise<ConfigPatchResponse> => {
		await this.ensureChat(chatId);
		await this.objectiveService.setObjectiveDescription(brandId<ChatId>(chatId), body.objectiveDescription ?? "");
		return this.refresh(chatId);
	};

	updateObjectiveConfig = async (
		chatId: string,
		body: { autoCheckFrequency?: number; injectionDepth?: number; generatePrompt?: string; checkPrompt?: string; injectPrompt?: string },
	): Promise<ConfigPatchResponse> => {
		await this.ensureChat(chatId);
		await this.objectiveService.updateObjectiveConfig(brandId<ChatId>(chatId), body);
		return this.refresh(chatId);
	};

	private async ensureChat(chatId: string): Promise<void> {
		const chat = await this.stores.chats.getById(chatId);
		if (!chat) throw notFound("Chat", `Chat '${chatId}' was not found.`);
	}

	private async resolveProvider(body: { providerProfileId?: string; model?: string }): Promise<{ profile: NonNullable<Awaited<ReturnType<ProviderProfileService["resolveActiveProviderProfile"]>>>; model: string }> {
		const profile = body.providerProfileId?.trim()
			? await this.providerProfiles.getProviderProfile(body.providerProfileId)
			: await this.providerProfiles.resolveActiveProviderProfile();
		if (!profile?.id) throw validation("No provider profile configured. Set an active provider or pass providerProfileId.");
		const model = body.model?.trim() || profile.defaultModel?.trim();
		if (!model) throw validation("Select a model for the objective model.");
		return { profile, model };
	}

	private async buildContext(chatId: string, model: string) {
		const built = await this.sessionRuntime.chatLifecycle.buildPipelineContext({
			chatId: brandId<ChatId>(chatId),
			model,
			recentMessageLimit: OBJECTIVE_CONTEXT_WINDOW,
		});
		return built.context;
	}

	private refresh(chatId: string): Promise<ConfigPatchResponse> {
		// objective state lives on the chat row → return activeChat so the UI
		// (objective zone + config panel) refreshes from the next snapshot.
		return this.sessionRuntime.buildConfigPatchResponse(brandId<ChatId>(chatId), { activeChat: true });
	}
}
