import type { ChatRuntimeApi } from "../contract/runtime-api.js";
import { brandId, parseStoredAttachments, resolveEffectiveSettings, normalizeSceneTrackerConfig, applySceneTrackerConfigPatch, findInvalidXmlKeys, SCENE_PROMPT_FORMAT, COAUTHOR_TRANSPORT, type ChatId, type ChatBranchId, type MessageId, type MessageVariantId, type PromptPresetId, type SceneTrackerConfigPatch, type CoauthorContextLink, type CoauthorTransport, type StoredProviderProfileRecord } from "@vibe-tavern/domain";
import { rebuildCurrentSceneCache } from "../../domain/insights/scene-cache.js";
import type { Attachment } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import { validation, notFound } from "../../shared/errors.js";
import { logSendDebug } from "../../shared/send-debug-log.js";
import type { SessionRuntime } from "../../runtime/session/session-runtime.js";
import type { VariantResponse, ChatSwitchResponse, ChatCreateResponse, ChatListResponse, ConfigPatchResponse, ContextPreviewResponse } from "../contract/session-types.js";
import type { LiveChatOrchestrator } from "../../domain/chat/live-chat-orchestrator.js";
import type { ChatSummaryService } from "../../domain/chat/chat-summary-service.js";
import type { ProviderProfileService } from "../../domain/providers/provider-profile-service.js";
import type { AssetService } from "../../domain/asset/asset-service.js";
import { resolveCachedModels } from "../../domain/providers/model-cache-service.js";
import { resolveProviderFetchForProfile } from "../../domain/providers/provider-fetch-factory.js";
import { resolveVisionDescribePrompt } from "../../infrastructure/ai/vision-gate.js";
import type { RegenerateOverride, CoauthorModuleCreate, CoauthorModuleUpdate, CoauthorModule } from "@vibe-tavern/api-contracts";

export class ChatAdapter implements ChatRuntimeApi {
	constructor(
		private readonly stores: StoreContainer,
		private readonly sessionRuntime: SessionRuntime,
		private readonly liveChatOrchestrator: LiveChatOrchestrator,
		private readonly chatSummaryService: ChatSummaryService,
		private readonly providerProfileService: ProviderProfileService,
		private readonly assetService: AssetService,
	) {}

	// ─── Lifecycle ──────────────────────────────────────────────────────

	getChatSnapshot = async (chatId: string): Promise<ChatSwitchResponse> => {
		return this.sessionRuntime.chatLifecycle.switchChat(brandId<ChatId>(chatId));
	};

	createChatForCharacter = (characterId: string, mode?: import("@vibe-tavern/domain").ChatMode): Promise<ChatCreateResponse> =>
		this.sessionRuntime.chatLifecycle.createChatForCharacter(characterId, mode);

	listCoauthorChats = (characterId: string): Promise<import("../contract/session-types.js").ChatListItem[]> =>
		this.sessionRuntime.listCoauthorChats(characterId as import("@vibe-tavern/domain").CharacterId);

	applyCoauthorDraft = (
		chatId: string,
		body: import("@vibe-tavern/api-contracts").CoauthorApplyRequest,
	): Promise<import("../contract/session-types.js").CoauthorApplyResponse> =>
		this.sessionRuntime.applyCoauthorDraft(chatId as import("@vibe-tavern/domain").ChatId, body);

	cloneChat = (chatId: string) =>
		this.sessionRuntime.chatRuntime.cloneChat(chatId);

	deleteChat = (chatId: string) =>
		this.sessionRuntime.chatRuntime.deleteChat(chatId);

	clearChat = (chatId: string): Promise<ChatCreateResponse> =>
		this.sessionRuntime.chatLifecycle.clearChat(brandId<ChatId>(chatId));

	renameChat = (chatId: string, title: string): Promise<ChatListResponse> =>
		this.sessionRuntime.chatRuntime.renameChat(chatId, title);

	setGreetingIndex = async (chatId: string, greetingIndex: number): Promise<VariantResponse> => {
		return this.sessionRuntime.setGreetingIndex(brandId<ChatId>(chatId), greetingIndex);
	};

	setCoauthorContextLinks = async (chatId: string, links: CoauthorContextLink[]): Promise<VariantResponse> => {
		return this.sessionRuntime.setCoauthorContextLinks(brandId<ChatId>(chatId), links);
	};

	setChatPersona = (chatId: string, personaId: string) =>
		this.sessionRuntime.persona.setChatPersona(brandId<ChatId>(chatId), personaId);

	setChatPromptPreset = (chatId: string, promptPresetId: string) =>
		this.sessionRuntime.chatLifecycle.setChatPromptPreset(brandId<ChatId>(chatId), promptPresetId);

	setCoauthorModule = (chatId: string, moduleId: string | null) =>
		this.sessionRuntime.chatLifecycle.setCoauthorModule(brandId<ChatId>(chatId), moduleId);

	listCoauthorModules = async () => {
		const { getCoauthorModules } = await import("../../domain/coauthor/modules/module-registry.js");
		const userModules = await this.stores.coauthorModules.list();
		return getCoauthorModules(userModules);
	};

	createCoauthorModule = async (input: CoauthorModuleCreate): Promise<CoauthorModule> => {
		return toCoauthorModule(await this.stores.coauthorModules.create(input));
	};

	updateCoauthorModule = async (id: string, input: CoauthorModuleUpdate): Promise<CoauthorModule> => {
		return toCoauthorModule(await this.stores.coauthorModules.update(id, input));
	};

	deleteCoauthorModule = async (id: string) => {
		// Deletion of the active module on any chat falls back to default at
		// resolve time (getCoauthorModule's tail branch), so no chat rewiring is
		// needed here — null/unknown ids resolve to the default seed module.
		return this.stores.coauthorModules.delete(id);
	};

	// ─── Branches ───────────────────────────────────────────────────────

	branchChat = (chatId: string, messageId: string) =>
		this.sessionRuntime.chatRuntime.forkBranch(brandId<ChatId>(chatId), messageId);

	forkBranch = (chatId: string, fromMessageId?: string) =>
		this.sessionRuntime.chatRuntime.forkBranch(brandId<ChatId>(chatId), fromMessageId);

	activateBranch = (chatId: string, branchId: string) =>
		this.sessionRuntime.chatRuntime.activateBranch(brandId<ChatId>(chatId), brandId<ChatBranchId>(branchId));

	deleteBranch = (chatId: string, branchId: string) =>
		this.sessionRuntime.chatRuntime.deleteBranch(chatId, branchId);

	renameBranch = (chatId: string, branchId: string, label: string) =>
		this.sessionRuntime.chatRuntime.renameBranch(brandId<ChatId>(chatId), branchId, label);

	// ─── Messages (AI) ──────────────────────────────────────────────────

	sendMessage = async (chatId: string, body: { content: string; attachments?: Attachment[]; diceMode?: "normal" | "immersive"; pendingRevision?: number; experienceAttachmentId?: string; experienceQueueRevision?: number; experienceSessionRevision?: number }, signal?: AbortSignal) => {
		logSendDebug("api.runtime.send.start", { chatId, contentLength: body.content?.length ?? 0 });
		const { profile, transport } = await this.resolveEffectiveProfileOrThrow({ chatId });
		logSendDebug("api.runtime.send.profile", {
			chatId,
			profileId: profile.id,
			providerType: profile.providerPreset,
			endpoint: profile.endpoint,
			model: profile.defaultModel,
			contextBudget: profile.contextBudget,
		});
		const result = await this.liveChatOrchestrator.sendMessage({
			chatId,
			content: body.content,
			attachments: body.attachments,
			profile,
			model: profile.defaultModel,
			transport,
			signal,
			diceCommit: resolveDiceCommit(body),
			experienceCommit: resolveExperienceCommit(body),
			visionAssets: {
				cachedModels: await resolveCachedModels(this.stores, profile),
				visionModel: profile.visionModel,
				assetLoader: (assetId: string) => this.assetService.loadBuffer(assetId),
				visionDescribePrompt: await this.resolveVisionDescribePromptFromPreset(),
			},
		});
		logSendDebug("api.runtime.send.success", {
			chatId,
			replyLength: result.reply.length,
			preparedMessageCount: result.preparedMessageCount,
			promptMessageCount: result.promptMessageCount,
		});
		return result.snapshot;
	};

	sendMessageStream = async function* (this: ChatAdapter, chatId: string, body: { content: string; attachments?: Attachment[]; diceMode?: "normal" | "immersive"; pendingRevision?: number; experienceAttachmentId?: string; experienceQueueRevision?: number; experienceSessionRevision?: number }, signal?: AbortSignal) {
		const { profile, transport } = await this.resolveEffectiveProfileOrThrow({ chatId });
		try {
			yield* this.liveChatOrchestrator.sendMessageStream({
				chatId,
				content: body.content,
				attachments: body.attachments,
				profile,
				model: profile.defaultModel,
				transport,
				signal,
				diceCommit: resolveDiceCommit(body),
				experienceCommit: resolveExperienceCommit(body),
				visionAssets: {
					cachedModels: await resolveCachedModels(this.stores, profile),
					visionModel: profile.visionModel,
					assetLoader: (assetId: string) => this.assetService.loadBuffer(assetId),
					visionDescribePrompt: await this.resolveVisionDescribePromptFromPreset(),
				},
			});
		} catch (err) {
			if (err instanceof (await import("../../infrastructure/ai/vision-gate.js")).VisionNotSupportedError) {
				yield { event: "error", data: JSON.stringify({ type: "vision_not_supported", message: err.message, attachments: err.attachmentNames }) };
				return;
			}
			throw err;
		}
	};

	regenerateMessage = async (chatId: string, messageId: string, override?: RegenerateOverride, signal?: AbortSignal) => {
		const { profile, transport } = await this.resolveEffectiveProfileOrThrow({ chatId, modelOverride: override?.model });
		const result = await this.liveChatOrchestrator.regenerateMessage({
			chatId,
			messageId,
			profile,
			model: profile.defaultModel,
			transport,
			presetId: override?.promptPresetId ? brandId<PromptPresetId>(override.promptPresetId) : undefined,
			signal,
		});
		return result.snapshot;
	};

	regenerateMessageStream = async function* (this: ChatAdapter, chatId: string, messageId: string, override?: RegenerateOverride, signal?: AbortSignal) {
		const { profile, transport } = await this.resolveEffectiveProfileOrThrow({ chatId, modelOverride: override?.model });
		yield* this.liveChatOrchestrator.regenerateMessageStream({
			chatId,
			messageId,
			profile,
			model: profile.defaultModel,
			transport,
			presetId: override?.promptPresetId ? brandId<PromptPresetId>(override.promptPresetId) : undefined,
			signal,
		});
	};

	generateReply = async (chatId: string, signal?: AbortSignal) => {
		const { profile, transport } = await this.resolveEffectiveProfileOrThrow({ chatId });
		const result = await this.liveChatOrchestrator.generateReply({
			chatId,
			profile,
			model: profile.defaultModel,
			transport,
			signal,
		});
		return result.snapshot;
	};

	generateReplyStream = async function* (this: ChatAdapter, chatId: string, signal?: AbortSignal) {
		const { profile, transport } = await this.resolveEffectiveProfileOrThrow({ chatId });
		yield* this.liveChatOrchestrator.generateReplyStream({
			chatId,
			profile,
			model: profile.defaultModel,
			transport,
			signal,
		});
	};

	// ─── Messages (CRUD) ────────────────────────────────────────────────

	selectVariant = (chatId: string, messageId: string, variantIndex: number) =>
		this.sessionRuntime.chatRuntime.selectMessageVariant(brandId<ChatId>(chatId), brandId<MessageId>(messageId), variantIndex);

	addEditorVariant = (
		chatId: string,
		messageId: string,
		body: {
			readonly content: string;
			readonly sourceVariantIds: readonly MessageVariantId[];
			readonly modelId?: string;
			readonly promptPresetId?: string;
			readonly finishReason?: string;
		},
	) => this.sessionRuntime.chatRuntime.addEditorVariant(
		brandId<ChatId>(chatId),
		brandId<MessageId>(messageId),
		body,
	);

	deleteVariant = (chatId: string, messageId: string, variantIndex: number) =>
		this.sessionRuntime.chatRuntime.deleteMessageVariant(brandId<ChatId>(chatId), brandId<MessageId>(messageId), variantIndex);

	editMessage = (chatId: string, messageId: string, content: string, expectedVariantId?: MessageVariantId) =>
		this.sessionRuntime.chatRuntime.editMessage(brandId<ChatId>(chatId), messageId, content, expectedVariantId);

	updateAttachmentDescription = async (chatId: string, messageId: string, attachmentId: string, description: string) => {
		await this.sessionRuntime.chatApp.updateSingleAttachmentDescription(messageId, attachmentId, description);
		return { ok: true };
	};

	/**
	 * Force re-describe a single attachment via the configured vision model,
	 * ignoring any existing (possibly hand-edited) description. Uses the SAME
	 * vision resolution path as send: active profile's visionModel + the
	 * `vision_describe` system prompt. Exposed for the lightbox "regenerate"
	 * button so the auto-describe cache (skip-if-described) stays non-destructive.
	 */
	regenerateAttachmentDescription = async (chatId: string, messageId: string, attachmentId: string): Promise<{ description: string }> => {
		const message = await this.stores.messages.getMessageById(messageId);
		if (!message?.attachmentsJson) throw validation("Message has no attachments.");
		const attachments = parseStoredAttachments(message.attachmentsJson);
		const att = attachments?.find((a) => a.id === attachmentId);
		if (!att) throw notFound("Attachment not found.");
		if (att.type !== "image" && att.type !== "video") {
			throw validation("Only image or video attachments can be described.");
		}

		const { profile } = await this.resolveEffectiveProfileOrThrow({ chatId });
		if (!profile.visionModel) {
			throw validation("No vision model configured in the active provider profile. Set one in Provider settings.");
		}

		const { describeAttachments } = await import("../../infrastructure/ai/vision-gate.js");
		const prompt = await this.resolveVisionDescribePromptFromPreset();
		const assetLoader = (assetId: string) => this.assetService.loadBuffer(assetId);
		const providerFetch = await resolveProviderFetchForProfile(profile);

		const descriptions = await describeAttachments(
			[att],
			profile.visionModel,
			profile,
			assetLoader,
			prompt,
			undefined,
			providerFetch,
		);
		const description = descriptions.get(att.id)?.trim() ?? "";
		await this.sessionRuntime.chatApp.updateSingleAttachmentDescription(messageId, attachmentId, description);
		return { description };
	};

	/** Delete a single attachment from a message. Removes it from the
	 *  message's attachments JSON and cleans up the underlying stored asset
	 *  file (each attachment owns a unique assetId — promote-from-gallery and
	 *  upload both create a fresh copy — so deleting the file is safe and avoids
	 *  orphaning it on disk). Idempotent: no-op if the attachment id is gone. */
	deleteAttachment = async (chatId: string, messageId: string, attachmentId: string) => {
		const removed = await this.sessionRuntime.chatApp.removeAttachment(messageId, attachmentId);
		if (removed) this.assetService.cleanup(removed.assetId);
		return { ok: true };
	};

	deleteMessage = async (chatId: string, messageId: string) => {
		// Clean up attachment asset files so they aren't orphaned on disk. Each
		// attachment owns a unique assetId (see deleteAttachment), so the files
		// are safe to remove. Read before deleting — the row is gone afterwards.
		const message = await this.stores.messages.getMessageById(messageId);
		const attachments = parseStoredAttachments(message?.attachmentsJson) ?? [];
		const result = await this.sessionRuntime.chatRuntime.deleteMessage(brandId<ChatId>(chatId), messageId);
		for (const att of attachments) this.assetService.cleanup(att.assetId);
		return result;
	};

	// ─── Export ─────────────────────────────────────────────────────────

	exportChatJsonl = (chatId: string) =>
		this.sessionRuntime.exportChatJsonl(chatId);

	exportPromptTrace = (traceId: string) =>
		this.sessionRuntime.exportPromptTrace(traceId);

	listPromptTraces = (chatId: string, opts?: { messageId?: string; branchId?: string }) =>
		this.sessionRuntime.listPromptTraces(brandId<ChatId>(chatId), opts);

	getContextPreview = async (chatId: string, branchId: string): Promise<ContextPreviewResponse> => {
		const typedChatId = brandId<ChatId>(chatId);
		const typedBranchId = brandId<ChatBranchId>(branchId);
		const preview = await this.sessionRuntime.getContextPreview(typedChatId, typedBranchId);
		return { target: { chatId, branchId }, preview };
	};

	// ─── Summaries & Memory ─────────────────────────────────────────────

	listChatSummaries = async (chatId: string) => {
		const chat = await this.stores.chats.getById(chatId);
		if (!chat) throw notFound("Chat", `Chat '${chatId}' was not found.`);
		return this.stores.chatSummaries.listByChatBranch(chat.id, chat.activeBranchId);
	};

	createChatSummary = async (chatId: string, body: { label?: string; content?: string; summarizedFrom: number; summarizedTo: number; includeInContext?: boolean; excludeSummarized?: boolean; source?: "manual" | "auto"; sortOrder?: number }) => {
		const chat = await this.stores.chats.getById(chatId);
		if (!chat) throw notFound("Chat", `Chat '${chatId}' was not found.`);
		const summary = await this.stores.chatSummaries.create({
			chatId: chat.id,
			branchId: chat.activeBranchId,
			...body,
		});
		return { summary, snapshot: await this.sessionRuntime.buildSummaryResponse(brandId<ChatId>(chatId)) };
	};

	updateChatSummaryRecord = async (_chatId: string, summaryId: string, body: { label?: string; content?: string; summarizedFrom?: number; summarizedTo?: number; includeInContext?: boolean; excludeSummarized?: boolean; sortOrder?: number }) => {
		const summary = await this.stores.chatSummaries.update(summaryId, body);
		return { summary, snapshot: await this.sessionRuntime.buildSummaryResponse(brandId<ChatId>(summary.chatId)) };
	};

	deleteChatSummaryRecord = async (chatId: string, summaryId: string) => {
		await this.stores.chatSummaries.delete(summaryId);
		return { ok: true, snapshot: await this.sessionRuntime.buildSummaryResponse(brandId<ChatId>(chatId)) };
	};

	generateChatSummary = (
		chatId: string,
		body: { providerProfileId: string; model?: string; summarizedFrom: number; summarizedTo: number; targetSummaryId?: string; label?: string; includeInContext?: boolean; excludeSummarized?: boolean; temperature?: number; maxOutputTokens?: number; contextBudget?: number },
		signal?: AbortSignal,
	) => this.chatSummaryService.generateChatSummary({ chatId, ...body, signal });

	updateMemorySettings = async (chatId: string, body: { messageHistoryLimit?: number; autoSummaryConfig?: { enabled?: boolean; everyN?: number; useChatModel?: boolean; providerProfileId?: string; model?: string } }) => {
		const chat = await this.stores.chats.getById(chatId);
		if (!chat) throw notFound("Chat", `Chat '${chatId}' was not found.`);
		const autoSummaryConfig = body.autoSummaryConfig
			? { ...chat.autoSummaryConfig, ...body.autoSummaryConfig }
			: undefined;
		await this.stores.chats.updateMemorySettings(chatId, {
			messageHistoryLimit: body.messageHistoryLimit,
			autoSummaryConfig,
		});
		// messageHistoryLimit + autoSummaryConfig live on the chat row → return
		// activeChat so the memory modal refreshes, plus contextPreview since
		// messageHistoryLimit changes the assembled prompt.
		return this.sessionRuntime.buildConfigPatchResponse(brandId<ChatId>(chatId), { activeChat: true });
	};

	updateInsightsConfig = async (chatId: string, body: { insightsConfig?: { objectiveEnabled?: boolean; trackerEnabled?: boolean; diceEnabled?: boolean; diceMode?: string; diceScriptIds?: string[] | null; diceActorBindings?: Record<string, ("persona" | "character")[]> | null; tracker?: SceneTrackerConfigPatch } }) => {
		const existing = await this.stores.chats.getById(chatId);
		if (!existing) throw notFound("Chat", `Chat '${chatId}' was not found.`);
		const patch = body.insightsConfig;

		// Toggle PATCH: shallow-merge onto the current config, preserving the
		// tracker sub-object and every other key (the store replaces wholesale).
		if (patch && (patch.objectiveEnabled !== undefined || patch.trackerEnabled !== undefined || patch.diceEnabled !== undefined || patch.diceMode !== undefined || patch.diceScriptIds !== undefined || patch.diceActorBindings !== undefined)) {
			const merged = {
				...existing.insightsConfig,
				...(patch.objectiveEnabled !== undefined ? { objectiveEnabled: patch.objectiveEnabled } : {}),
				...(patch.trackerEnabled !== undefined ? { trackerEnabled: patch.trackerEnabled } : {}),
				...(patch.diceEnabled !== undefined ? { diceEnabled: patch.diceEnabled } : {}),
				...(patch.diceMode !== undefined ? { diceMode: patch.diceMode } : {}),
				// diceScriptIds: null returns to inherit, an array sets the override,
				// absent preserves the stored value (partial-merge).
				...(patch.diceScriptIds !== undefined ? { diceScriptIds: patch.diceScriptIds } : {}),
			// diceActorBindings: null clears the actor override, a record sets it,
			// absent preserves the stored value (partial-merge). (Rework R1)
			...(patch.diceActorBindings !== undefined ? { diceActorBindings: patch.diceActorBindings } : {}),
			};
			await this.stores.chats.updateInsightsConfig(chatId, { insightsConfig: merged });
		}

		// Scene config PATCH: deep-merge field-by-field via the store (atomic
		// revision/schemaHash bump; preserves toggles). Runs after the toggle
		// write so it re-reads the freshly-toggled config. Objective state lives
		// in a separate column and is never touched here.
		if (patch?.tracker !== undefined) {
			// Defense-in-depth: the route validates the PATCH in isolation (no
			// cross-field check is possible there — `schema` and `promptFormat` may
			// arrive in separate PATCHes), so re-check the MERGED config here before
			// it persists. Under XML format, every schema key must be an XML Name or
			// the serializer would emit malformed tags (`<first name>`, `<123>`).
			const mergedTracker = applySceneTrackerConfigPatch(
				normalizeSceneTrackerConfig(existing.insightsConfig.tracker),
				patch.tracker,
			);
			if (mergedTracker.promptFormat === SCENE_PROMPT_FORMAT.xml) {
				const bad = findInvalidXmlKeys(mergedTracker.schema);
				if (bad.length > 0) {
					throw validation(
						`XML format requires ASCII field names (letters, digits, "_", "-", "."); invalid: ${bad.join(", ")}.`,
						{ invalidKeys: bad },
					);
				}
			}
			await this.stores.chats.updateSceneTrackerConfig(chatId, patch.tracker);
			// A schema/revision change can stale the current-Scene cache (a record
			// generated under the old schema is no longer current) — re-project it
			// from the live selection so the cache never drifts (SCN-6).
			await rebuildCurrentSceneCache(this.stores, brandId<ChatId>(chatId));
		}

		// insightsConfig lives on the chat row → return activeChat so the Insights
		// panel (and the tracker config editor) refreshes.
		return this.sessionRuntime.buildConfigPatchResponse(brandId<ChatId>(chatId), { activeChat: true });
	};

	summarizeChat = (
		chatId: string,
		body: { providerProfileId: string; model?: string; maxMessages: number },
		signal?: AbortSignal,
	) =>
		this.chatSummaryService.summarizeChat({
			chatId,
			providerProfileId: body.providerProfileId,
			model: body.model,
			maxMessages: body.maxMessages,
			signal,
		});

	saveChatSummary = (chatId: string, body: { summary: string }) =>
		this.chatSummaryService.saveChatSummary({ chatId, summary: body.summary });

	updateDynamicPrompt = async (chatId: string, body: { content: string }) => {
		const chat = await this.stores.chats.getById(chatId);
		if (!chat) throw notFound("Chat", `Chat '${chatId}' was not found.`);
		await this.stores.chats.updateDynamicPrompt(chatId, body.content);
		return this.sessionRuntime.buildConfigPatchResponse(brandId<ChatId>(chatId), { activeChat: true });
	};

	// ─── Private helpers ────────────────────────────────────────────────

	private async resolveVisionDescribePromptFromPreset(): Promise<string> {
		const settings = await this.stores.uiSettings.get();
		let aiAssistantPrompts: Record<string, string> | null = null;
		if (settings?.activePromptPresetId) {
			const preset = await this.stores.presets.getById(settings.activePromptPresetId);
			if (preset?.aiAssistantPrompts) {
				try {
					const parsed = JSON.parse(preset.aiAssistantPrompts);
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
						aiAssistantPrompts = Object.fromEntries(
							Object.entries(parsed).filter(([, v]) => typeof v === "string"),
						) as Record<string, string>;
					}
				} catch { /* preset.aiAssistantPrompts may hold malformed JSON; skip and fall back to the default vision-describe prompt */ }
			}
		}
		return resolveVisionDescribePrompt(aiAssistantPrompts);
	}

	private async resolveActiveProfileOrThrow() {
		const profile = await this.providerProfileService.resolveActiveProviderProfile();
		if (!profile) {
			throw validation("No active provider profile. Activate one in Provider settings.");
		}
		if (!profile.defaultModel) {
			throw validation("Active provider profile has no default model. Pick a model and save the profile.");
		}
		return { ...profile, defaultModel: profile.defaultModel as string };
	}

	/**
	 * Resolve the base profile for a chat's mode. For Co-Author chats with a
	 * valid persisted binding (both provider id + profile exist), returns the
	 * bound profile and the stored model name. Otherwise falls back to the RP
	 * active profile. Never throws for a dangling/incomplete Co-Author binding —
	 * the caller's validation runs on the final resolved profile.
	 */
	private async resolveProfileForMode(chatId?: string): Promise<{
		profile: StoredProviderProfileRecord & { defaultModel: string };
		preferredModel: string | null;
		transport: CoauthorTransport;
		coauthorTokenOverrides: { maxTokens: number | null; contextBudget: number | null } | null;
	}> {
		// Co-Author path: only when a chat is explicitly in coauthor mode AND has
		// a persisted binding whose profile still exists.
		if (chatId) {
			const chat = await this.stores.chats.getById(chatId);
			if (chat?.mode === "coauthor") {
				const settings = await this.stores.uiSettings.get();
				if (settings.coauthorProviderId) {
					const bound = await this.providerProfileService.getProviderProfile(settings.coauthorProviderId);
					if (bound) {
						const preferredModel = settings.coauthorModelName ?? null;
						const effectiveModel = preferredModel ?? bound.defaultModel;
						if (effectiveModel) {
							return {
								profile: { ...bound, defaultModel: effectiveModel as string },
								preferredModel,
								transport: bound.coauthorTransport,
								coauthorTokenOverrides: { maxTokens: settings.coauthorMaxTokens, contextBudget: settings.coauthorContextBudget },
							};
						}
					}
				}
			}
		}
		// RP fallback (also reached when the Co-Author binding is null/dangling).
		return {
			profile: await this.resolveActiveProfileOrThrow(),
			preferredModel: null,
			transport: COAUTHOR_TRANSPORT.chatCompletions,
			coauthorTokenOverrides: null,
		};
	}

	/**
	 * Resolve the EFFECTIVE provider profile for generation: the base profile
	 * merged with the final model's per-model overlay (when binding is ON).
	 *
	 * This is the single generation-boundary chokepoint. All generation methods
	 * (send/regenerate/generateReply + their stream variants + vision describe)
	 * call this so a bound model's overlay (temperature, contextBudget,
	 * pinContextBudget, ...) actually reaches the provider executor.
	 *
	 * Mode awareness: when `chatId` resolves to a Co-Author chat with a valid
	 * persisted binding, that binding's profile/model is used instead of the RP
	 * active profile. Null/dangling Co-Author bindings fall back to RP silently.
	 *
	 * Model precedence: explicit request override > persisted coauthorModelName >
	 * selected profile defaultModel. The overlay is always loaded for the FINAL
	 * model so per-model binding (samplers/contextBudget/reasoning) applies.
	 *
	 * Identity fields (endpoint, apiKey, defaultModel, visionModel) come from the
	 * base — the overlay cannot rename/rebind, only override sampler/context.
	 */
	private async resolveEffectiveProfileOrThrow(options?: {
		chatId?: string;
		modelOverride?: string | null;
	}) {
		const modelOverride = options?.modelOverride ?? null;
		const { profile, preferredModel, transport, coauthorTokenOverrides } = await this.resolveProfileForMode(options?.chatId);

		// Final model: explicit override > mode-preferred (coauthor) > profile default.
		const finalModel = modelOverride ?? preferredModel ?? profile.defaultModel;

		const effective = !profile.bindPerModel
			? { ...profile, defaultModel: finalModel }
			: { ...resolveEffectiveSettings(profile, (await this.providerProfileService.getProviderModelSettings(profile.id, finalModel))?.settings ?? null), defaultModel: finalModel };
		return {
			profile: {
				...effective,
				...(coauthorTokenOverrides?.maxTokens != null ? { maxTokens: coauthorTokenOverrides.maxTokens } : {}),
				...(coauthorTokenOverrides?.contextBudget != null ? { contextBudget: coauthorTokenOverrides.contextBudget } : {}),
			},
			transport,
		};
	}
}

/** Map the validated send body's optional Dice commit intent (the wire shape
 *  `{diceMode, pendingRevision}`, both-or-neither enforced by the Zod refine)
 *  to the internal `diceCommit` the orchestrator threads into prepareLiveTurn.
 *  Absent ⇒ undefined (no-Dice send behavior). DICE-B11. */
function resolveDiceCommit(body: { diceMode?: "normal" | "immersive"; pendingRevision?: number }): { mode: "normal" | "immersive"; pendingRevision: number } | undefined {
	if (body.diceMode !== undefined && body.pendingRevision !== undefined) {
		return { mode: body.diceMode, pendingRevision: body.pendingRevision };
	}
	return undefined;
}

/** Map the validated send body's optional experience attachment commit intent
 *  (the wire shape `{experienceAttachmentId, experienceQueueRevision,
 *  experienceSessionRevision}`, all-or-none enforced by the Zod refine) to the
 *  internal `experienceCommit` the orchestrator threads into prepareLiveTurn.
 *  Absent ⇒ undefined (no-experience send behavior). IR-51. Carries ONLY the
 *  identifiers of an already-stored queued attachment — never raw state. */
function resolveExperienceCommit(body: { experienceAttachmentId?: string; experienceQueueRevision?: number; experienceSessionRevision?: number }): { attachmentId: string; queueRevision: number; sessionRevision: number } | undefined {
	if (body.experienceAttachmentId !== undefined && body.experienceQueueRevision !== undefined && body.experienceSessionRevision !== undefined) {
		return { attachmentId: body.experienceAttachmentId, queueRevision: body.experienceQueueRevision, sessionRevision: body.experienceSessionRevision };
	}
	return undefined;
}

/** Map a stored user-module row to the API `CoauthorModule` shape: drop the
 *  DB-only timestamps, stamp `isBuiltIn: false` (user modules are editable). */
function toCoauthorModule(row: {
	id: string;
	name: string;
	description: string;
	basePrompt: string;
	openingMessage: string;
	skillIds: string[];
	toolSet: CoauthorModule["toolSet"];
	maxSteps: number;
	createdAt: string;
	updatedAt: string;
}): CoauthorModule {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		basePrompt: row.basePrompt,
		openingMessage: row.openingMessage,
		skillIds: row.skillIds,
		toolSet: row.toolSet,
		maxSteps: row.maxSteps,
		isBuiltIn: false,
	};
}
