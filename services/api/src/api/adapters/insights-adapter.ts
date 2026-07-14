import { brandId, type ChatId, type ObjectiveState, type ObjectiveTaskStatus } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import type { SessionRuntime } from "../../runtime/session/session-runtime.js";
import type { ProviderProfileService } from "../../domain/providers/provider-profile-service.js";
import type { ConfigPatchResponse, InsightsCompletionPatchResponse } from "../contract/session-types.js";
import { notFound, validation } from "../../shared/errors.js";
import { ObjectiveService } from "../../domain/insights/objective-service.js";

// ────────────────────────────────────────────────────────────────────────────
// InsightsAdapter — RPC surface for the Objective Tracker (INSIGHTS_PLAN INS-4)
// ────────────────────────────────────────────────────────────────────────────
// Thin glue over ObjectiveService: the manual generate/check routes need
// provider resolution + context building before calling the service's pure-ish
// generateTasks/checkCompletion (which take an already-built context + resolved
// profile). The CRUD operations (add/update/delete task, set description)
// delegate directly. Manual methods return ConfigPatchResponse; automatic work
// is delivered separately by a cancellable, target-scoped completion-refresh
// join so neither path needs a global SSE channel or a whole-session snapshot.
// ────────────────────────────────────────────────────────────────────────────

export class InsightsAdapter {
	constructor(
		private readonly stores: StoreContainer,
		private readonly sessionRuntime: SessionRuntime,
		private readonly objectiveService: ObjectiveService,
	) {}

	/** Join current forward-state work and return only its target-scoped patch. */
	refreshInsightsCompletion = async (
		chatId: string,
		body: { target: { branchId: string; messageId: string } },
		signal?: AbortSignal,
	): Promise<InsightsCompletionPatchResponse> => {
		signal?.throwIfAborted();
		await this.ensureChat(chatId);
		await this.ensureCompletionTarget(chatId, body.target);
		signal?.throwIfAborted();
		await this.objectiveService.waitForForwardState(brandId<ChatId>(chatId), signal);
		signal?.throwIfAborted();
		await this.ensureCompletionTarget(chatId, body.target);
		const objectiveState = await this.objectiveService.getState(brandId<ChatId>(chatId));
		signal?.throwIfAborted();
		return {
			target: { chatId, ...body.target },
			patch: { objectiveState },
		};
	};

	/** Generate a task route from the conversation. */
	generateObjectiveTasks = async (
		chatId: string,
		_body: { providerProfileId?: string; model?: string },
		signal?: AbortSignal,
	): Promise<ConfigPatchResponse> => {
		await this.ensureChat(chatId);
		const { profile, model, state } = await this.resolveInsightProviderOrThrow(chatId);
		const context = await this.buildContext(chatId, model, state.contextWindow);
		await this.objectiveService.generateTasks({ chatId: brandId<ChatId>(chatId), profile, model, context, signal });
		return this.refresh(chatId);
	};

	/** Manually check whether the active task is complete (advancing if so). */
	checkObjectiveCompletion = async (
		chatId: string,
		_body: { providerProfileId?: string; model?: string },
		signal?: AbortSignal,
	): Promise<ConfigPatchResponse> => {
		await this.ensureChat(chatId);
		const { profile, model, state } = await this.resolveInsightProviderOrThrow(chatId);
		const context = await this.buildContext(chatId, model, state.contextWindow);
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
		body: { description?: string; status?: ObjectiveTaskStatus },
	): Promise<ConfigPatchResponse> => {
		await this.ensureChat(chatId);
		await this.objectiveService.updateTask(brandId<ChatId>(chatId), taskId, body);
		return this.refresh(chatId);
	};

	reorderObjectiveTasks = async (chatId: string, body: { taskIds: string[] }): Promise<ConfigPatchResponse> => {
		await this.ensureChat(chatId);
		await this.objectiveService.reorderTasks(brandId<ChatId>(chatId), body.taskIds);
		return this.refresh(chatId);
	};

	deleteObjectiveTask = async (chatId: string, taskId: string): Promise<ConfigPatchResponse> => {
		await this.ensureChat(chatId);
		await this.objectiveService.deleteTask(brandId<ChatId>(chatId), taskId);
		return this.refresh(chatId);
	};

	setObjectiveDescription = async (chatId: string, body: { objectiveDescription: string }): Promise<ConfigPatchResponse> => {
		await this.ensureChat(chatId);
		await this.objectiveService.setObjectiveDescription(brandId<ChatId>(chatId), body.objectiveDescription);
		return this.refresh(chatId);
	};

	updateObjectiveConfig = async (
		chatId: string,
		body: {
			autoCheckFrequency?: number;
			contextWindow?: number;
			injectionDepth?: number;
			generatePrompt?: string;
			checkPrompt?: string;
			injectPrompt?: string;
			useChatModel?: boolean;
			providerProfileId?: string | null;
			model?: string | null;
		},
	): Promise<ConfigPatchResponse> => {
		await this.ensureChat(chatId);
		await this.objectiveService.updateObjectiveConfig(brandId<ChatId>(chatId), body);
		return this.refresh(chatId);
	};

	private async ensureChat(chatId: string): Promise<void> {
		const chat = await this.stores.chats.getById(chatId);
		if (!chat) throw notFound("Chat", `Chat '${chatId}' was not found.`);
	}

	private async ensureCompletionTarget(
		chatId: string,
		target: { branchId: string; messageId: string },
	): Promise<void> {
		const message = await this.stores.messages.getMessageById(target.messageId);
		if (!message) {
			throw notFound(
				"Message",
				`Insight completion target message '${target.messageId}' is no longer available.`,
			);
		}
		if (message.chatId !== chatId || message.branchId !== target.branchId || message.role !== "assistant") {
			throw notFound(
				"Message",
				`Insight completion target message '${target.messageId}' does not belong to chat '${chatId}' and branch '${target.branchId}'.`,
			);
		}
	}

	/**
	 * Resolve the insight provider/model from the chat's STORED ObjectiveState
	 * config (mirrors ChatSummaryService.triggerAutoSummary). The manual
	 * generate/check no longer takes provider/model from the request body — the
	 * pinned config in Build Mode → Insights is the single source of truth.
	 * Throws a validation error when nothing is configured so the UI surfaces it.
	 */
	private async resolveInsightProviderOrThrow(chatId: string): Promise<{ profile: NonNullable<Awaited<ReturnType<ProviderProfileService["resolveActiveProviderProfile"]>>>; model: string; state: ObjectiveState }> {
		const state = await this.objectiveService.getState(brandId<ChatId>(chatId));
		const resolved = await this.objectiveService.resolveInsightProvider(state);
		if (!resolved) {
			throw validation("No provider/model configured for the Objective insight. Set one in Build Mode → Insights.");
		}
		return { ...resolved, state };
	}

	private async buildContext(chatId: string, model: string, contextWindow: number) {
		const built = await this.sessionRuntime.chatLifecycle.buildPipelineContext({
			chatId: brandId<ChatId>(chatId),
			model,
			recentMessageLimit: contextWindow,
		});
		return built.context;
	}

	private refresh(chatId: string): Promise<ConfigPatchResponse> {
		// objective state lives on the chat row → return activeChat so the UI
		// (objective zone + config panel) refreshes from the next snapshot.
		return this.sessionRuntime.buildConfigPatchResponse(brandId<ChatId>(chatId), { activeChat: true });
	}
}
