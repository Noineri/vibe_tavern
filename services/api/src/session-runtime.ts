import { type PromptPreset, type StoreContainer, createFileStore } from "@rp-platform/db";
import type { PromptPresetDto, PromptTraceRecordDto } from "@rp-platform/domain";
import {
	brandId,
	type CharacterId,
	type ChatBranchId,
	type ChatId,
	type LoreEntry,
	type MessageId,
	type PromptPresetId,
	type RetrievedMemoryHit,
	type StoredProviderProfileRecord,
	SYSTEM_RESOURCE_ID,
} from "@rp-platform/domain";
import {
	buildPromptVariableContext,
	createPhaseOneMacroEngine,
} from "@rp-platform/prompt-pipeline";
import { ChatApplicationService } from "./chat-application-service.js";
import {
	internal,
	isDomainError,
	notFound,
	validation,
} from "./errors.js";
import {
	type PromptAssemblyResolver,
	PromptAssemblyService,
} from "./prompt-assembly-service.js";
import {
	entryMatchesRecentText,
	mapMessageDto,
	mapPromptTraceRecord,
} from "./session-runtime-dto.js";

export type { PreparedLiveTurn } from "./session-runtime-chat.js";
export type { MessageDto } from "./session-runtime-dto.js";

import {
	type CharacterRecord,
	type PersonaRecord,
	CharacterRuntime,
	toCharacterRecord,
} from "./session-runtime-character.js";
import { ChatRuntime } from "./session-runtime-chat.js";
import { ChatOrderService } from "./session-runtime-chat-order.js";
import { PersonaRuntime } from "./session-runtime-persona.js";
import { ChatLifecycleRuntime } from "./session-runtime-chat-lifecycle.js";
import type { MessageDto } from "./session-runtime-dto.js";
import * as importExportModule from "./session-runtime-import-export.js";
import * as lorebookModule from "./session-runtime-lorebook.js";

const phaseOneMacroEngine = createPhaseOneMacroEngine();

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
	allCharacters: Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null }>;
	activeChat: import("@rp-platform/db").Chat;
	activeBranch: import("@rp-platform/db").ChatBranch;
	branches: import("@rp-platform/db").ChatBranch[];
	messages: MessageDto[];
	summaries: Array<{
		id: string;
		kind: string;
		summary: string;
	}>;
	promptTrace: PromptTraceRecordDto | null;
	promptTraceHistory: PromptTraceRecordDto[];
	character: CharacterRecord;
	persona: PersonaRecord | null;
}

export interface BootstrapState {
	initialChatId: ChatId | null;
	snapshot: SessionSnapshot | null;
	isFirstRun: boolean;
	allCharacters: Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null }>;
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

class StaticPromptResolver implements PromptAssemblyResolver {
	constructor(private readonly stores: StoreContainer) {}

	async getCharacter(characterId: string) {
		const character = await this.stores.characters.getById(characterId);
		if (!character) {
			throw notFound("Character", `Character '${characterId}' was not found.`);
		}
		// No character versions in phase 1
		return toCharacterRecord(character as any, null);
	}

	async getPersona(personaId: string) {
		const p = await this.stores.personas.getById(personaId);
		if (!p) return null;
		return { id: p.id, name: p.name, description: p.description, pronouns: p.pronouns, avatarAssetId: p.avatarAssetId };
	}

	async getPromptPreset(presetId: string) {
		const preset = await this.stores.presets.getById(presetId);
		if (!preset) return null;
		return {
			id: preset.id,
			name: preset.name,
			text: preset.systemPrompt,
			jailbreak: preset.postHistoryInstructions,
			summary: preset.summaryPrompt,
			tools: preset.toolsPrompt,
			prefill: preset.assistantPrefix,
			authorsNote: preset.authorsNote,
			authorsNoteDepth: preset.authorsNoteDepth,
		};
	}

	async listActiveLoreEntries(input: {
		chatId: ChatId;
		branchId: ChatBranchId;
		recentText: string;
	}): Promise<LoreEntry[]> {
		// Phase 1: no lorebook support
		void input;
		return [];
	}

	async listRetrievedMemories(input: {
		chatId: ChatId;
		branchId: ChatBranchId;
		recentText: string;
	}): Promise<RetrievedMemoryHit[]> {
		void input;
		return [];
	}

	getToolInstructions(): string | null {
		return null;
	}
}

export class SessionRuntime {
	private readonly stores: StoreContainer;
	private readonly resolver: StaticPromptResolver;
	private readonly chatApp: ChatApplicationService;
	private readonly promptService: PromptAssemblyService;
	private readonly chatOrder: ChatOrderService;
	private readonly fileStore = createFileStore();
	readonly chatRuntime: ChatRuntime;
	readonly persona: PersonaRuntime;
	readonly character: CharacterRuntime;
	readonly chatLifecycle: ChatLifecycleRuntime;
	private defaultsEnsured = false;
	private readonly getActiveProviderProfile: () => Promise<StoredProviderProfileRecord | null>;

	private get importExportDeps(): importExportModule.ImportExportModuleDeps {
		return {
			stores: this.stores,
			resolver: this.resolver as any,
			chatApp: this.chatApp,
			chatOrder: this.chatOrder,
			fileStore: this.fileStore,
			resolveDefaultPersonaId: () => this.persona.resolveDefaultId(),
			resolveDefaultPromptPresetId: () => this.resolveDefaultPromptPresetId(),
			getSnapshot: (chatId) => this.getSnapshot(chatId),
			seedImportedOpening: (chatId, firstMessage) =>
				this.seedImportedOpening(chatId, firstMessage),
		};
	}

	private get lorebookDeps(): lorebookModule.LorebookModuleDeps {
		return { stores: this.stores };
	}

	constructor(
		stores: StoreContainer,
		options?: {
			getActiveProviderProfile?: () => Promise<StoredProviderProfileRecord | null>;
		},
	) {
		this.stores = stores;
		this.resolver = new StaticPromptResolver(stores);
		this.chatApp = new ChatApplicationService(stores.chats);
		this.promptService = new PromptAssemblyService(stores, this.resolver);
		this.getActiveProviderProfile =
			options?.getActiveProviderProfile ?? (async () => null);
		this.chatOrder = new ChatOrderService(stores.chats);
		this.chatRuntime = new ChatRuntime({
			chats: stores.chats,
			chatApp: this.chatApp,
			assemblePrompt: (chatId, branchId, options) =>
				this.assemblePrompt(chatId, branchId, options),
			getSnapshot: (chatId) => this.getSnapshot(chatId),
			chatOrder: this.chatOrder,
		});
		this.chatOrder.seed();
		this.persona = new PersonaRuntime({
			stores,
			chatOrder: this.chatOrder,
			getSnapshot: (chatId) => this.getSnapshot(chatId),
		});
		this.character = new CharacterRuntime({
			stores,
			chatApp: this.chatApp,
			chatOrder: this.chatOrder,
			getSnapshot: (chatId) => this.getSnapshot(chatId),
			resolveDefaultPersonaId: () => this.persona.resolveDefaultId(),
			resolveDefaultPromptPresetId: () => this.resolveDefaultPromptPresetId(),
			seedImportedOpening: (chatId, firstMessage) =>
				this.seedImportedOpening(chatId, firstMessage),
			discardPendingPromptTrace: (chatId) =>
				this.chatRuntime.discardPendingPromptTrace(chatId),
		});
		this.chatLifecycle = new ChatLifecycleRuntime({
			stores,
			chatApp: this.chatApp,
			chatOrder: this.chatOrder,
			persona: this.persona,
			resolveDefaultPromptPresetId: () => this.resolveDefaultPromptPresetId(),
			getSnapshot: (chatId) => this.getSnapshot(chatId),
			seedImportedOpening: (chatId, firstMessage) =>
				this.seedImportedOpening(chatId, firstMessage),
			assemblePrompt: (chatId, branchId, options) =>
				this.assemblePrompt(chatId, branchId, options),
		});
	}

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
			})),
			promptPresets: promptPresets.map((preset) => this.toPromptPresetDto(preset)),
		};
	}

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

		const messagesWithVariants = await Promise.all(
			branchMessages.map(async (message) => {
				const variants = await this.stores.chats.getVariants(message.id);
				return mapMessageDto(message as any, variants as any);
			}),
		);

		return {
			chats: await Promise.all(this.chatOrder.items.map((id) => this.toChatListItem(id))),
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
			character,
			persona,
		};
	}

	async getPromptTraceHistory(
		chatId: ChatId,
		branchId?: ChatBranchId,
		limit = 12,
	): Promise<PromptTraceRecordDto[]> {
		const traces = await this.stores.chats.getTracesByChat(chatId, branchId);
		return traces.slice(0, limit).map(mapPromptTraceRecord);
	}

	private toPromptPresetDto(preset: PromptPreset): PromptPresetDto {
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

	async switchChat(chatId: ChatId): Promise<SessionSnapshot> {
		return this.getSnapshot(chatId);
	}

	async setChatPromptPreset(chatId: ChatId, promptPresetId: string): Promise<SessionSnapshot> {
		const [chat, preset] = await Promise.all([
			this.stores.chats.getById(chatId),
			this.stores.presets.getById(promptPresetId),
		]);
		if (!chat) {
			throw notFound("Chat", `Chat '${chatId}' was not found.`);
		}
		if (!preset) {
			throw notFound("PromptPreset", `Prompt preset '${promptPresetId}' was not found.`);
		}
		await this.stores.chats.setPromptPreset(chatId, promptPresetId);
		return this.getSnapshot(chatId);
	}

	getPersonalLorebookStatus(_personaId: string): {
		enabled: boolean;
		lorebookId: string | null;
	} {
		// Phase 1: no personal lorebooks
		return { enabled: false, lorebookId: null };
	}

	setPersonalLorebookEnabled(
		_personaId: string,
		_enabled: boolean,
	): { enabled: boolean; lorebookId: string | null } {
		// Phase 1: no personal lorebooks
		return { enabled: false, lorebookId: null };
	}

	async exportCharacter(characterId: string): Promise<Record<string, unknown>> {
		return await importExportModule.exportCharacter(
			this.importExportDeps,
			characterId,
		);
	}

	async exportChatJsonl(chatId: string): Promise<string> {
		return await importExportModule.exportChatJsonl(this.importExportDeps, chatId);
	}

	async exportPromptTrace(traceId: string): Promise<PromptTraceRecordDto> {
		return await importExportModule.exportPromptTrace(this.importExportDeps, traceId);
	}

	async mirrorChatTranscript(chatId: string): Promise<string[]> {
		return await importExportModule.mirrorChatTranscript(
			this.importExportDeps,
			chatId,
		);
	}

	async mirrorPromptTrace(traceId: string): Promise<string> {
		return await importExportModule.mirrorPromptTrace(this.importExportDeps, traceId);
	}

	createLoreEntry(
		 lorebookId: string,
		 input: Omit<LoreEntry, "id" | "lorebookId">,
	): LoreEntry {
		 void lorebookModule; void lorebookId; void input;
		 throw new Error("Not implemented: lorebooks are phase 2");
	}

	updateLoreEntry(
		 lorebookId: string,
		 entryId: string,
		 input: Partial<Omit<LoreEntry, "id" | "lorebookId">>,
	): LoreEntry {
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

	testLoreActivation(
		lorebookId: string,
		text: string,
	): { activatedIds: string[]; totalEntries: number } {
		 void lorebookModule; void lorebookId; void text;
		 throw new Error("Not implemented: lorebooks are phase 2");
	}

	async importJson(input: {
		fileName: string;
		jsonText: string;
		chatId?: string;
	}): Promise<ImportResult> {
		return importExportModule.importJson(this.importExportDeps, input);
	}

	async rebuildChatOrder(): Promise<void> {
		await this.chatOrder.rebuild();
	}

	private async seedImportedOpening(chatId: ChatId, firstMessage: string): Promise<void> {
		const trimmed = firstMessage.trim();
		if (!trimmed) {
			return;
		}

		const chat = (await this.stores.chats.getById(chatId))!;
		const assembled = await this.assemblePrompt(chatId, chat.activeBranchId as ChatBranchId);
		const message = await this.stores.chats.addMessage({
			chatId,
			branchId: chat.activeBranchId,
			role: "assistant",
			authorType: "assistant",
			content: trimmed,
		});
		await this.stores.chats.saveTrace({
			...assembled.promptTraceDraft,
			messageId: message.id,
		});
	}

	private async resolvePromptVariableContext(chatId: ChatId) {
		const chat = await this.stores.chats.getById(chatId);
		if (!chat) {
			throw notFound("Chat", `Chat '${chatId}' was not found.`);
		}
		const character = await this.resolver.getCharacter(chat.characterId);
		const persona = await this.resolver.getPersona(
			chat.personaId ?? await this.persona.resolveDefaultId(),
		);
		// No character versions in phase 1
		return buildPromptVariableContext({
			character: {
				name: character.name,
				description: character.description,
				personality: character.personality,
				scenario: character.scenario,
				firstMessage: character.firstMessage,
				alternateGreetings: character.alternateGreetings,
				mesExample: character.mesExample,
				postHistoryInstructions: character.postHistoryInstructions,
				creatorNotes: character.creatorNotes,
				depthPrompt: character.depthPrompt,
				depthPromptDepth: character.depthPromptDepth,
				depthPromptRole: character.depthPromptRole,
				systemPrompt: character.systemPrompt,
				version: null,
				tags: character.tags,
				characterBook: character.characterBook,
				extensions: character.extensions,
			},
			persona: {
				name: persona?.name ?? "User",
				description: persona?.description ?? "",
			},
		});
	}

	private async resolveDefaultPromptPresetId(): Promise<PromptPresetId> {
		await this.ensureDefaultsOnce();

		const presets = await this.stores.presets.listAll();
		const globalPreset =
			presets.find((preset) => !preset.bindProviderPresetId) ?? presets[0];
		if (!globalPreset) {
			throw internal("No prompt preset is available for new chats.");
		}
		return globalPreset.id as PromptPresetId;
	}

	private async ensureDefaultsOnce(): Promise<void> {
		if (this.defaultsEnsured) return;
		this.defaultsEnsured = true;

		if ((await this.stores.presets.listAll()).length === 0) {
			await this.stores.presets.create({
				name: "Default",
				systemPrompt: "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.",
			});
		}
	}

	private async assemblePrompt(
		chatId: ChatId,
		branchId?: ChatBranchId,
		options?: { excludeMessageIds?: MessageId[]; model?: string; recentMessageLimit?: number; mode?: "chat" | "continue" | "regenerate" | "summary" | "tool_call"; contextBudget?: number | null },
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
		});
	}

	private async getAllCharacterEntries(): Promise<Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null }>> {
		const characters = await this.stores.characters.listIncludingSystem();
		const hasUserChars = characters.some((c) => c.id !== 'char_system');

		if (!hasUserChars) {
			return characters.map((c) => ({
				id: c.id,
				name: c.name,
				subtitle: c.tags.length > 0 ? c.tags[0] : '',
				avatarAssetId: c.avatarAssetId,
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
			}));
	}

	private async toChatListItem(chatId: ChatId): Promise<ChatListItem> {
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
}
