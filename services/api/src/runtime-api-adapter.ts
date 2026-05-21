import type { StoreContainer } from "@rp-platform/db";
import type { CreateLoreEntryData, UpdateLoreEntryData } from "@rp-platform/db";
import { brandId, type CharacterId, type ChatId, type ChatBranchId, type MessageId } from "@rp-platform/domain";
import { validation, notFound } from "./errors.js";
import { logSendDebug } from "./send-debug-log.js";
import type { SessionRuntime } from "./session-runtime.js";
import type { ProviderProfileService } from "./provider-profile-service.js";
import type { ProviderOrchestrator } from "./provider-orchestrator.js";
import type { LiveChatOrchestrator } from "./live-chat-orchestrator.js";
import type { ChatSummaryService } from "./chat-summary-service.js";
import type { PromptPresetService } from "./prompt-preset-service.js";
import type { AssetService } from "./asset-service.js";
import {
	probeProviderConnection,
	testProviderChat,
	listProviderModels,
	normalizeOpenAiCompatibleBaseUrl,
} from "./provider-gateway.js";
import { executeScripts } from "./script-sandbox.js";

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
		this.sessionRuntime.chatRuntime.forkBranch(brandId<ChatId>(chatId));

	forkBranch = (chatId: string) =>
		this.sessionRuntime.chatRuntime.forkBranch(brandId<ChatId>(chatId));

	activateBranch = (chatId: string, branchId: string) =>
		this.sessionRuntime.chatRuntime.activateBranch(brandId<ChatId>(chatId), brandId<ChatBranchId>(branchId));

	deleteBranch = (chatId: string, branchId: string) =>
		this.sessionRuntime.chatRuntime.deleteBranch(chatId, branchId);

	deleteChat = (chatId: string) =>
		this.sessionRuntime.chatRuntime.deleteChat(chatId);

	renameChat = (chatId: string, title: string) =>
		this.sessionRuntime.chatRuntime.renameChat(chatId, title);

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

	editMessage = (chatId: string, messageId: string, content: string) =>
		this.sessionRuntime.chatRuntime.editMessage(brandId<ChatId>(chatId), messageId, content);

	deleteMessage = (chatId: string, messageId: string) =>
		this.sessionRuntime.chatRuntime.deleteMessage(brandId<ChatId>(chatId), messageId);

	// ─── Chat summary ─────────────────────────────────────────────────────

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

	listLorebooks = (scopeType: string, ownerId?: string) =>
		this.stores.lorebooks.listLorebooksByScope(scopeType, ownerId);

	createLorebook = (body: { name: string; description?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string; scanDepth?: number; tokenBudget?: number; recursiveScanning?: boolean }) =>
		this.stores.lorebooks.createLorebook(body);

	updateLorebookMeta = (lorebookId: string, body: { name?: string; description?: string; scanDepth?: number; tokenBudget?: number; recursiveScanning?: boolean }) =>
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

	testLoreActivation = async (lorebookId: string, body: { text: string }) => {
		const entries = await this.stores.lorebooks.listEntries(lorebookId);
		const activated = entries.filter(e =>
			e.enabled && e.keys.some(k => k && body.text.toLowerCase().includes(k.toLowerCase()))
		);
		return { activatedIds: activated.map(e => e.id), totalEntries: entries.length };
	};

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
		const messages = body.messages ?? (body.lastMessage ? [{ role: "user", content: body.lastMessage }] : []);
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
	createPromptPreset = (body: any) => this.promptPresetService.createPromptPreset(body);
	updatePromptPreset = (presetId: string, body: any) => this.promptPresetService.updatePromptPreset(presetId, body);
	deletePromptPreset = (presetId: string) => this.promptPresetService.deletePromptPreset(presetId);

	// ─── Assets ───────────────────────────────────────────────────────────

	uploadAsset = (file: File) => this.assetService.upload(file);
	serveAsset = (assetId: string) => this.assetService.serve(assetId);
}
