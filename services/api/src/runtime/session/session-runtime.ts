import { type PromptPreset, type StoreContainer, type UiSettings } from "@vibe-tavern/db";
import type { PromptPresetDto, PromptTraceRecordDto } from "@vibe-tavern/domain";
import {
	type CharacterId,
	type ChatBranchId,
	type ChatId,
	type MessageId,
	type PromptPresetId,
	type StoredProviderProfileRecord,
	SYSTEM_RESOURCE_ID,
} from "@vibe-tavern/domain";
import { ChatApplicationService } from "../../domain/chat/chat-application-service.js";
import {
	internal,
	notFound,
	validation,
} from "../../shared/errors.js";
import { PromptAssemblyService } from "../../domain/prompt/prompt-assembly-service.js";
import { StaticPromptResolver } from "../../domain/prompt/prompt-resolver.js";
import {
	mapMessageDto,
	mapPromptTraceRecord,
} from "./session-runtime-dto.js";

export type { PreparedLiveTurn } from "./session-runtime-chat.js";
export type { MessageDto } from "./session-runtime-dto.js";

// Domain response DTOs live in the contract now (api/contract/session-types).
// Imported locally so this module can name them in its own signatures, and
// re-exported for the sibling session/* files (composition-root-adjacent)
// that still reach for them here. External domains import from the contract
// directly.
import type {
	ChatListItem,
	SessionSnapshot,
	BootstrapState,
	ImportResult,
	MessageResponse,
	VariantResponse,
	BranchResponse,
	BranchMetaResponse,
	ChatListResponse,
	ChatSwitchResponse,
	ChatCreateResponse,
	ConfigPatchResponse,
	SummaryResponse,
} from "../../api/contract/session-types.js";
export type {
	ChatListItem,
	SessionSnapshot,
	BootstrapState,
	ImportResult,
	MessageResponse,
	VariantResponse,
	BranchResponse,
	BranchMetaResponse,
	ChatListResponse,
	ChatSwitchResponse,
	ChatCreateResponse,
	ConfigPatchResponse,
	SummaryResponse,
};

import {
	type CharacterRecord,
	CharacterRuntime,
} from "../../domain/character/character-runtime.js";
import { type PersonaRecord, PersonaRuntime } from "../../domain/persona/persona-runtime.js";
import { ChatRuntime } from "./session-runtime-chat.js";
import { ChatOrderService } from "./session-runtime-chat-order.js";
import { ChatLifecycleRuntime } from "./session-runtime-chat-lifecycle.js";
import * as importExportModule from "./session-runtime-import-export.js";
// lorebookModule removed — CRUD is wired directly through stores in RuntimeApiAdapter
import { scanSillyTavernDirectory as scanST, importSillyTavernDirectory as importST } from "../../shared/st-directory-scanner.js";


	/**
	 * Top-level coordinator for all session state.
	 *
	 * Creates and wires sub-runtimes via constructor injection + callback functions:
	 * - {@link ChatRuntime} — live chat orchestration (prepare turn, append reply, variants)
	 * - {@link CharacterRuntime} — character CRUD, import, archive
	 * - {@link PersonaRuntime} — persona CRUD, defaults
	 * - {@link ChatLifecycleRuntime} — create/delete/switch chats, summary prompt assembly
	 * - {@link ChatOrderService} — in-memory ordered chat list
	 * - {@link PromptAssemblyService} — loads context from DB and calls assemblePrompt()
	 */
	export class SessionRuntime {
	private readonly stores: StoreContainer;
	private readonly resolver: StaticPromptResolver;
	readonly chatApp: ChatApplicationService;
	private readonly promptService: PromptAssemblyService;
	private readonly chatOrder: ChatOrderService;
	private defaultsEnsured = false;
	private readonly getActiveProviderProfile: () => Promise<StoredProviderProfileRecord | null>;

	readonly chatRuntime: ChatRuntime;
	readonly persona: PersonaRuntime;
	readonly character: CharacterRuntime;
	readonly chatLifecycle: ChatLifecycleRuntime;

	constructor(
		stores: StoreContainer,
		options?: {
			getActiveProviderProfile?: () => Promise<StoredProviderProfileRecord | null>;
			dataDir?: string;
		},
	) {
		this.stores = stores;
		this.resolver = new StaticPromptResolver(stores);
		this.chatApp = new ChatApplicationService(stores.chats);
		this.promptService = new PromptAssemblyService(stores, this.resolver, this.stores.content.fileStore);
		this.getActiveProviderProfile =
			options?.getActiveProviderProfile ?? (async () => null);
		this.chatOrder = new ChatOrderService(stores.chats);
		this.chatRuntime = new ChatRuntime({
			chats: stores.chats,
			chatApp: this.chatApp,
			assemblePrompt: (chatId, branchId, opts) =>
				this.assemblePrompt(chatId, branchId, opts),
			getSnapshot: (chatId) => this.getSnapshot(chatId),
			buildMessageResponse: (chatId, opts) => this.buildMessageResponse(chatId, opts),
			buildVariantResponse: (chatId, opts) => this.buildVariantResponse(chatId, opts),
			buildBranchResponse: (chatId) => this.buildBranchResponse(chatId),
			buildBranchMetaResponse: (chatId) => this.buildBranchMetaResponse(chatId),
			chatOrder: this.chatOrder,
		});
		this.chatOrder.seed();
		this.persona = new PersonaRuntime({
			stores,
			chatOrder: this.chatOrder,
			getSnapshot: (chatId) => this.getSnapshot(chatId),
		});
		this.chatLifecycle = new ChatLifecycleRuntime({
			stores,
			chatApp: this.chatApp,
			chatOrder: this.chatOrder,
			persona: this.persona,
			resolveDefaultPromptPresetId: () => this.ensureDefaultPresetId(),
			getSnapshot: (chatId) => this.getSnapshot(chatId),
			seedImportedOpening: (chatId, firstMessage, alternateGreetings) =>
				this.chatLifecycle.seedImportedOpening(chatId, firstMessage, alternateGreetings),
			assemblePrompt: (chatId, branchId, opts) =>
				this.assemblePrompt(chatId, branchId, opts),
		});
		this.character = new CharacterRuntime({
			stores,
			chatApp: this.chatApp,
			chatOrder: this.chatOrder,
			getSnapshot: (chatId) => this.getSnapshot(chatId),
			resolveDefaultPersonaId: () => this.persona.resolveDefaultId(),
			resolveDefaultPromptPresetId: () => this.ensureDefaultPresetId(),
			seedImportedOpening: (chatId, firstMessage, alternateGreetings) =>
				this.chatLifecycle.seedImportedOpening(chatId, firstMessage, alternateGreetings),
			discardPendingPromptTrace: (chatId) =>
				this.chatRuntime.discardPendingPromptTrace(chatId),
		});
	}

	// ─── Bootstrap & Snapshot ───────────────────────────────────────────

	async getBootstrapState(): Promise<BootstrapState> {
		const initialChatId = this.chatOrder.items[0] ?? null;
		const [userChars, allChats, promptPresets, uiSettings] = await Promise.all([
			this.stores.characters.listAll(),
			this.stores.chats.listAll(),
			this.stores.presets.listAll(),
			this.stores.uiSettings.get(),
		]);
		const isArmServer = process.arch.startsWith('arm') && process.platform !== 'darwin';
		return {
			initialChatId,
			snapshot: initialChatId ? await this.getSnapshot(initialChatId) : null,
			isFirstRun: allChats.length === 0 && userChars.length === 0,
			allCharacters: userChars.map((c) => ({
				id: c.id,
				name: c.name,
				subtitle: c.tags.length > 0 ? c.tags[0] : '',
				avatarAssetId: c.avatarAssetId,
				avatarFullAssetId: c.avatarFullAssetId,
				avatarCropJson: c.avatarCropJson,
				avatarExt: c.avatarExt,
				updatedAt: c.updatedAt,
			})),
			promptPresets: promptPresets.map((p) => this.mapPresetToDto(p)),
			uiSettings,
			isArmServer,
		};
	}

	/**
	 * Returns the full session state for the frontend:
	 * chat list, active chat messages + branches, persona, character, prompt traces.
	 */
	async getSnapshot(chatId: ChatId): Promise<SessionSnapshot> {
		/*
		 * Monolithic snapshot — returns EVERY field on every call.
		 *
		 * Being replaced by per-endpoint response builders (Wave B1,
		 * CHAT_FRONTEND_REFACTOR_PLAN.md). Until B1.2–B1.5 wire the builders
		 * into routes, every mutation still returns this full snapshot —
		 * correct but wasteful (renaming a chat re-computes contextPreview).
		 *
		 * `contextPreview` is always live: it reflects the current chat,
		 * character, persona, and preset state on every call. Traces do NOT
		 * shadow it — the trace is a historical record of a past assembly,
		 * while `contextPreview` is the live "what would be sent right now".
		 * The per-endpoint builders share this invariant (they compute the
		 * preview via `assembleContextPreview` directly).
		 */
		const { chat, branch, messages: branchMessages } = await this.chatApp.getChatState(chatId);
		const promptTraceHistory = await this.getPromptTraceHistory(
			chat.id as ChatId,
			branch.id as ChatBranchId,
		);

		const [messagesWithVariants, branches, summaries, character, persona, chats, allCharacters] =
			await Promise.all([
				this.buildMessagesWithVariants(branchMessages, branch.id as ChatBranchId),
				this.fetchBranchesWithCounts(chat.id as ChatId),
				this.fetchSummaries(chat.id as ChatId, branch.id as ChatBranchId),
				this.resolver.getCharacter(chat.characterId),
				this.resolver.getPersona(
					chat.personaId ?? await this.persona.resolveDefaultId(),
				),
				Promise.all(this.chatOrder.items.map((id) => this.mapChatToListItem(id))),
				this.getAllCharacterEntries(),
			]);

		return {
			chats,
			allCharacters,
			activeChat: chat,
			activeBranch: branch,
			branches,
			messages: messagesWithVariants,
			summaries,
			promptTrace: promptTraceHistory[0] ?? null,
			promptTraceHistory,
			contextPreview: await this.assembleContextPreview(chatId, branch.id as ChatBranchId),
			character,
			persona,
		};
	}
	private async assembleContextPreview(chatId: ChatId, branchId: ChatBranchId): Promise<import("@vibe-tavern/domain").AssemblePromptResponse | null> {
		try {
			const profile = await this.getActiveProviderProfile();
			const assembled = await this.assemblePrompt(chatId, branchId, {
				contextBudget: profile?.contextBudget ?? null,
				responseReserve: profile?.maxTokens ?? 0,
			});
			return {
				layers: assembled.promptTraceDraft.assembledLayers as import("@vibe-tavern/domain").PromptLayerDto[],
				tokenAccounting: assembled.promptTraceDraft.tokenAccounting,
				activatedLoreEntries: assembled.promptTraceDraft.activatedLoreEntries,
				scriptInjections: assembled.promptTraceDraft.scriptInjections,
				retrievedMemories: assembled.promptTraceDraft.retrievedMemories,
				finalPayload: assembled.promptTraceDraft.finalPayload,
				prefill: assembled.promptTraceDraft.prefill,
				compactionSummary: assembled.promptTraceDraft.compactionSummary,
			};
		} catch {
			return null;
		}
	}

	// ─── Per-endpoint response builders (Wave B1) ───────────────────────
	//
	// Narrowed alternatives to {@link getSnapshot}: each returns ONLY the
	// fields a given mutation touches, so the frontend re-renders just the
	// affected region. `contextPreview` is computed via `assembleContextPreview`
	// directly and is always live. See the field-ownership table in
	// `CHAT_FRONTEND_REFACTOR_PLAN.md` (Wave B1).
	//
	// B1.1: ADDITIVE ONLY — the builder methods + shared fetch primitives landed
	// here, behavior-pinned by `session-runtime-builders.test.ts`.
	// B1.2: message + variant paths WIRED — appendAssistantReply, appendMessageVariant,
	// select/deleteMessageVariant, editMessage, deleteMessage, setGreetingIndex now
	// return these narrowed shapes (not getSnapshot).
	// B1.3: branch path WIRED — forkBranch, activateBranch, deleteBranch return
	// BranchResponse; renameBranch returns BranchMetaResponse (no contextPreview —
	// text unchanged). Remaining paths (navigation / config+summary) still serve
	// `getSnapshot` until B1.4–B1.5.

	/** Message-path mutations: send, regenerate, edit, delete, create-variant. */
	async buildMessageResponse(
		chatId: ChatId,
		opts?: { summaries?: boolean },
	): Promise<MessageResponse> {
		const { branch, messages } = await this.chatApp.getChatState(chatId);
		const branchId = branch.id as ChatBranchId;
		const [messagesWithVariants, contextPreview, latestTrace] = await Promise.all([
			this.buildMessagesWithVariants(messages, branchId),
			this.assembleContextPreview(chatId, branchId),
			// Latest single trace only — the full history is lazy-loaded (TRACE_LAZY_LOADING).
			this.getPromptTraceHistory(chatId, branchId, 1),
		]);
		const response: MessageResponse = {
			messages: messagesWithVariants,
			contextPreview,
			promptTrace: latestTrace[0] ?? null,
		};
		if (opts?.summaries) {
			response.summaries = await this.fetchSummaries(chatId, branchId);
		}
		return response;
	}

	/** Variant-path mutations: select-variant, delete-variant, set-greeting. */
	async buildVariantResponse(
		chatId: ChatId,
		opts?: { activeChat?: boolean },
	): Promise<VariantResponse> {
		const { chat, branch, messages } = await this.chatApp.getChatState(chatId);
		const branchId = branch.id as ChatBranchId;
		const response: VariantResponse = {
			messages: await this.buildMessagesWithVariants(messages, branchId),
			contextPreview: await this.assembleContextPreview(chatId, branchId),
		};
		if (opts?.activeChat) {
			response.activeChat = chat;
		}
		return response;
	}

	/** Branch-mutating ops: fork, activate, delete-branch (conversation text moves). */
	async buildBranchResponse(chatId: ChatId): Promise<BranchResponse> {
		const { branch, messages } = await this.chatApp.getChatState(chatId);
		const branchId = branch.id as ChatBranchId;
		const [messagesWithVariants, branches, summaries, contextPreview] = await Promise.all([
			this.buildMessagesWithVariants(messages, branchId),
			this.fetchBranchesWithCounts(chatId),
			this.fetchSummaries(chatId, branchId),
			this.assembleContextPreview(chatId, branchId),
		]);
		return {
			messages: messagesWithVariants,
			activeBranch: branch,
			branches,
			summaries,
			contextPreview,
		};
	}

	/** Branch-metadata-only op: rename-branch (no text change → no contextPreview). */
	async buildBranchMetaResponse(chatId: ChatId): Promise<BranchMetaResponse> {
		return { branches: await this.fetchBranchesWithCounts(chatId) };
	}

	/** Chat-list-only op: rename-chat (sidebar label changes, nothing else). */
	async buildChatListResponse(): Promise<ChatListResponse> {
		return { chats: await this.fetchChatList() };
	}

	/** Chat switch / clone — full reload of the active chat's view state. */
	async buildChatSwitchResponse(
		chatId: ChatId,
		opts?: { persona?: boolean; chats?: boolean },
	): Promise<ChatSwitchResponse> {
		const { chat, branch, messages } = await this.chatApp.getChatState(chatId);
		const branchId = branch.id as ChatBranchId;
		const [messagesWithVariants, branches, summaries, contextPreview, character] = await Promise.all([
			this.buildMessagesWithVariants(messages, branchId),
			this.fetchBranchesWithCounts(chatId),
			this.fetchSummaries(chatId, branchId),
			this.assembleContextPreview(chatId, branchId),
			this.resolver.getCharacter(chat.characterId),
		]);
		const response: ChatSwitchResponse = {
			messages: messagesWithVariants,
			activeChat: chat,
			activeBranch: branch,
			branches,
			summaries,
			contextPreview,
			character,
		};
		if (opts?.persona) {
			response.persona = await this.resolver.getPersona(
				chat.personaId ?? await this.persona.resolveDefaultId(),
			);
		}
		if (opts?.chats) {
			response.chats = await this.fetchChatList();
		}
		return response;
	}

	/** Chat create / clear — new chat appears in the sidebar, fresh view state. */
	async buildChatCreateResponse(chatId: ChatId): Promise<ChatCreateResponse> {
		const { chat, branch, messages } = await this.chatApp.getChatState(chatId);
		const branchId = branch.id as ChatBranchId;
		const [messagesWithVariants, branches, summaries, contextPreview, character, chats] =
			await Promise.all([
				this.buildMessagesWithVariants(messages, branchId),
				this.fetchBranchesWithCounts(chatId),
				this.fetchSummaries(chatId, branchId),
				this.assembleContextPreview(chatId, branchId),
				this.resolver.getCharacter(chat.characterId),
				this.fetchChatList(),
			]);
		return {
			chats,
			messages: messagesWithVariants,
			activeChat: chat,
			activeBranch: branch,
			branches,
			summaries,
			contextPreview,
			character,
		};
	}

	/** Config-patch ops: set-persona, set-preset, character-patch, memory-settings. */
	async buildConfigPatchResponse(
		chatId: ChatId,
		opts?: { persona?: boolean; character?: boolean; activeChat?: boolean },
	): Promise<ConfigPatchResponse> {
		const { chat, branch } = await this.chatApp.getChatState(chatId);
		const branchId = branch.id as ChatBranchId;
		const response: ConfigPatchResponse = {
			contextPreview: await this.assembleContextPreview(chatId, branchId),
		};
		if (opts?.persona) {
			response.persona = await this.resolver.getPersona(
				chat.personaId ?? await this.persona.resolveDefaultId(),
			);
		}
		if (opts?.character) {
			response.character = await this.resolver.getCharacter(chat.characterId);
		}
		if (opts?.activeChat) {
			response.activeChat = chat;
		}
		return response;
	}

	/** Summary CRUD: create / update / delete ranged summary. */
	async buildSummaryResponse(chatId: ChatId): Promise<SummaryResponse> {
		const { branch } = await this.chatApp.getChatState(chatId);
		return { summaries: await this.fetchSummaries(chatId, branch.id as ChatBranchId) };
	}

	// ─── Private: shared fetch primitives (used by getSnapshot + builders) ──

	/** Maps branch messages with their variant swipes. Fetches variants for the branch. */
	private async buildMessagesWithVariants(
		messages: import("@vibe-tavern/db").Message[],
		branchId: ChatBranchId,
	): Promise<SessionSnapshot["messages"]> {
		const variantsByMessage = await this.stores.chats.getVariantsByBranch(branchId);
		return messages.map((message) =>
			mapMessageDto(message, variantsByMessage.get(message.id) ?? []),
		);
	}

	/** All branches for a chat, each annotated with its message count. */
	private async fetchBranchesWithCounts(chatId: ChatId): Promise<SessionSnapshot["branches"]> {
		const branches = await this.stores.chats.getBranches(chatId);
		const counts = await this.stores.chats.getBranchMessageCounts(chatId);
		return branches.map((b) => ({ ...b, messageCount: counts.get(b.id) ?? 0 }));
	}

	/** Ranged summaries for a branch, mapped to the wire shape. */
	private async fetchSummaries(
		chatId: ChatId,
		branchId: ChatBranchId,
	): Promise<SessionSnapshot["summaries"]> {
		const rows = await this.stores.chatSummaries.listByChatBranch(chatId, branchId);
		return rows.map((summary) => ({
			id: summary.id,
			kind: summary.source,
			summary: summary.content,
		}));
	}

	/** Ordered sidebar chat list (derived from the in-memory chat order). */
	private async fetchChatList(): Promise<SessionSnapshot["chats"]> {
		return Promise.all(this.chatOrder.items.map((id) => this.mapChatToListItem(id)));
	}

	async getPromptTraceHistory(
		chatId: ChatId,
		branchId?: ChatBranchId,
		limit = 12,
	): Promise<PromptTraceRecordDto[]> {
		const traces = await this.stores.chats.getTracesByChat(chatId, branchId);
		return traces.slice(0, limit).map(mapPromptTraceRecord);
	}

	async rebuildChatOrder(): Promise<void> {
		await this.chatOrder.refresh();
	}

	// ─── Delegated: import/export ───────────────────────────────────────

	private get importExportDeps(): importExportModule.ImportExportModuleDeps {
		return {
			stores: this.stores,
			resolver: this.resolver,
			chatApp: this.chatApp,
			chatOrder: this.chatOrder,
			fileStore: this.stores.content.fileStore,
			resolveDefaultPersonaId: () => this.persona.resolveDefaultId(),
			resolveDefaultPromptPresetId: () => this.ensureDefaultPresetId(),
			getSnapshot: (chatId) => this.getSnapshot(chatId),
			seedImportedOpening: (chatId, firstMessage, alternateGreetings) =>
				this.chatLifecycle.seedImportedOpening(chatId, firstMessage, alternateGreetings),
		};
	}

	async exportCharacter(characterId: string): Promise<Record<string, unknown>> {
		return await importExportModule.exportCharacter(this.importExportDeps, characterId);
	}

	async exportChatJsonl(chatId: string): Promise<string> {
		return await importExportModule.exportChatJsonl(this.importExportDeps, chatId);
	}

	async exportPromptTrace(traceId: string): Promise<PromptTraceRecordDto> {
		return await importExportModule.exportPromptTrace(this.importExportDeps, traceId);
	}

	async mirrorChatTranscript(chatId: string): Promise<string[]> {
		return await importExportModule.mirrorChatTranscript(this.importExportDeps, chatId);
	}

	async mirrorPromptTrace(traceId: string): Promise<string> {
		return await importExportModule.mirrorPromptTrace(this.importExportDeps, traceId);
	}

	async importJson(input: { fileName: string; jsonText: string; chatId?: string }): Promise<ImportResult> {
		return importExportModule.importJson(this.importExportDeps, input);
	}

	scanSillyTavernDirectory(dirPath: string) {
		return scanST(dirPath);
	}

	importSillyTavernDirectory(dirPath: string) {
		return importST(this.importExportDeps, dirPath);
	}

	// ─── Private: prompt wiring ─────────────────────────────────────────

	/**
	 * Wiring method: delegates to {@link PromptAssemblyService.assembleForChat}.
	 * Resolves the active provider profile (currently unused beyond triggering the read)
	 * and passes context to the prompt service.
	 */
	private async assemblePrompt(
		chatId: ChatId,
		branchId?: ChatBranchId,
		options?: { excludeMessageIds?: MessageId[]; model?: string; recentMessageLimit?: number; mode?: "chat" | "continue" | "regenerate" | "summary" | "tool_call"; contextBudget?: number | null; responseReserve?: number },
	) {
		void await this.getActiveProviderProfile();
		return this.promptService.assembleForChat({
			chatId,
			branchId,
			model: options?.model ?? SYSTEM_RESOURCE_ID.unresolvedModel,
			excludeMessageIds: options?.excludeMessageIds,
			recentMessageLimit: options?.recentMessageLimit,
			mode: options?.mode,
			contextBudget: options?.contextBudget ?? null,
			responseReserve: options?.responseReserve,
		});
	}

	private async ensureDefaultPresetId(): Promise<PromptPresetId> {
		await this.ensureDefaultPresetOnce();
		const presets = await this.stores.presets.listAll();
		const globalPreset =
			presets.find((preset) => !preset.bindProviderPresetId) ?? presets[0];
		if (!globalPreset) {
			throw internal("No prompt preset is available for new chats.");
		}
		return globalPreset.id as PromptPresetId;
	}

	/** Creates a "Default" prompt preset on first call if none exist. */
	private async ensureDefaultPresetOnce(): Promise<void> {
		if (this.defaultsEnsured) return;
		this.defaultsEnsured = true;
		if ((await this.stores.presets.listAll()).length === 0) {
			await this.stores.presets.create({
				name: "Default",
				systemPrompt: "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.",
			});
		}
	}

	// ─── Private: DTO helpers ───────────────────────────────────────────

	private mapPresetToDto(preset: PromptPreset): PromptPresetDto {
		return {
			id: preset.id,
			name: preset.name,
			bindModel: preset.bindProviderPresetId ?? "",
			system: preset.systemPrompt,
			jailbreak: preset.postHistoryInstructions,
			prefill: preset.assistantPrefix,
			authorsNote: preset.authorsNote,
			authorsNoteDepth: preset.authorsNoteDepth,
			authorsNotePosition: (preset.authorsNotePosition as "in_prompt" | "in_chat" | "after_chat") ?? "in_chat",
			authorsNoteRole: (preset.authorsNoteRole as "system" | "user" | "assistant") ?? "system",
			summary: preset.summaryPrompt,
			tools: preset.toolsPrompt,
			nsfw: preset.nsfwPrompt ?? "",
			enhanceDefinitions: preset.enhanceDefinitionsPrompt ?? "",
			customInjections: preset.customInjections,
			promptOrder: preset.promptOrder,
			advancedMode: preset.advancedMode,
			scriptAiSystemPrompt: preset.scriptAiSystemPrompt ?? "",
			aiAssistantPrompts: (preset as { aiAssistantPrompts?: string }).aiAssistantPrompts ?? "{}",
			createdAt: preset.createdAt,
			updatedAt: preset.updatedAt,
		};
	}

	private async mapChatToListItem(chatId: ChatId): Promise<ChatListItem> {
		const chat = (await this.stores.chats.getById(chatId))!;
		const chatState = await this.chatApp.getChatState(chatId, chat.activeBranchId as ChatBranchId);
		let characterName = "Unknown";
		let subtitle = "";
		try {
			const charRecord = await this.resolver.getCharacter(chat.characterId);
			characterName = charRecord.name;
			subtitle = charRecord.subtitle ?? "";
		} catch {}
		return {
			id: chat.id as ChatId,
			title: chat.title,
			characterId: chat.characterId as CharacterId,
			characterName,
			subtitle,
			activeBranchLabel: chatState.branch.label,
			messageCount: chatState.messages.length,
			updatedAt: chat.updatedAt,
		};
	}

	private async getAllCharacterEntries(): Promise<Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null; avatarFullAssetId: string | null; avatarCropJson: string | null; avatarExt: string | null; updatedAt: string }>> {
		const characters = await this.stores.characters.listAll();
		return characters.map((c) => ({
			id: c.id,
			name: c.name,
			subtitle: c.tags.length > 0 ? c.tags[0] : '',
			avatarAssetId: c.avatarAssetId,
			avatarFullAssetId: c.avatarFullAssetId,
			avatarCropJson: c.avatarCropJson,
			avatarExt: c.avatarExt,
			updatedAt: c.updatedAt,
		}));
	}

	async setGreetingIndex(chatId: ChatId, greetingIndex: number): Promise<VariantResponse> {
		// Deprecated compatibility endpoint: greeting selection now lives on the
		// first assistant message's selected variant, not on the chat row.
		const { messages } = await this.chatApp.getChatState(chatId);
		const firstAssistant = messages.find((message) => message.role === "assistant");
		if (firstAssistant) {
			const variants = await this.stores.chats.getVariants(firstAssistant.id);
			if (variants.some((variant) => variant.variantIndex === greetingIndex)) {
				await this.stores.chats.selectVariant(firstAssistant.id, greetingIndex);
			}
		}
		await this.stores.chats.setSelectedGreetingIndex(chatId, 0);
		return this.buildVariantResponse(chatId, { activeChat: true });
	}
}
