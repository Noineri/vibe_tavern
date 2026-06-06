import type { StoreContainer } from "@vibe-tavern/db";
import type { CreateLoreEntryData, UpdateLoreEntryData } from "@vibe-tavern/db";
import { brandId, type CharacterId, type ChatId, type ChatBranchId, type MessageId, type LoreScopeType } from "@vibe-tavern/domain";
import { validation, notFound } from "./errors.js";
import { logSendDebug } from "./send-debug-log.js";
import type { SessionRuntime } from "./session/session-runtime.js";
import type { ProviderProfileService } from "./providers/provider-profile-service.js";
import type { ProviderOrchestrator } from "./providers/provider-orchestrator.js";
import type { LiveChatOrchestrator } from "./chat/live-chat-orchestrator.js";
import type { ChatSummaryService } from "./chat/chat-summary-service.js";
import type { PromptPresetService } from "./prompt/prompt-preset-service.js";
import type { AssetService } from "./asset-service.js";
import type { MobileAccessService } from "./mobile-access-service.js";
import {
	probeProviderConnection,
	testProviderChat,
	listProviderModels,
	normalizeOpenAiCompatibleBaseUrl,
} from "./providers/provider-gateway.js";
import { executeScripts } from "./scripts-engine/script-sandbox.js";
import { resolveModel } from "./ai/provider-executor-utils.js";
import { countAiAssistantTokens, streamAiAssistant, type AiAssistantStreamRequest } from "./ai-assistant/ai-assistant-stream.js";

/**
 * Facade that implements RuntimeApi — the single contract between
 * routes.ts and the rest of the application.  Every method is a thin
 * delegation to an underlying service; no business logic lives here.
 */
export class RuntimeApiAdapter {
	constructor(
		private readonly stores: StoreContainer,
		private readonly providerProfileService: ProviderProfileService,
		private readonly liveChatOrchestrator: LiveChatOrchestrator,
		private readonly chatSummaryService: ChatSummaryService,
		private readonly sessionRuntime: SessionRuntime,
		private readonly promptPresetService: PromptPresetService,
		private readonly assetService: AssetService,
		private readonly mobileAccessService: MobileAccessService,
	) {}

	// ─── Private helpers ──────────────────────────────────────────────────

	/** Resolve the active provider profile or throw a validation error.
	 *  Returns a profile with defaultModel guaranteed to be a string. */
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

	// ─── Bootstrap ────────────────────────────────────────────────────────

	bootstrap = () => this.sessionRuntime.getBootstrapState();

	// ─── UI Settings ──────────────────────────────────────────────────────

	getUiSettings = () => this.stores.uiSettings.get();

	updateUiSettings = (body: Record<string, unknown>) => this.stores.uiSettings.update({
		...(typeof body.theme === "string" ? { theme: body.theme } : {}),
		...(typeof body.chatFontSize === "number" ? { chatFontSize: body.chatFontSize } : {}),
		...(typeof body.uiFontSize === "number" ? { uiFontSize: body.uiFontSize } : {}),
		...(typeof body.messageWidth === "number" ? { messageWidth: body.messageWidth } : {}),
		...(typeof body.language === "string" ? { language: body.language } : {}),
		...(typeof body.activePromptPresetId === "string" || body.activePromptPresetId === null ? { activePromptPresetId: body.activePromptPresetId } : {}),
		...(typeof body.aiAssistantProviderId === "string" || body.aiAssistantProviderId === null ? { aiAssistantProviderId: body.aiAssistantProviderId } : {}),
		...(typeof body.aiAssistantModelName === "string" || body.aiAssistantModelName === null ? { aiAssistantModelName: body.aiAssistantModelName } : {}),
	});

	// ─── Character ────────────────────────────────────────────────────────

	createCharacterFromScratch = (body: {
		name: string;
		description?: string;
		firstMessage?: string;
		scenario?: string;
		personalitySummary?: string;
		mesExample?: string;
		mesExampleMode?: string;
		mesExampleDepth?: number;
		alternateGreetings?: string[];
		postHistoryInstructions?: string;
		creatorNotes?: string;
		systemPrompt?: string;
		depthPrompt?: string;
		depthPromptDepth?: number;
		depthPromptRole?: string;
		tags?: string[];
	}) => this.sessionRuntime.character.createFromScratch(body);

	updateCharacter = async (
		characterId: string,
		body: {
			chatId?: string;
			name?: string;
			description?: string;
			personalitySummary?: string | null;
			scenario?: string;
			systemPrompt?: string;
			firstMessage?: string | null;
			mesExample?: string | null;
			mesExampleMode?: string;
			mesExampleDepth?: number;
			alternateGreetings?: string[];
			postHistoryInstructions?: string | null;
			creatorNotes?: string | null;
			depthPrompt?: string | null;
			depthPromptDepth?: number | null;
			depthPromptRole?: string | null;
			tags?: string[];
			avatarAssetId?: string | null;
			avatarFullAssetId?: string | null;
		},
	) => {
		if (body.avatarAssetId !== undefined) {
			const character = await this.stores.characters.getById(brandId<CharacterId>(characterId));
			if (character?.avatarAssetId && character.avatarAssetId !== body.avatarAssetId) {
				this.assetService.cleanup(character.avatarAssetId);
			}
		}
		return this.sessionRuntime.character.update(
			brandId<CharacterId>(characterId),
			{ ...body, chatId: body.chatId != null ? brandId<ChatId>(body.chatId) : undefined },
			{ rebuildChatOrder: () => this.sessionRuntime.rebuildChatOrder() },
		);
	};

	archiveCharacter = (characterId: string) => this.sessionRuntime.character.archive(characterId);
	unarchiveCharacter = (characterId: string) => this.sessionRuntime.character.unarchive(characterId);

	deleteCharacter = async (characterId: string) => {
		const character = await this.stores.characters.getById(brandId<CharacterId>(characterId));
		if (character?.avatarAssetId) this.assetService.cleanup(character.avatarAssetId);
		await this.sessionRuntime.character.delete(characterId);
	};

	exportCharacter = (characterId: string) => this.sessionRuntime.exportCharacter(characterId);

	duplicateCharacter = (characterId: string) =>
		this.sessionRuntime.character.duplicate(brandId<CharacterId>(characterId));

	// ─── Persona ──────────────────────────────────────────────────────────

	listPersonas = () => this.sessionRuntime.persona.list();

	createPersona = (body: {
		name: string;
		description: string;
		pronouns?: string | null;
		defaultForNewChats?: boolean;
	}) => this.sessionRuntime.persona.create(body);

	updatePersona = async (
		personaId: string,
		body: {
			chatId?: string;
			name?: string;
			description?: string;
			pronouns?: string | null;
			avatarAssetId?: string | null;
			avatarFullAssetId?: string | null;
		},
	) => {
		if (body.avatarAssetId !== undefined) {
			const persona = await this.stores.personas.getById(personaId);
			if (persona?.avatarAssetId && persona.avatarAssetId !== body.avatarAssetId) {
				this.assetService.cleanup(persona.avatarAssetId);
			}
		}
		return this.sessionRuntime.persona.update(
			personaId,
			{ ...body, chatId: body.chatId != null ? brandId<ChatId>(body.chatId) : undefined },
		);
	};

	deletePersona = async (personaId: string) => {
		const persona = await this.stores.personas.getById(personaId);
		if (persona?.avatarAssetId) this.assetService.cleanup(persona.avatarAssetId);
		await this.sessionRuntime.persona.delete(personaId);
	};

	duplicatePersona = (personaId: string) =>
		this.sessionRuntime.persona.duplicate(personaId);

	setChatPersona = (chatId: string, personaId: string) =>
		this.sessionRuntime.persona.setChatPersona(brandId<ChatId>(chatId), personaId);

	setChatPromptPreset = (chatId: string, promptPresetId: string) =>
		this.sessionRuntime.chatLifecycle.setChatPromptPreset(brandId<ChatId>(chatId), promptPresetId);

	// ─── Chat lifecycle ───────────────────────────────────────────────────

	getChatSnapshot = async (chatId: string) => {
		return this.sessionRuntime.chatLifecycle.switchChat(brandId<ChatId>(chatId));
	};


	createChatForCharacter = (characterId: string) =>
		this.sessionRuntime.chatLifecycle.createChatForCharacter(characterId);

	createFreeChat = () => this.sessionRuntime.chatLifecycle.createFreeChat();

	cloneChat = (chatId: string) =>
		this.sessionRuntime.chatRuntime.cloneChat(chatId);

	branchChat = (chatId: string, messageId: string) =>
		this.sessionRuntime.chatRuntime.forkBranch(brandId<ChatId>(chatId), messageId);

	forkBranch = (chatId: string, fromMessageId?: string) =>
		this.sessionRuntime.chatRuntime.forkBranch(brandId<ChatId>(chatId), fromMessageId);

	activateBranch = (chatId: string, branchId: string) =>
		this.sessionRuntime.chatRuntime.activateBranch(brandId<ChatId>(chatId), brandId<ChatBranchId>(branchId));

	deleteBranch = (chatId: string, branchId: string) =>
		this.sessionRuntime.chatRuntime.deleteBranch(chatId, branchId);

	deleteChat = (chatId: string) =>
		this.sessionRuntime.chatRuntime.deleteChat(chatId);

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

	// ─── Chat messages (AI) ───────────────────────────────────────────────

	sendMessage = async (chatId: string, body: { content: string }, signal?: AbortSignal) => {
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
			profile,
			model: profile.defaultModel,
			signal,
		});
		logSendDebug("api.runtime.send.success", {
			chatId,
			replyLength: result.reply.length,
			preparedMessageCount: result.preparedMessageCount,
			promptMessageCount: result.promptMessageCount,
		});
		return result.snapshot;
	};

	sendMessageStream = async function* (this: RuntimeApiAdapter, chatId: string, body: { content: string }, signal?: AbortSignal) {
		const profile = await this.resolveActiveProfileOrThrow();
		yield* this.liveChatOrchestrator.sendMessageStream({
			chatId,
			content: body.content,
			profile,
			model: profile.defaultModel,
			signal,
		});
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

	regenerateMessageStream = async function* (this: RuntimeApiAdapter, chatId: string, messageId: string, _body: unknown, signal?: AbortSignal) {
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

	generateReplyStream = async function* (this: RuntimeApiAdapter, chatId: string, signal?: AbortSignal) {
		const profile = await this.resolveActiveProfileOrThrow();
		yield* this.liveChatOrchestrator.generateReplyStream({
			chatId,
			profile,
			model: profile.defaultModel,
			signal,
		});
	};

	selectVariant = (chatId: string, messageId: string, variantIndex: number) =>
		this.sessionRuntime.chatRuntime.selectMessageVariant(brandId<ChatId>(chatId), brandId<MessageId>(messageId), variantIndex);

	deleteVariant = (chatId: string, messageId: string, variantIndex: number) =>
		this.sessionRuntime.chatRuntime.deleteMessageVariant(brandId<ChatId>(chatId), brandId<MessageId>(messageId), variantIndex);

	renameBranch = (chatId: string, branchId: string, label: string) =>
		this.sessionRuntime.chatRuntime.renameBranch(brandId<ChatId>(chatId), branchId, label);

	editMessage = (chatId: string, messageId: string, content: string) =>
		this.sessionRuntime.chatRuntime.editMessage(brandId<ChatId>(chatId), messageId, content);

	deleteMessage = (chatId: string, messageId: string) =>
		this.sessionRuntime.chatRuntime.deleteMessage(brandId<ChatId>(chatId), messageId);

	// ─── Chat summary / Memory 1.0 ───────────────────────────────────────

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

	// ─── Lorebook ─────────────────────────────────────────────────────────

	getPersonalLorebookStatus = (personaId: string) =>
		this.sessionRuntime.getPersonalLorebookStatus(personaId);

	setPersonalLorebookEnabled = (personaId: string, enabled: boolean) =>
		this.sessionRuntime.setPersonalLorebookEnabled(personaId, enabled);

	// ─── Lorebook CRUD (wired to store) ────────────────────────────────────

	listAllLorebooks = () => this.stores.lorebooks.listAllLorebooks();

	listLorebooks = (scopeType: string, ownerId?: string) =>
		this.stores.lorebooks.listLorebooksByScope(scopeType, ownerId);

	createLorebook = (body: { name: string; description?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string; scanDepth?: number; tokenBudget?: number; recursiveScanning?: boolean }) =>
		this.stores.lorebooks.createLorebook(body);

	updateLorebookMeta = (lorebookId: string, body: { name?: string; description?: string; scanDepth?: number; tokenBudget?: number; recursiveScanning?: boolean; enabled?: boolean; scopeType?: string }) =>
		this.stores.lorebooks.updateLorebook(lorebookId, body);

	deleteLorebook = async (lorebookId: string) => {
		await this.stores.lorebooks.deleteLorebook(lorebookId);
	};

	// ─── Lore entries (wired to store) ──────────────────────────────────────

	createLoreEntry = (lorebookId: string, body: Record<string, unknown>) =>
		this.stores.lorebooks.createEntry(lorebookId, body as unknown as CreateLoreEntryData);

	updateLoreEntry = (_lorebookId: string, entryId: string, body: Record<string, unknown>) =>
		this.stores.lorebooks.updateEntry(entryId, body as unknown as UpdateLoreEntryData);

	deleteLoreEntry = (_lorebookId: string, entryId: string) =>
		this.stores.lorebooks.deleteEntry(entryId);

	listLoreEntries = (lorebookId: string) =>
		this.stores.lorebooks.listEntries(lorebookId);

	reorderLoreEntries = (lorebookId: string, updates: Array<{ id: string; sortOrder: number; position?: string }>) =>
		this.stores.lorebooks.reorderEntries(lorebookId, updates);

	testLoreActivation = async (lorebookId: string, body: { text: string }) => {
		const entries = await this.stores.lorebooks.listEntries(lorebookId);
		const activated = entries.filter(e =>
			e.enabled && e.keys.some(k => k && body.text.toLowerCase().includes(k.toLowerCase()))
		);
		return { activatedIds: activated.map(e => e.id), totalEntries: entries.length };
	};

	importLorebook = async (lorebookId: string | null, body: { format: string; data: unknown; mode: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string; fallbackName?: string }) => {
		const { importStLorebookJson } = await import("@vibe-tavern/import-export");
		const parsed = importStLorebookJson(body.data as Record<string, unknown>, {
			scopeType: (body.scopeType as LoreScopeType | undefined) ?? "character",
			fallbackName: body.fallbackName,
		});

		let targetId = lorebookId;

		if (body.mode === "new" || !targetId) {
			const created = await this.stores.lorebooks.createLorebook({
				name: parsed.lorebook.name,
				description: parsed.lorebook.description,
				scopeType: (body.scopeType as LoreScopeType) ?? "character",
				scanDepth: parsed.lorebook.scanDepth,
				tokenBudget: parsed.lorebook.tokenBudget,
				recursiveScanning: parsed.lorebook.recursiveScanning,
				characterId: body.characterId ?? null,
				personaId: body.personaId ?? null,
				chatId: body.chatId ?? null,
				extensions: parsed.lorebook.extensions,
			});
			targetId = created.id;
		} else {
			const lorebook = await this.stores.lorebooks.getLorebook(targetId);
			if (!lorebook) throw new Error(`Lorebook not found: ${targetId}`);
			if (body.mode === "replace") {
				await this.stores.lorebooks.deleteAllEntries(targetId);
			}
		}

		const entryData = parsed.entries.map((entry) => ({
			title: entry.title,
			content: entry.content,
			keys: entry.keys,
			secondaryKeys: entry.secondaryKeys,
			logic: entry.logic,
			position: entry.position,
			depth: entry.depth,
			priority: entry.priority,
			stickyWindow: entry.stickyWindow,
			cooldownWindow: entry.cooldownWindow,
			delayWindow: entry.delayWindow,
			constant: entry.constant,
			probability: entry.probability,
			role: entry.role,
			group: entry.group,
			groupName: entry.group,
			groupWeight: entry.groupWeight,
			prioritizeInclusion: entry.prioritizeInclusion,
			excludeRecursion: entry.excludeRecursion,
			preventRecursion: entry.preventRecursion,
			delayUntilRecursion: entry.delayUntilRecursion,
			recursionLevel: entry.recursionLevel,
			scanDepthOverride: entry.scanDepthOverride,
			caseSensitive: entry.caseSensitive,
			matchWholeWords: entry.matchWholeWords,
			characterFilter: entry.characterFilter,
			characterFilterExclude: entry.characterFilterExclude,
			triggers: entry.triggers,
			matchSources: entry.matchSources,
			enabled: entry.enabled,
			sortOrder: entry.sortOrder,
			metadata: entry.metadata,
		}));

		const imported = await this.stores.lorebooks.bulkCreateEntries(targetId, entryData);
		return { lorebookId: targetId, imported, skipped: parsed.entries.length - imported, warnings: parsed.warnings };
	};

	getLorebookLinks = (lorebookId: string) =>
		this.stores.lorebooks.getLinks(lorebookId);

	setLorebookLinks = (lorebookId: string, links: Array<{ targetType: string; targetId: string }>) =>
		this.stores.lorebooks.setLinks(lorebookId, links);

	duplicateLorebook = (lorebookId: string, overrides?: { name?: string; scopeType?: string; characterId?: string | null; personaId?: string | null }) =>
		this.stores.lorebooks.duplicateLorebook(lorebookId, overrides);

	exportLorebook = (lorebookId: string) =>
		this.stores.lorebooks.exportToStFormat(lorebookId);

	// ─── Scripts (wired to store) ──────────────────────────────────────────

	listScripts = (scopeType: string, ownerId?: string) =>
		this.stores.scripts.listByScope(scopeType, ownerId);

	getScript = (scriptId: string) =>
		this.stores.scripts.getById(scriptId);

	createScript = (body: { name: string; description?: string; code?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string; enabled?: boolean; sortOrder?: number }) =>
		this.stores.scripts.create(body);

	updateScript = (scriptId: string, body: { name?: string; description?: string; code?: string; enabled?: boolean; sortOrder?: number }) =>
		this.stores.scripts.update(scriptId, body);

	deleteScript = async (scriptId: string) => {
		await this.stores.scripts.delete(scriptId);
	};

	testScript = async (scriptId: string, body: { messages?: Array<{ role: string; content: string }>; characterName?: string; characterPersonality?: string; characterScenario?: string; lastMessage?: string }) => {
		const script = await this.stores.scripts.getById(scriptId);
		if (!script) throw new Error(`Script not found: ${scriptId}`);
		const messages = (body.messages && body.messages.length > 0) ? body.messages : (body.lastMessage ? [{ role: "user", content: body.lastMessage }] : []);
		const sandboxMessages = messages.map(m => ({ message: m.content, role: m.role }));
		const result = executeScripts({
			scripts: [{
				id: script.id,
				name: script.name,
				code: script.code,
				sortOrder: script.sortOrder,
			}],
			chat: {
				messages: sandboxMessages,
			},
			character: {
				name: body.characterName ?? "Assistant",
				personality: body.characterPersonality ?? "",
				scenario: body.characterScenario ?? "",
			},
			activeLoreEntries: [],
			scriptState: {},
		});
		return {
			personality: result.character.personality,
			scenario: result.character.scenario,
			state: result.updatedScriptState[scriptId] ?? {},
			errors: result.errors,
		};
	};

	importScript = async (body: { format: "js" | "json"; code?: string; jsonText?: string; name?: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string }) => {
		let name = body.name ?? "Imported Script";
		let code = "";
		if (body.format === "js" && body.code) {
			code = body.code;
		} else if (body.format === "json" && body.jsonText) {
			try {
				const parsed = JSON.parse(body.jsonText);
				if (typeof parsed === "object" && parsed !== null) {
					name = parsed.name ?? name;
					code = parsed.code ?? parsed.script ?? "";
				}
			} catch {
				throw new Error("Invalid JSON in script import");
			}
		}
		return this.stores.scripts.create({
			name,
			code,
			scopeType: body.scopeType ?? "character",
			characterId: body.characterId,
			personaId: body.personaId,
			chatId: body.chatId,
		});
	};

	// ─── AI Assistant ───────────────────────────────────────────────────

	private createAiAssistantDeps() {
		return {
			resolveModel,
			getProviderProfile: (id: string) => this.stores.providers.getById(id),
			getPresetPromptData: async () => {
				const settings = await this.stores.uiSettings.get();
				if (!settings?.activePromptPresetId) {
					return { aiAssistantPrompts: null, scriptAiSystemPrompt: null };
				}
				const preset = await this.stores.presets.getById(settings.activePromptPresetId);
				if (!preset) {
					return { aiAssistantPrompts: null, scriptAiSystemPrompt: null };
				}
				let aiAssistantPrompts: Record<string, string> | null = null;
				try {
					const parsed = JSON.parse(preset.aiAssistantPrompts || "{}");
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
						aiAssistantPrompts = Object.fromEntries(
							Object.entries(parsed).filter(([, value]) => typeof value === "string"),
						) as Record<string, string>;
					}
				} catch (err) {
					logSendDebug("api.ai-assistant.prompt-map-parse-error", { error: String(err), presetId: preset.id });
				}
				return {
					aiAssistantPrompts,
					scriptAiSystemPrompt: preset.scriptAiSystemPrompt ?? null,
				};
			},
			getCharacterById: async (id: string) => {
				const character = await this.stores.characters.getById(id);
				if (!character) return null;
				return {
					id: character.id,
					name: character.name,
					description: character.description,
					personality: character.personalitySummary ?? "",
					scenario: character.defaultScenario ?? "",
				};
			},
			getPersonaById: async (id: string) => {
				const persona = await this.stores.personas.getById(id);
				if (!persona) return null;
				return {
					id: persona.id,
					name: persona.name,
					description: persona.description,
					pronouns: persona.pronouns ?? undefined,
				};
			},
			getLoreEntryById: async (id: string) => {
				const entry = await this.stores.lorebooks.getEntry(id);
				if (!entry || !entry.enabled) return null;
				return {
					id: entry.id,
					title: entry.title,
					content: entry.content,
				};
			},
			getLoreEntriesByLorebookId: async (id: string) => {
				const lorebook = await this.stores.lorebooks.getLorebook(id);
				if (!lorebook?.enabled) return [];
				const entries = await this.stores.lorebooks.listEntries(id);
				return entries
					.filter((entry) => entry.enabled)
					.map((entry) => ({
						id: entry.id,
						title: entry.title,
						content: entry.content,
					}));
			},
			logDebug: logSendDebug,
			getChatMessages: async (chatId: string, count: number) => {
				const chat = await this.stores.chats.getById(chatId);
				if (!chat) return [];
				const allMessages = await this.stores.chats.getMessages(chat.activeBranchId);
				const sliced = allMessages.slice(-count);
				return sliced.map((m) => ({ id: m.id, role: m.role, content: m.content }));
			},
		};
	}

	streamAiAssistant = async function* (this: RuntimeApiAdapter, body: AiAssistantStreamRequest) {
		yield* streamAiAssistant(body, this.createAiAssistantDeps());
	};

	countAiAssistantTokens = (body: AiAssistantStreamRequest) =>
		countAiAssistantTokens(body, this.createAiAssistantDeps());

	// ─── Provider profiles ────────────────────────────────────────────────

	listProviderProfiles = () => this.providerProfileService.listProviderProfiles();

	fetchProviderProfile = (providerProfileId: string) => {
		const profile = this.providerProfileService.getProviderProfileForClient(providerProfileId);
		if (!profile) {
			throw notFound("ProviderProfile", `Provider profile '${providerProfileId}' was not found.`);
		}
		return profile;
	};

	activateProviderProfile = (providerProfileId: string) =>
		this.providerProfileService.activateProviderProfile(providerProfileId);

	updateProviderProfile = (providerProfileId: string, body: Record<string, unknown>) =>
		this.providerProfileService.updateProviderProfile(providerProfileId, body);

	saveProviderDraft = (body: Record<string, unknown>) =>
		this.providerProfileService.saveProviderProfile(body);

	testProviderDraft = (body: { endpoint?: string; apiKey?: string; providerType?: string } | null) => {
		const endpoint = (body?.endpoint ?? "").trim();
		const apiKey = (body?.apiKey ?? "").trim();
		return probeProviderConnection({ baseUrl: endpoint, apiKey, providerType: body?.providerType });
	};

	testProviderProfile = async (providerProfileId: string) => {
		const profile = await this.getRequiredProviderProfile(providerProfileId);
		return probeProviderConnection({
			baseUrl: profile.endpoint,
			apiKey: profile.apiKey ?? "",
			providerType: profile.providerPreset,
		});
	};

	deleteProviderProfile = (providerProfileId: string) =>
		this.providerProfileService.deleteProviderProfile(providerProfileId);

	fetchProviderModels = async (providerProfileId: string) => {
		const profile = await this.getRequiredProviderProfile(providerProfileId);
		return { models: await listProviderModels({
			baseUrl: profile.endpoint,
			apiKey: profile.apiKey ?? "",
			providerType: profile.providerPreset,
			requiresAuthForModels: profile.providerPreset === "anthropic" || profile.providerPreset === "google",
		}) };
	};

	listFavoriteProviderModels = (providerProfileId: string) =>
		this.providerProfileService.listFavoriteProviderModels(providerProfileId);

	addFavoriteProviderModel = (
		providerProfileId: string,
		body: { modelId: string; label?: string | null; contextLength?: number | null },
	) => this.providerProfileService.addFavoriteProviderModel(providerProfileId, body);

	removeFavoriteProviderModel = (providerProfileId: string, modelId: string) =>
		this.providerProfileService.removeFavoriteProviderModel(providerProfileId, modelId);

	/**
	 * Fetch available models from an arbitrary endpoint (not a saved profile).
	 */
	fetchModelsByEndpoint = async (baseUrl: string, apiKey?: string, providerType?: string) => {
		const normalized = normalizeOpenAiCompatibleBaseUrl(baseUrl);
		const requiresAuth = providerType === "anthropic" || providerType === "google";
		return listProviderModels({
			baseUrl: normalized,
			apiKey: apiKey ?? "",
			providerType,
			requiresAuthForModels: requiresAuth,
		});
	};

	/** Test a chat completion against an arbitrary endpoint (not a saved profile). */
	testProviderChatByEndpoint = (opts: {
		baseUrl: string;
		apiKey: string;
		model: string;
		providerType?: string;
	}) => testProviderChat(opts);

	/** Test a chat completion using a saved provider profile's credentials. */
	testProviderChatByProfile = async (providerProfileId: string, model: string) => {
		const profile = await this.getRequiredProviderProfile(providerProfileId);
		return testProviderChat({
			baseUrl: profile.endpoint,
			apiKey: profile.apiKey ?? "",
			model,
			providerType: profile.providerPreset,
		});
	};

	private async getRequiredProviderProfile(providerProfileId: string) {
		const profile = await this.providerProfileService.getProviderProfile(providerProfileId);
		if (!profile) {
			throw notFound("ProviderProfile", `Provider profile '${providerProfileId}' was not found.`);
		}
		return profile;
	}

	// ─── Import / Export ───────────────────────────────────────────────────

	importJson = (body: { fileName: string; jsonText: string; chatId?: string; skipExisting?: boolean }) =>
		this.sessionRuntime.importJson(body);

	scanSillyTavernDirectory = (dirPath: string) =>
		this.sessionRuntime.scanSillyTavernDirectory(dirPath);

	importSillyTavernDirectory = (dirPath: string) =>
		this.sessionRuntime.importSillyTavernDirectory(dirPath);

	exportChatJsonl = (chatId: string) =>
		this.sessionRuntime.exportChatJsonl(chatId);

	exportPromptTrace = (traceId: string) =>
		this.sessionRuntime.exportPromptTrace(traceId);

	// ─── Presets ──────────────────────────────────────────────────────────

	listPromptPresets = () => this.promptPresetService.listPromptPresets();
	createPromptPreset = (body: Parameters<PromptPresetService["createPromptPreset"]>[0]) => this.promptPresetService.createPromptPreset(body);
	updatePromptPreset = (presetId: string, body: Parameters<PromptPresetService["updatePromptPreset"]>[1]) => this.promptPresetService.updatePromptPreset(presetId, body);
	deletePromptPreset = (presetId: string) => this.promptPresetService.deletePromptPreset(presetId);

	// ─── Assets ───────────────────────────────────────────────────────────

	uploadAsset = (file: File) => this.assetService.upload(file);
	serveAsset = (assetId: string) => this.assetService.serve(assetId);

	// ── Mobile Access ──────────────────────────────────────────────────

	async getMobileAccessInfo() {
		const port = Number(process.env.RP_PLATFORM_PORT ?? "8787");
		const tlsEnabled = !!(process.env.RP_PLATFORM_TLS_KEY && process.env.RP_PLATFORM_TLS_CERT);
		return this.mobileAccessService.getMobileAccessInfo(port, tlsEnabled);
	}

	async regenerateMobileAccessToken(): Promise<{ token: string }> {
		const token = this.mobileAccessService.regenerateToken();
		return { token };
	}

	async revokeMobileAccess(): Promise<{ token: null }> {
		this.mobileAccessService.revokeToken();
		return { token: null };
	}
}
