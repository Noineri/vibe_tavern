import { type PromptPreset, type StoreContainer, createFileStore } from "@rp-platform/db";
import type { PromptPresetDto, PromptTraceRecordDto } from "@rp-platform/domain";
import {
	type CharacterId,
	type ChatBranchId,
	type ChatId,
	type LoreEntry,
	type MessageId,
	type PromptPresetId,
	type StoredProviderProfileRecord,
	SYSTEM_RESOURCE_ID,
} from "@rp-platform/domain";
import { ChatApplicationService } from "./chat-application-service.js";
import {
	internal,
	notFound,
	validation,
} from "./errors.js";
import { PromptAssemblyService } from "./prompt-assembly-service.js";
import { StaticPromptResolver } from "./prompt-resolver.js";
import {
	mapMessageDto,
	mapPromptTraceRecord,
} from "./session-runtime-dto.js";

export type { PreparedLiveTurn } from "./session-runtime-chat.js";
export type { MessageDto } from "./session-runtime-dto.js";

import {
	type CharacterRecord,
	type PersonaRecord,
	CharacterRuntime,
} from "./session-runtime-character.js";
import { ChatRuntime } from "./session-runtime-chat.js";
import { ChatOrderService } from "./session-runtime-chat-order.js";
import { PersonaRuntime } from "./session-runtime-persona.js";
import { ChatLifecycleRuntime } from "./session-runtime-chat-lifecycle.js";
import * as importExportModule from "./session-runtime-import-export.js";
import * as lorebookModule from "./session-runtime-lorebook.js";
import { scanSillyTavernDirectory as scanST, importSillyTavernDirectory as importST } from "./st-directory-scanner.js";

export interface ChatListItem {
	id: ChatId;
	title: string;
	characterId: CharacterId;
	characterName: string;
	subtitle: string;
	activeBranchLabel: string;
	messageCount: number;
}

export interface SessionSnapshot {
	chats: ChatListItem[];
	allCharacters: Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null; avatarFullAssetId: string | null }>;
	activeChat: import("@rp-platform/db").Chat;
	activeBranch: import("@rp-platform/db").ChatBranch;
	branches: import("@rp-platform/db").ChatBranch[];
	messages: import("./session-runtime-dto.js").MessageDto[];
	summaries: Array<{
		id: string;
		kind: string;
		summary: string;
	}>;
	promptTrace: PromptTraceRecordDto | null;
	promptTraceHistory: PromptTraceRecordDto[];
	contextPreview: import("@rp-platform/domain").AssemblePromptResponse | null;
	character: CharacterRecord;
	persona: PersonaRecord | null;
}

export interface BootstrapState {
	initialChatId: ChatId | null;
	snapshot: SessionSnapshot | null;
	isFirstRun: boolean;
	allCharacters: Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null; avatarFullAssetId: string | null }>;
	promptPresets: PromptPresetDto[];
}

export interface ImportResult {
	activeChatId: ChatId;
	snapshot: SessionSnapshot;
	imported: {
		kind: "character" | "lorebook" | "chat";
		name: string;
		fileName: string;
		warningCount: number;
		warnings: string[];
		attachedToCharacterName?: string;
	};
}

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
	private readonly chatApp: ChatApplicationService;
	private readonly promptService: PromptAssemblyService;
	private readonly chatOrder: ChatOrderService;
	private readonly fileStore: ReturnType<typeof createFileStore>;
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
		this.fileStore = createFileStore(options?.dataDir);
		this.resolver = new StaticPromptResolver(stores);
		this.chatApp = new ChatApplicationService(stores.chats);
		this.promptService = new PromptAssemblyService(stores, this.resolver, options?.dataDir);
		this.getActiveProviderProfile =
			options?.getActiveProviderProfile ?? (async () => null);
		this.chatOrder = new ChatOrderService(stores.chats);
		this.chatRuntime = new ChatRuntime({
			chats: stores.chats,
			chatApp: this.chatApp,
			assemblePrompt: (chatId, branchId, opts) =>
				this.assemblePrompt(chatId, branchId, opts),
			getSnapshot: (chatId) => this.getSnapshot(chatId),
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
			seedImportedOpening: (chatId, firstMessage) =>
				this.chatLifecycle.seedImportedOpening(chatId, firstMessage),
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
			seedImportedOpening: (chatId, firstMessage) =>
				this.chatLifecycle.seedImportedOpening(chatId, firstMessage),
			discardPendingPromptTrace: (chatId) =>
				this.chatRuntime.discardPendingPromptTrace(chatId),
		});
	}

	// ─── Bootstrap & Snapshot ───────────────────────────────────────────

	async getBootstrapState(): Promise<BootstrapState> {
		const initialChatId = this.chatOrder.items[0] ?? null;
		const [userChars, allChats, promptPresets] = await Promise.all([
			this.stores.characters.listAll(),
			this.stores.chats.listAll(),
			this.stores.presets.listAll(),
		]);
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
			})),
			promptPresets: promptPresets.map((p) => this.mapPresetToDto(p)),
		};
	}

	/**
	 * Returns the full session state for the frontend:
	 * chat list, active chat messages + branches, persona, character, prompt traces.
	 */
	async getSnapshot(chatId: ChatId): Promise<SessionSnapshot> {
		const { chat, branch, messages: branchMessages, summaries } = await this.chatApp.getChatState(chatId);
		const branches = await this.stores.chats.getBranches(chat.id);
		const character = await this.resolver.getCharacter(chat.characterId);
		const persona = await this.resolver.getPersona(
			chat.personaId ?? await this.persona.resolveDefaultId(),
		);
		const promptTraceHistory = await this.getPromptTraceHistory(
			chat.id as ChatId,
			branch.id as ChatBranchId,
		);

		const variantsByMessage = await this.stores.chats.getVariantsByBranch(branch.id);
		const messagesWithVariants = branchMessages.map((message) =>
			mapMessageDto(message, variantsByMessage.get(message.id) ?? []),
		);

		return {
			chats: await Promise.all(this.chatOrder.items.map((id) => this.mapChatToListItem(id))),
			allCharacters: await this.getAllCharacterEntries(),
			activeChat: chat,
			activeBranch: branch,
			branches,
			messages: messagesWithVariants,
			summaries: summaries.map((summary) => ({
				id: summary.id,
				kind: summary.kind,
				summary: summary.summary,
			})),
			promptTrace: promptTraceHistory[0] ?? null,
			promptTraceHistory,
			contextPreview: promptTraceHistory[0]
				? null
				: await this.assembleContextPreview(chatId, branch.id as ChatBranchId),
			character,
			persona,
		};
	}

	/** Lightweight assemble for UI display — no trace saved. */
	private async assembleContextPreview(chatId: ChatId, branchId: ChatBranchId): Promise<import("@rp-platform/domain").AssemblePromptResponse | null> {
		try {
			const profile = await this.getActiveProviderProfile();
			const assembled = await this.assemblePrompt(chatId, branchId, {
				contextBudget: profile?.contextBudget ?? null,
				responseReserve: profile?.maxTokens ?? 0,
			});
			return {
				layers: assembled.promptTraceDraft.assembledLayers as import("@rp-platform/domain").PromptLayerDto[],
				tokenAccounting: assembled.promptTraceDraft.tokenAccounting,
				activatedLoreEntries: assembled.promptTraceDraft.activatedLoreEntries,
				retrievedMemories: assembled.promptTraceDraft.retrievedMemories,
				finalPayload: assembled.promptTraceDraft.finalPayload,
				prefill: assembled.promptTraceDraft.prefill,
			};
		} catch {
			return null;
		}
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
			resolver: this.resolver as unknown as importExportModule.ImportExportResolver,
			chatApp: this.chatApp,
			chatOrder: this.chatOrder,
			fileStore: this.fileStore,
			resolveDefaultPersonaId: () => this.persona.resolveDefaultId(),
			resolveDefaultPromptPresetId: () => this.ensureDefaultPresetId(),
			getSnapshot: (chatId) => this.getSnapshot(chatId),
			seedImportedOpening: (chatId, firstMessage) =>
				this.chatLifecycle.seedImportedOpening(chatId, firstMessage),
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

	// ─── Delegated: lorebook stubs (phase 2) ────────────────────────────

	getPersonalLorebookStatus(_personaId: string): { enabled: boolean; lorebookId: string | null } {
		return { enabled: false, lorebookId: null };
	}

	setPersonalLorebookEnabled(_personaId: string, _enabled: boolean): { enabled: boolean; lorebookId: string | null } {
		return { enabled: false, lorebookId: null };
	}

	createLoreEntry(lorebookId: string, input: Omit<LoreEntry, "id" | "lorebookId">): LoreEntry {
		void lorebookModule; void lorebookId; void input;
		throw new Error("Not implemented: lorebooks are phase 2");
	}

	updateLoreEntry(lorebookId: string, entryId: string, input: Partial<Omit<LoreEntry, "id" | "lorebookId">>): LoreEntry {
		void lorebookModule; void lorebookId; void entryId; void input;
		throw new Error("Not implemented: lorebooks are phase 2");
	}

	deleteLoreEntry(lorebookId: string, entryId: string): void {
		void lorebookModule; void lorebookId; void entryId;
		throw new Error("Not implemented: lorebooks are phase 2");
	}

	listLoreEntries(lorebookId: string): LoreEntry[] {
		void lorebookModule; void lorebookId;
		throw new Error("Not implemented: lorebooks are phase 2");
	}

	testLoreActivation(lorebookId: string, text: string): { activatedIds: string[]; totalEntries: number } {
		void lorebookModule; void lorebookId; void text;
		throw new Error("Not implemented: lorebooks are phase 2");
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
			summary: preset.summaryPrompt,
			tools: preset.toolsPrompt,
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
		};
	}

	private async getAllCharacterEntries(): Promise<Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null; avatarFullAssetId: string | null }>> {
		const characters = await this.stores.characters.listIncludingSystem();
		const hasUserChars = characters.some((c) => c.id !== 'char_system');
		if (!hasUserChars) {
			return characters.map((c) => ({
				id: c.id,
				name: c.name,
				subtitle: c.tags.length > 0 ? c.tags[0] : '',
				avatarAssetId: c.avatarAssetId,
				avatarFullAssetId: c.avatarFullAssetId,
			}));
		}
		const allChats = await this.stores.chats.listAll();
		const hasSystemChat = allChats.some((c) => c.characterId === 'char_system');
		return characters
			.filter((c) => c.id !== 'char_system' || hasSystemChat)
			.map((c) => ({
				id: c.id,
				name: c.name,
				subtitle: c.tags.length > 0 ? c.tags[0] : '',
				avatarAssetId: c.avatarAssetId,
				avatarFullAssetId: c.avatarFullAssetId,
			}));
	}
}
