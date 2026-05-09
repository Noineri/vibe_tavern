import { type StoreContainer, createFileStore } from "@rp-platform/db";
import type { PromptTraceRecordDto } from "@rp-platform/domain";
import {
	brandId,
	type CharacterId,
	type ChatBranchId,
	type ChatId,
	type LoreEntry,
	type MessageId,
	type PersonaId,
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
	conflict,
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
	toCharacterRecord,
} from "./session-runtime-character.js";
import { ChatRuntime } from "./session-runtime-chat.js";
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
	allCharacters: Array<{ id: string; name: string; subtitle: string }>;
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
	allCharacters: Array<{ id: string; name: string; subtitle: string }>;
}

export interface ImportResult {
	activeChatId: ChatId;
	snapshot: SessionSnapshot;
	imported: {
		kind: "character" | "lorebook";
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
	private readonly chatOrder: ChatId[] = [];
	private readonly fileStore = createFileStore();
	readonly chatRuntime: ChatRuntime;
	private defaultsEnsured = false;
	private readonly getActiveProviderProfile: () => Promise<StoredProviderProfileRecord | null>;

	private get importExportDeps(): importExportModule.ImportExportModuleDeps {
		return {
			stores: this.stores,
			resolver: this.resolver as any,
			chatApp: this.chatApp,
			chatOrder: this.chatOrder,
			fileStore: this.fileStore,
			resolveDefaultPersonaId: () => this.resolveDefaultPersonaId(),
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
		this.chatRuntime = new ChatRuntime({
			chats: stores.chats,
			chatApp: this.chatApp,
			expandChatMacros: (chatId, text) => this.expandChatMacros(chatId, text),
			assemblePrompt: (chatId, branchId, options) =>
				this.assemblePrompt(chatId, branchId, options),
			getSnapshot: (chatId) => this.getSnapshot(chatId),
			chatOrder: {
				add: (chatId) => this.chatOrder.unshift(chatId),
				remove: (chatId) => {
					const idx = this.chatOrder.indexOf(chatId);
					if (idx !== -1) this.chatOrder.splice(idx, 1);
				},
			},
		});
		this.seed();
	}

	async getBootstrapState(): Promise<BootstrapState> {
		const initialChatId = this.chatOrder[0] ?? null;
		const [userChars, allChats] = await Promise.all([
			this.stores.characters.listAll(),
			this.stores.chats.listAll(),
		]);
		return {
			initialChatId,
			snapshot: initialChatId ? await this.getSnapshot(initialChatId) : null,
			isFirstRun: allChats.length === 0 && userChars.length === 0,
			allCharacters: userChars.map((c) => ({
				id: c.id,
				name: c.name,
				subtitle: c.tags.length > 0 ? c.tags[0] : '',
			})),
		};
	}

	async getSnapshot(chatId: ChatId): Promise<SessionSnapshot> {
		const { chat, branch, messages: branchMessages, summaries } = await this.chatApp.getChatState(chatId);
		const branches = await this.stores.chats.getBranches(chat.id);
		const character = await this.resolver.getCharacter(chat.characterId);
		const persona = await this.resolver.getPersona(
			chat.personaId ?? await this.resolveDefaultPersonaId(),
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
			chats: await Promise.all(this.chatOrder.map((id) => this.toChatListItem(id))),
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

	async switchChat(chatId: ChatId): Promise<SessionSnapshot> {
		return this.getSnapshot(chatId);
	}

	async listPersonas(): Promise<Array<{ id: string; name: string; description: string; pronouns: string | null; avatarAssetId: string | null }>> {
		const personas = await this.stores.personas.listAll();
		return personas.map((p) => ({
			id: p.id,
			name: p.name,
			description: p.description,
			pronouns: p.pronouns,
			avatarAssetId: p.avatarAssetId,
		}));
	}

	async setChatPersona(chatId: ChatId, personaId: string): Promise<SessionSnapshot> {
		const [chat, persona] = await Promise.all([
			this.stores.chats.getById(chatId),
			this.stores.personas.getById(brandId<PersonaId>(personaId)),
		]);
		if (!chat) {
			throw notFound("Chat", `Chat '${chatId}' was not found.`);
		}
		if (!persona) {
			throw notFound("Persona", `Persona '${personaId}' was not found.`);
		}
		await this.stores.chats.setPersona(chatId, personaId);
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

	async createPersona(input: {
		name: string;
		description: string;
		pronouns?: string | null;
		defaultForNewChats?: boolean;
	}): Promise<{ id: string; name: string; description: string; pronouns: string | null; avatarAssetId: string | null }> {
		const trimmedName = (input.name ?? "").trim();
		const trimmedDescription = (input.description ?? "").trim();
		if (!trimmedName) {
			throw validation("Persona name is required.");
		}
		const persona = await this.stores.personas.create({
			name: trimmedName,
			description: trimmedDescription,
			pronouns: input.pronouns?.trim() || null,
			defaultForNewChats: input.defaultForNewChats === true,
		});
		return {
			id: persona.id,
			name: persona.name,
			description: persona.description,
			pronouns: persona.pronouns,
			avatarAssetId: persona.avatarAssetId,
		};
	}

	async deletePersona(personaId: string): Promise<void> {
		try {
			await this.stores.personas.delete(brandId<PersonaId>(personaId));
		} catch (error) {
			if (isDomainError(error)) throw error;
			const message = error instanceof Error ? error.message : String(error);
			if (/referenced by one or more chats/i.test(message)) {
				throw conflict(message);
			}
			if (/not found/i.test(message)) {
				throw notFound("Persona", message);
			}
			throw error;
		}
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

	async archiveCharacter(characterId: string): Promise<{
		characterId: string;
		status: "archived";
	}> {
		const typedCharacterId = brandId<CharacterId>(characterId);
		await this.stores.characters.archive(typedCharacterId);
		const chatId = (await this.stores.chats.listAll())
			.find((c) => c.characterId === typedCharacterId)?.id;
		if (chatId) {
			const chatIndex = this.chatOrder.indexOf(chatId as ChatId);
			if (chatIndex !== -1) {
				this.chatOrder.splice(chatIndex, 1);
			}
		}
		return { characterId, status: "archived" };
	}

	async unarchiveCharacter(characterId: string): Promise<{
		characterId: string;
		status: "active";
	}> {
		await this.stores.characters.unarchive(brandId<CharacterId>(characterId));
		return { characterId, status: "active" };
	}

	async deleteCharacter(characterId: string): Promise<void> {
		const typedCharacterId = brandId<CharacterId>(characterId);
		const chatIds = (await this.stores.chats.listAll())
			.filter((c) => c.characterId === typedCharacterId)
			.map((c) => c.id as ChatId);
		for (const chatId of chatIds) {
			const idx = this.chatOrder.indexOf(chatId);
			if (idx !== -1) this.chatOrder.splice(idx, 1);
			this.chatRuntime.discardPendingPromptTrace(chatId);
		}
		await this.stores.characters.delete(typedCharacterId);
	}

	async createChatForCharacter(characterId: string): Promise<SessionSnapshot> {
		const typedCharacterId = brandId<CharacterId>(characterId);
		const character = await this.stores.characters.getById(typedCharacterId);
		if (!character) {
			throw notFound("Character", `Character '${characterId}' was not found.`);
		}

		const created = await this.chatApp.createChat({
			characterId: typedCharacterId,
			personaId: await this.resolveDefaultPersonaId(),
			title: `${character.name} chat`,
			promptPresetId: await this.resolveDefaultPromptPresetId(),
		});

		const createdChatId = created.id;
		this.chatOrder.unshift(createdChatId);

		const greeting = character.firstMessage;
		if (greeting) {
			const chat = await this.stores.chats.getById(createdChatId);
			if (chat) {
				await this.stores.chats.addMessage({
					chatId: createdChatId,
					branchId: chat.activeBranchId,
					role: "assistant",
					authorType: "assistant",
					content: this.expandChatMacros(createdChatId, greeting),
				});
			}
		}

		return this.getSnapshot(createdChatId);
	}

	async createCharacterFromScratch(input: {
		name: string;
		description?: string;
		personalitySummary?: string | null;
		scenario?: string | null;
		firstMessage?: string;
		mesExample?: string | null;
		alternateGreetings?: string[];
	}): Promise<ImportResult> {
		const character = await this.stores.characters.create({
			name: input.name,
			description: input.description,
			personalitySummary: input.personalitySummary,
			defaultScenario: input.scenario,
			firstMessage: input.firstMessage,
			mesExample: input.mesExample,
			alternateGreetings: input.alternateGreetings,
		});

		const characterId = character.id as CharacterId;

		const created = await this.chatApp.createChat({
			characterId,
			personaId: await this.resolveDefaultPersonaId(),
			title: input.name,
			promptPresetId: await this.resolveDefaultPromptPresetId(),
		});

		const createdChatId = created.id;
		this.chatOrder.unshift(createdChatId);

		if (input.firstMessage?.trim()) {
			await this.seedImportedOpening(createdChatId, input.firstMessage);
		}

		return {
			activeChatId: createdChatId,
			snapshot: await this.getSnapshot(createdChatId),
			imported: {
				kind: "character",
				name: input.name,
				fileName: "",
				warningCount: 0,
				warnings: [],
			},
		};
	}

	async createFreeChat(): Promise<SessionSnapshot> {
		// Get or create the system character
		const systemChar = await this.stores.characters.getSystemCharacter();

		const created = await this.chatApp.createChat({
			characterId: systemChar.id as CharacterId,
			personaId: await this.resolveDefaultPersonaId(),
			title: "Free chat",
			promptPresetId: await this.resolveDefaultPromptPresetId(),
		});

		const freeChatId = created.id;
		this.chatOrder.unshift(freeChatId);
		return this.getSnapshot(freeChatId);
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

	async updateCharacter(
		characterId: CharacterId,
		input: {
			chatId?: ChatId;
			name?: string;
			description?: string;
			personalitySummary?: string | null;
			scenario?: string;
			systemPrompt?: string;
			firstMessage?: string | null;
			mesExample?: string | null;
			alternateGreetings?: string[];
			postHistoryInstructions?: string | null;
			creatorNotes?: string | null;
			characterBook?: Record<string, unknown> | null;
			depthPrompt?: string | null;
			depthPromptDepth?: number | null;
			depthPromptRole?: string | null;
			extensions?: Record<string, unknown>;
			tags?: string[];
			avatarAssetId?: string | null;
		},
	): Promise<SessionSnapshot> {
		const currentCharacter = await this.stores.characters.getById(characterId);
		if (!currentCharacter) {
			throw notFound("Character", `Character '${characterId}' was not found.`);
		}

		const nextName = (input.name ?? currentCharacter.name).trim();
		if (!nextName) {
			throw validation("Character name is required.");
		}

		await this.stores.characters.update(characterId, {
			name: nextName,
			description: input.description ?? currentCharacter.description,
			personalitySummary: input.personalitySummary !== undefined
				? input.personalitySummary
				: currentCharacter.personalitySummary,
			defaultScenario: input.scenario ?? currentCharacter.defaultScenario ?? "",
			firstMessage: input.firstMessage !== undefined
				? input.firstMessage
				: currentCharacter.firstMessage,
			mesExample: input.mesExample !== undefined
				? input.mesExample
				: currentCharacter.mesExample,
			alternateGreetings: input.alternateGreetings ?? currentCharacter.alternateGreetings,
			postHistoryInstructions: input.postHistoryInstructions !== undefined
				? input.postHistoryInstructions
				: currentCharacter.postHistoryInstructions,
			creatorNotes: input.creatorNotes !== undefined
				? input.creatorNotes
				: currentCharacter.creatorNotes,
			characterBook: input.characterBook !== undefined
				? input.characterBook
				: currentCharacter.characterBook,
			depthPrompt: input.depthPrompt !== undefined
				? input.depthPrompt
				: currentCharacter.depthPrompt,
			depthPromptDepth: input.depthPromptDepth !== undefined
				? input.depthPromptDepth
				: currentCharacter.depthPromptDepth,
			depthPromptRole: input.depthPromptRole !== undefined
				? input.depthPromptRole
				: currentCharacter.depthPromptRole,
			extensions: input.extensions ?? currentCharacter.extensions,
			systemPrompt: input.systemPrompt ?? currentCharacter.systemPrompt,
			tags: input.tags ?? currentCharacter.tags,
			avatarAssetId: input.avatarAssetId !== undefined
				? input.avatarAssetId
				: currentCharacter.avatarAssetId,
		});

		// Promote system character to user character on first edit
		if ((currentCharacter as any).isSystem === 1 || (currentCharacter as any).isSystem === true) {
			await this.stores.characters.updateIsSystem(characterId, false);
			// Re-bootstrap chat order so the character appears in sidebar
			await this.rebuildChatOrder();
		}

		const preferredChat = input.chatId
			? await this.stores.chats.getById(input.chatId)
			: null;
		const targetChatId =
			((preferredChat?.characterId === characterId ? preferredChat.id : null) ??
			(await this.stores.chats.listAll()).find((chat) => chat.characterId === characterId)?.id ??
			this.chatOrder[0]) as ChatId | undefined;

		if (!targetChatId) {
			throw notFound("Chat", "No chat is available for the updated character.");
		}

		return this.getSnapshot(targetChatId);
	}

	async updatePersona(
		personaId: string,
		input: {
			chatId?: ChatId;
			name?: string;
			description?: string;
			pronouns?: string | null;
			avatarAssetId?: string | null;
		},
	): Promise<SessionSnapshot> {
		const currentPersona = await this.stores.personas.getById(brandId<PersonaId>(personaId));
		if (!currentPersona) {
			throw notFound("Persona", `Persona '${personaId}' was not found.`);
		}

		const nextName = (input.name ?? currentPersona.name).trim();
		if (!nextName) {
			throw validation("Persona name is required.");
		}

		const nextDescription = input.description ?? currentPersona.description;
		const nextPronouns = input.pronouns !== undefined ? input.pronouns : currentPersona.pronouns;
		const nextAvatarAssetId = input.avatarAssetId !== undefined ? input.avatarAssetId : currentPersona.avatarAssetId;

		await this.stores.personas.update(personaId, {
			name: nextName,
			description: nextDescription,
			pronouns: nextPronouns,
			avatarAssetId: nextAvatarAssetId,
		});

		const preferredChat = input.chatId
			? await this.stores.chats.getById(input.chatId)
			: null;
		const targetChatId =
			((preferredChat?.personaId === personaId ? preferredChat.id : null) ??
			(await this.stores.chats.listAll()).find((chat) => chat.personaId === personaId)?.id ??
			this.chatOrder[0]) as ChatId | undefined;

		if (!targetChatId) {
			throw notFound("Chat", "No chat is available for the updated persona.");
		}

		return this.getSnapshot(targetChatId);
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

	private async rebuildChatOrder(): Promise<void> {
		this.chatOrder.length = 0;
		const allChats = await this.stores.chats.listAll();
		this.chatOrder.push(...allChats.map((chat) => chat.id as ChatId));
	}

	private async seed(): Promise<void> {
		const existingChats = await this.stores.chats.listAll();
		if (existingChats.length > 0) {
			this.chatOrder.push(...existingChats.map((chat) => chat.id as ChatId));
			return;
		}
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
			content: this.expandChatMacros(chatId, trimmed),
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
			chat.personaId ?? await this.resolveDefaultPersonaId(),
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

	private expandChatMacros(chatId: ChatId, text: string): string {
		// Note: resolvePromptVariableContext is async, but expandChatMacros is sync.
		// This is a known limitation — macros won't resolve until we make this async.
		// For now, return text as-is (macros will be resolved later in the prompt pipeline).
		void chatId;
		return text;
	}

	private async resolveDefaultPersonaId(): Promise<PersonaId> {
		await this.ensureDefaultsOnce();

		const personas = await this.stores.personas.listAll();
		if (personas.length === 0) {
			const created = await this.stores.personas.create({
				name: "User",
				description: "",
				pronouns: null,
				defaultForNewChats: true,
			});
			return created.id as PersonaId;
		}

		const defaultPersona =
			personas.find((persona) => persona.defaultForNewChats) ?? personas[0];
		if (!defaultPersona) {
			throw internal("No persona is available for new chats.");
		}
		return defaultPersona.id as PersonaId;
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
		options?: { excludeMessageIds?: MessageId[]; model?: string },
	) {
		void await this.getActiveProviderProfile();
		return this.promptService.assembleForChat({
			chatId,
			branchId,
			model: options?.model ?? SYSTEM_RESOURCE_ID.unresolvedModel,
			excludeMessageIds: options?.excludeMessageIds,
			contextBudget: null,
		});
	}

	private async getAllCharacterEntries(): Promise<Array<{ id: string; name: string; subtitle: string }>> {
		const characters = await this.stores.characters.listIncludingSystem();
		const hasUserChars = characters.some((c) => c.id !== 'char_system');

		if (!hasUserChars) {
			return characters.map((c) => ({
				id: c.id,
				name: c.name,
				subtitle: c.tags.length > 0 ? c.tags[0] : '',
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
