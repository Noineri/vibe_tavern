import type { ChatRuntimeApi } from "../routes/types.js";
import { brandId, type ChatId, type ChatBranchId, type MessageId } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import { validation, notFound } from "../errors.js";
import { logSendDebug } from "../send-debug-log.js";
import type { SessionRuntime, SessionSnapshot } from "../session/session-runtime.js";
import type { LiveChatOrchestrator } from "../chat/live-chat-orchestrator.js";
import type { ChatSummaryService } from "../chat/chat-summary-service.js";
import type { ProviderProfileService } from "../providers/provider-profile-service.js";
import type { AssetService } from "../asset-service.js";
import { resolveCachedModels } from "../providers/model-cache-service.js";
import { resolveVisionDescribePrompt } from "../ai/vision-gate.js";

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

	getChatSnapshot = async (chatId: string) => {
		return this.sessionRuntime.chatLifecycle.switchChat(brandId<ChatId>(chatId));
	};

	createChatForCharacter = (characterId: string) =>
		this.sessionRuntime.chatLifecycle.createChatForCharacter(characterId);

	createFreeChat = () => this.sessionRuntime.chatLifecycle.createFreeChat();

	cloneChat = (chatId: string) =>
		this.sessionRuntime.chatRuntime.cloneChat(chatId);

	deleteChat = (chatId: string) =>
		this.sessionRuntime.chatRuntime.deleteChat(chatId);

	clearChat = (chatId: string): Promise<SessionSnapshot> =>
		this.sessionRuntime.chatLifecycle.clearChat(brandId<ChatId>(chatId));

	renameChat = (chatId: string, title: string) =>
		this.sessionRuntime.chatRuntime.renameChat(chatId, title);

	setGreetingIndex = async (chatId: string, greetingIndex: number): Promise<unknown> => {
		return this.sessionRuntime.setGreetingIndex(brandId<ChatId>(chatId), greetingIndex);
	};

	updateChatSettings = (
		_chatId: string,
		_body: { title: string; subtitle: string; scenario: string; systemPrompt: string },
	) => {
		throw new Error("Chat settings route is not wired in this baseline.");
	};

	setChatPersona = (chatId: string, personaId: string) =>
		this.sessionRuntime.persona.setChatPersona(brandId<ChatId>(chatId), personaId);

	setChatPromptPreset = (chatId: string, promptPresetId: string) =>
		this.sessionRuntime.chatLifecycle.setChatPromptPreset(brandId<ChatId>(chatId), promptPresetId);

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

	sendMessage = async (chatId: string, body: { content: string; attachments?: any[] }, signal?: AbortSignal) => {
		logSendDebug("api.runtime.send.start", { chatId, contentLength: body.content?.length ?? 0 });
		const profile = await this.resolveActiveProfileOrThrow();
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
			signal,
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

	sendMessageStream = async function* (this: ChatAdapter, chatId: string, body: { content: string; attachments?: any[] }, signal?: AbortSignal) {
		const profile = await this.resolveActiveProfileOrThrow();
		try {
			yield* this.liveChatOrchestrator.sendMessageStream({
				chatId,
				content: body.content,
				attachments: body.attachments,
				profile,
				model: profile.defaultModel,
				signal,
				visionAssets: {
					cachedModels: await resolveCachedModels(this.stores, profile),
					visionModel: profile.visionModel,
					assetLoader: (assetId: string) => this.assetService.loadBuffer(assetId),
					visionDescribePrompt: await this.resolveVisionDescribePromptFromPreset(),
				},
			});
		} catch (err) {
			if (err instanceof (await import("../ai/vision-gate.js")).VisionNotSupportedError) {
				yield { event: "error", data: JSON.stringify({ type: "vision_not_supported", message: err.message, attachments: err.attachmentNames }) };
				return;
			}
			throw err;
		}
	};

	regenerateMessage = async (chatId: string, messageId: string, _body: unknown, signal?: AbortSignal) => {
		const profile = await this.resolveActiveProfileOrThrow();
		const result = await this.liveChatOrchestrator.regenerateMessage({
			chatId,
			messageId,
			profile,
			model: profile.defaultModel,
			signal,
		});
		return result.snapshot;
	};

	regenerateMessageStream = async function* (this: ChatAdapter, chatId: string, messageId: string, _body: unknown, signal?: AbortSignal) {
		const profile = await this.resolveActiveProfileOrThrow();
		yield* this.liveChatOrchestrator.regenerateMessageStream({
			chatId,
			messageId,
			profile,
			model: profile.defaultModel,
			signal,
		});
	};

	generateReply = async (chatId: string, signal?: AbortSignal) => {
		const profile = await this.resolveActiveProfileOrThrow();
		const result = await this.liveChatOrchestrator.generateReply({
			chatId,
			profile,
			model: profile.defaultModel,
			signal,
		});
		return result.snapshot;
	};

	generateReplyStream = async function* (this: ChatAdapter, chatId: string, signal?: AbortSignal) {
		const profile = await this.resolveActiveProfileOrThrow();
		yield* this.liveChatOrchestrator.generateReplyStream({
			chatId,
			profile,
			model: profile.defaultModel,
			signal,
		});
	};

	// ─── Messages (CRUD) ────────────────────────────────────────────────

	selectVariant = (chatId: string, messageId: string, variantIndex: number) =>
		this.sessionRuntime.chatRuntime.selectMessageVariant(brandId<ChatId>(chatId), brandId<MessageId>(messageId), variantIndex);

	deleteVariant = (chatId: string, messageId: string, variantIndex: number) =>
		this.sessionRuntime.chatRuntime.deleteMessageVariant(brandId<ChatId>(chatId), brandId<MessageId>(messageId), variantIndex);

	editMessage = (chatId: string, messageId: string, content: string) =>
		this.sessionRuntime.chatRuntime.editMessage(brandId<ChatId>(chatId), messageId, content);

	updateAttachmentDescription = async (chatId: string, messageId: string, attachmentId: string, description: string) => {
		await this.sessionRuntime.chatApp.updateSingleAttachmentDescription(messageId, attachmentId, description);
		return { ok: true };
	};

	deleteMessage = (chatId: string, messageId: string) =>
		this.sessionRuntime.chatRuntime.deleteMessage(brandId<ChatId>(chatId), messageId);

	// ─── Export ─────────────────────────────────────────────────────────

	exportChatJsonl = (chatId: string) =>
		this.sessionRuntime.exportChatJsonl(chatId);

	exportPromptTrace = (traceId: string) =>
		this.sessionRuntime.exportPromptTrace(traceId);

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
		return { summary, snapshot: await this.sessionRuntime.getSnapshot(brandId<ChatId>(chatId)) };
	};

	updateChatSummaryRecord = async (_chatId: string, summaryId: string, body: { label?: string; content?: string; summarizedFrom?: number; summarizedTo?: number; includeInContext?: boolean; excludeSummarized?: boolean; sortOrder?: number }) => {
		const summary = await this.stores.chatSummaries.update(summaryId, body);
		return { summary, snapshot: await this.sessionRuntime.getSnapshot(brandId<ChatId>(summary.chatId)) };
	};

	deleteChatSummaryRecord = async (chatId: string, summaryId: string) => {
		await this.stores.chatSummaries.delete(summaryId);
		return { ok: true, snapshot: await this.sessionRuntime.getSnapshot(brandId<ChatId>(chatId)) };
	};

	generateChatSummary = (
		chatId: string,
		body: { providerProfileId: string; model?: string; summarizedFrom: number; summarizedTo: number; targetSummaryId?: string; label?: string; includeInContext?: boolean; excludeSummarized?: boolean },
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
		return this.sessionRuntime.getSnapshot(brandId<ChatId>(chatId));
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
				} catch {}
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
}
