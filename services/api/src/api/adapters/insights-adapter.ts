import { brandId, ensureActiveObjectiveTarget, type ChatBranchId, type ChatId, type MessageId, type MessageVariantId, type ObjectiveMode, type ObjectiveState, type ObjectiveTaskStatus, type SceneBackfillMode, type SceneTrackerConfig } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import type { SessionRuntime } from "../../runtime/session/session-runtime.js";
import type { ProviderProfileService } from "../../domain/providers/provider-profile-service.js";
import type { ConfigPatchResponse, InsightsCompletionPatchResponse, SceneBackfillStatusResponse, ScenePreviewResponse, SceneStatusResponse, SceneTargetResponse } from "../contract/session-types.js";
import { mapMessageDto } from "../../runtime/session/session-runtime-dto.js";
import { conflict, notFound, validation } from "../../shared/errors.js";
import { ObjectiveService } from "../../domain/insights/objective-service.js";
import { SceneTrackerService, type SceneTarget } from "../../domain/insights/tracker-service.js";
import { logSendDebug } from "../../shared/send-debug-log.js";

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
		private readonly trackerService: SceneTrackerService,
	) {}

	/** Join current forward-state work and return only its target-scoped patch.
	 *  Objective + Scene are joined CONCURRENTLY (Promise.all); each wait is
	 *  individually failure-contained — a non-abort error is logged + swallowed so
	 *  one auxiliary feature never blocks the other, while an abort PROPAGATES (the
	 *  refresh is cancelled) without cancelling either shared job. When the target
	 *  carries a `variantId`, the Scene join targets the exact variant's job and
	 *  the scoped message patch is returned; otherwise the Scene join is the
	 *  chat-level latest-target wait and only the Objective patch is returned. */
	refreshInsightsCompletion = async (
		chatId: string,
		body: { target: { branchId: string; messageId: string; variantId?: string } },
		signal?: AbortSignal,
	): Promise<InsightsCompletionPatchResponse> => {
		signal?.throwIfAborted();
		await this.ensureChat(chatId);
		await this.ensureCompletionTarget(chatId, body.target);
		signal?.throwIfAborted();

		const variantId = body.target.variantId;
		const sceneTarget = variantId
			? this.sceneTargetFrom(chatId, { branchId: body.target.branchId, messageId: body.target.messageId, variantId })
			: undefined;
		await Promise.all([
			this.waitContained(this.objectiveService.waitForForwardState(brandId<ChatId>(chatId), signal), signal, "objective"),
			this.waitContained(
				sceneTarget
					? this.trackerService.waitForTarget(sceneTarget, signal)
					: this.trackerService.waitForForwardState(brandId<ChatId>(chatId), signal),
				signal,
				"scene",
			),
		]);
		signal?.throwIfAborted();
		await this.ensureCompletionTarget(chatId, body.target);
		const rawState = await this.objectiveService.getState(brandId<ChatId>(chatId));
		const objectiveState: ObjectiveState = {
			...rawState,
			tasks: ensureActiveObjectiveTarget(rawState.tasks),
			shortTermGoals: ensureActiveObjectiveTarget(rawState.shortTermGoals),
		};
		signal?.throwIfAborted();
		const message = body.target.variantId
			? await this.buildTargetMessageDto(body.target.messageId)
			: undefined;
		return {
			target: { chatId, ...body.target },
			patch: { objectiveState, ...(message ? { message } : {}) },
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

	setObjectiveMode = async (chatId: string, body: { mode: ObjectiveMode }): Promise<ConfigPatchResponse> => {
		await this.ensureChat(chatId);
		await this.objectiveService.setObjectiveMode(brandId<ChatId>(chatId), body.mode);
		return this.refresh(chatId);
	};

	updateObjectiveLongTermGoal = async (
		chatId: string,
		body: { description?: string; status?: ObjectiveTaskStatus },
	): Promise<ConfigPatchResponse> => {
		await this.ensureChat(chatId);
		await this.objectiveService.updateLongTermGoal(brandId<ChatId>(chatId), body);
		return this.refresh(chatId);
	};

	addObjectiveShortTermGoal = async (chatId: string, body: { description: string }): Promise<ConfigPatchResponse> => {
		await this.ensureChat(chatId);
		await this.objectiveService.addShortTermGoal(brandId<ChatId>(chatId), body.description);
		return this.refresh(chatId);
	};

	updateObjectiveShortTermGoal = async (
		chatId: string,
		goalId: string,
		body: { description?: string; status?: ObjectiveTaskStatus },
	): Promise<ConfigPatchResponse> => {
		await this.ensureChat(chatId);
		await this.objectiveService.updateShortTermGoal(brandId<ChatId>(chatId), goalId, body);
		return this.refresh(chatId);
	};

	deleteObjectiveShortTermGoal = async (chatId: string, goalId: string): Promise<ConfigPatchResponse> => {
		await this.ensureChat(chatId);
		await this.objectiveService.deleteShortTermGoal(brandId<ChatId>(chatId), goalId);
		return this.refresh(chatId);
	};

	selectObjectiveShortTermGoal = async (chatId: string, body: { goalId: string }): Promise<ConfigPatchResponse> => {
		await this.ensureChat(chatId);
		await this.objectiveService.selectShortTermGoal(brandId<ChatId>(chatId), body.goalId);
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

	// ─── Scene Tracker manual routes (SCENE_TRACKER_PLAN SCN-9) ──────────────

	/** Generate (or regenerate) a Scene record for the target variant via the LLM.
	 *  Serves both the missing-record Generate and the existing-record Update
	 *  actions — the service overwrites the prior record ONLY on success, so a
	 *  failure/cancel never erases a valid record. Returns the scoped message patch. */
	generateScene = async (
		chatId: string,
		body: { target: { branchId: string; messageId: string; variantId: string } },
		signal?: AbortSignal,
	): Promise<SceneTargetResponse> => {
		const target = this.sceneTargetFrom(chatId, body.target);
		await this.ensureSceneTarget(chatId, body.target);
		await this.ensureLatestAssistantTarget(chatId, body.target);
		await this.trackerService.generateForTarget(target, signal);
		return { target: { chatId, ...body.target }, message: await this.buildTargetMessageDto(body.target.messageId) };
	};

	/** Manual structured edit of the target variant's scene state (no LLM). The
	 *  service validates strictly against the current DSL and throws path-specific
	 *  errors on mismatch — nothing persists on validation failure. */
	editScene = async (
		chatId: string,
		body: { target: { branchId: string; messageId: string; variantId: string }; sceneState: Record<string, unknown> },
	): Promise<SceneTargetResponse> => {
		const target = this.sceneTargetFrom(chatId, body.target);
		await this.ensureSceneTarget(chatId, body.target);
		await this.trackerService.editScene(target, body.sceneState);
		return { target: { chatId, ...body.target }, message: await this.buildTargetMessageDto(body.target.messageId) };
	};

	/** Remove the target variant's record. Returns the scoped message patch (the
	 *  variant now carries no record). */
	deleteScene = async (
		chatId: string,
		body: { target: { branchId: string; messageId: string; variantId: string } },
	): Promise<SceneTargetResponse> => {
		const target = this.sceneTargetFrom(chatId, body.target);
		await this.ensureSceneTarget(chatId, body.target);
		await this.trackerService.deleteScene(target);
		return { target: { chatId, ...body.target }, message: await this.buildTargetMessageDto(body.target.messageId) };
	};

	/** Explicitly cancel an in-flight generation for the target. Aborts the
	 *  coordinator's owned controller; the generation rejects and NOTHING
	 *  persists (the prior record, if any, is preserved). No-op when no
	 *  generation is active. */
	cancelScene = (chatId: string, body: { target: { branchId: string; messageId: string; variantId: string } }): { target: { chatId: string; branchId: string; messageId: string; variantId: string }; cancelled: true } => {
		this.trackerService.cancelTarget(this.sceneTargetFrom(chatId, body.target));
		return { target: { chatId, ...body.target }, cancelled: true };
	};

	/** Server-authoritative Scene status for reload/multi-tab hydration and edit
	 *  preflight: `generating` reflects the target coordinator, `record` is the
	 *  variant's current canonical record (null when absent). */
	getSceneStatus = async (
		chatId: string,
		body: { target: { branchId: string; messageId: string; variantId: string } },
	): Promise<SceneStatusResponse> => {
		const target = this.sceneTargetFrom(chatId, body.target);
		await this.ensureSceneTarget(chatId, body.target);
		const record = await this.trackerService.getRecord(target);
		return { target: { chatId, ...body.target }, generating: this.trackerService.hasTargetJob(target), record };
	};

	/** Non-persisting Scene preview (SCN-11): trial-run the generate pipeline with
	 *  a DRAFT config against the target variant; returns the would-be scene state
	 *  WITHOUT committing. The config editor uses this to validate a
	 *  schema/prompt/model change before saving. Forwards the request signal so the
	 *  trial is cancellable. */
	previewScene = async (
		chatId: string,
		body: { target: { branchId: string; messageId: string; variantId: string }; config: SceneTrackerConfig },
		signal?: AbortSignal,
	): Promise<ScenePreviewResponse> => {
		const target = this.sceneTargetFrom(chatId, body.target);
		await this.ensureSceneTarget(chatId, body.target);
		const record = await this.trackerService.previewForTarget(target, body.config, signal);
		return { target: { chatId, ...body.target }, sceneState: record.sceneState };
	};

	// ─── Scene Tracker history backfill (SCENE_TRACKER_PLAN SCN-14) ───────────

	/** Start a durable backfill run for the chat's active branch. Freezes the
	 *  manifest, kicks off the background loop, and returns the initial status.
	 *  Idempotent: reattaches to an in-flight run. The run runs fire-and-forget —
	 *  it never blocks ordinary chat; only the latest selected target can join a
	 *  normal send wait. */
	startSceneBackfill = async (chatId: string, mode: string): Promise<SceneBackfillStatusResponse> => {
		return this.trackerService.startBackfill(brandId<ChatId>(chatId), mode as SceneBackfillMode);
	};

	/** Server-authoritative backfill status for progress polling + reload
	 *  reattachment. A stale 'running' run (interrupted by a restart) is resumed. */
	getSceneBackfillStatus = async (chatId: string, runId: string): Promise<SceneBackfillStatusResponse> => {
		return this.trackerService.getBackfillStatus(brandId<ChatId>(chatId), runId);
	};

	/** Explicitly cancel a run: aborts the active item (nothing persists) and
	 *  stops the loop before the next item. */
	cancelSceneBackfill = (chatId: string, runId: string): { runId: string; cancelled: true } => {
		this.trackerService.cancelBackfill(brandId<ChatId>(chatId), runId);
		return { runId, cancelled: true };
	};

	/** Retry/resume a terminal run's failed + unprocessed frozen-manifest items. */
	retrySceneBackfill = async (chatId: string, runId: string): Promise<SceneBackfillStatusResponse> => {
		return this.trackerService.retryBackfill(brandId<ChatId>(chatId), runId);
	};

	/**
	 * Validate the full immutable ownership chain for a Scene target: the message
	 * exists, belongs to this chat + branch, is an assistant message, and the
	 * variant id is one of its variants. `variantId` is canonical — never accepts
	 * an index. Throws notFound on any mismatch.
	 */
	private async ensureSceneTarget(chatId: string, target: { branchId: string; messageId: string; variantId: string }): Promise<void> {
		await this.ensureCompletionTarget(chatId, target);
		const variants = await this.stores.messages.getVariants(target.messageId);
		if (!variants.some((variant) => variant.id === target.variantId)) {
			throw notFound(
				"Variant",
				`Scene target variant '${target.variantId}' is no longer available on message '${target.messageId}'.`,
			);
		}
	}

	/** Ordinary LLM Generate/Update is allowed ONLY for the active branch's latest
	 *  selected assistant variant (step 3). Older persisted records are view/edit/
	 *  delete only; their LLM replacement goes through explicit history backfill/rebuild.
	 *  Manual editScene/deleteScene are intentionally NOT gated here. */
	private async ensureLatestAssistantTarget(chatId: string, target: { branchId: string; messageId: string; variantId: string }): Promise<void> {
		const branch = await this.stores.chats.getActiveBranch(chatId);
		const branchId = branch?.id ?? target.branchId;
		const latest = await this.stores.messages.getLatestSelectedVariant(branchId);
		if (!latest || latest.messageId !== target.messageId || latest.variantId !== target.variantId) {
			throw conflict(
				"Scene LLM generation is only available for the latest assistant message; use history backfill to regenerate older records.",
				{ target, latest },
			);
		}
	}

	/** Brand a validated body target into a service {@link SceneTarget}. */
	private sceneTargetFrom(chatId: string, target: { branchId: string; messageId: string; variantId: string }): SceneTarget {
		return {
			chatId: brandId<ChatId>(chatId),
			branchId: brandId<ChatBranchId>(target.branchId),
			messageId: brandId<MessageId>(target.messageId),
			variantId: brandId<MessageVariantId>(target.variantId),
		};
	}

	/** Build the fresh message DTO (variants carry their per-variant Scene records). */
	private async buildTargetMessageDto(messageId: string) {
		const message = await this.stores.messages.getMessageById(messageId);
		if (!message) {
			throw notFound("Message", `Scene target message '${messageId}' is no longer available.`);
		}
		const variants = await this.stores.messages.getVariants(messageId);
		return mapMessageDto(message, variants);
	}

	/**
	 * Contain one auxiliary forward-state wait: a non-abort error is logged +
	 * swallowed (one feature never blocks the other), while an abort PROPAGATES so
	 * the refresh is cancelled. The shared job is untouched either way (each
	 * feature's wait detaches on abort without aborting its job).
	 */
	private waitContained(promise: Promise<void>, signal: AbortSignal | undefined, label: string): Promise<void> {
		return promise.catch((error: unknown) => {
			if (signal?.aborted) throw error;
			logSendDebug("insights.completion.wait.swallowed", {
				label,
				message: error instanceof Error ? error.message : String(error),
			});
		});
	}

	private async ensureCompletionTarget(
		chatId: string,
		target: { branchId: string; messageId: string; variantId?: string },
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
		// When a variant is named, confirm it still belongs to the target message —
		// a swipe/delete may have removed it while a job was in flight.
		if (target.variantId) {
			const variants = await this.stores.messages.getVariants(target.messageId);
			if (!variants.some((variant) => variant.id === target.variantId)) {
				throw notFound(
					"Variant",
					`Insight completion target variant '${target.variantId}' is no longer available on message '${target.messageId}'.`,
				);
			}
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
