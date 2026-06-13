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
import { ChatApplicationService } from "../chat/chat-application-service.js";
import {
	internal,
	notFound,
	validation,
} from "../errors.js";
import { PromptAssemblyService } from "../prompt/prompt-assembly-service.js";
import { StaticPromptResolver } from "../prompt/prompt-resolver.js";
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
// lorebookModule removed — CRUD is wired directly through stores in RuntimeApiAdapter
import { scanSillyTavernDirectory as scanST, importSillyTavernDirectory as importST } from "../st-directory-scanner.js";

export interface ChatListItem {
	id: ChatId;
	title: string;
	characterId: CharacterId;
	characterName: string;
	subtitle: string;
	activeBranchLabel: string;
	messageCount: number;
	updatedAt: string;
}

export interface SessionSnapshot {
	/** Sidebar: ordered list of chats with metadata. Absent when endpoint returns partial data. */
	chats: ChatListItem[];
	/** All known characters (sidebar, build mode). Absent when endpoint returns partial data. */
	allCharacters: Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null; avatarFullAssetId: string | null; avatarCropJson: string | null }>;
	/** Active chat metadata (title, settings, greetingIndex, etc). */
	activeChat: import("@vibe-tavern/db").Chat;
	/** Currently active branch. */
	activeBranch: import("@vibe-tavern/db").ChatBranch;
	/** All branches for the active chat. */
	branches: import("@vibe-tavern/db").ChatBranch[];
	/** Messages for the active branch, with variant data. */
	messages: import("./session-runtime-dto.js").MessageDto[];
	/** Ranged summaries for the active branch. */
	summaries: Array<{
		id: string;
		kind: string;
		summary: string;
	}>;
	/** Latest prompt trace for the active branch (null if no traces). */
	promptTrace: PromptTraceRecordDto | null;
	/** Last N prompt traces for the active branch. */
	promptTraceHistory: PromptTraceRecordDto[];
	/** Live context preview (null when traces exist — known bug, see Phase 3.1). */
	contextPreview: import("@vibe-tavern/domain").AssemblePromptResponse | null;
	/** Active character record. */
	character: CharacterRecord;
	/** Active persona record (null if no persona set). */
	persona: PersonaRecord | null;
}

export interface BootstrapState {
	initialChatId: ChatId | null;
	snapshot: SessionSnapshot | null;
	isFirstRun: boolean;
	allCharacters: Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null; avatarFullAssetId: string | null; avatarCropJson: string | null }>;
	promptPresets: PromptPresetDto[];
	uiSettings: UiSettings;
	isArmServer: boolean;
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
		 * This will be replaced by per-endpoint response builders (Phase 3.4,
		 * CODE_REVIEW_REFACTOR_PLAN.md). For now, every mutation returns the
		 * full snapshot, which is correct but wasteful: renaming a chat
		 * re-computes contextPreview and re-reads every character.
		 *
		 * Known behaviour: `contextPreview` is nulled when any prompt trace
		 * exists (the trace "shadows" the live preview). This is intentional
		 * for the current UI but couples two unrelated concepts.
		 */
		const { chat, branch, messages: branchMessages } = await this.chatApp.getChatState(chatId);
		const branches = await this.stores.chats.getBranches(chat.id);
		const branchMsgCounts = await this.stores.chats.getBranchMessageCounts(chat.id);
		const branchesWithCounts = branches.map((b) => ({ ...b, messageCount: branchMsgCounts.get(b.id) ?? 0 }));
		const character = await this.resolver.getCharacter(chat.characterId);
		const persona = await this.resolver.getPersona(
			chat.personaId ?? await this.persona.resolveDefaultId(),
		);
		const promptTraceHistory = await this.getPromptTraceHistory(
			chat.id as ChatId,
			branch.id as ChatBranchId,
		);

		const branchSummaries = await this.stores.chatSummaries.listByChatBranch(chat.id, branch.id);
		const variantsByMessage = await this.stores.chats.getVariantsByBranch(branch.id);
		const messagesWithVariants = branchMessages.map((message) =>
			mapMessageDto(message, variantsByMessage.get(message.id) ?? []),
		);

		return {
			chats: await Promise.all(this.chatOrder.items.map((id) => this.mapChatToListItem(id))),
			allCharacters: await this.getAllCharacterEntries(),
			activeChat: chat,
			activeBranch: branch,
			branches: branchesWithCounts,
			messages: messagesWithVariants,
			summaries: branchSummaries.map((summary) => ({
				id: summary.id,
				kind: summary.source,
				summary: summary.content,
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
			customInjections: (() => { try { return JSON.parse(preset.customInjectionsJson); } catch { return []; } })(),
			promptOrder: (() => { try { return JSON.parse(preset.promptOrderJson); } catch { return []; } })(),
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

	private async getAllCharacterEntries(): Promise<Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null; avatarFullAssetId: string | null; avatarCropJson: string | null }>> {
		const characters = await this.stores.characters.listAll();
		return characters.map((c) => ({
			id: c.id,
			name: c.name,
			subtitle: c.tags.length > 0 ? c.tags[0] : '',
			avatarAssetId: c.avatarAssetId,
			avatarFullAssetId: c.avatarFullAssetId,
			avatarCropJson: c.avatarCropJson,
		}));
	}

	async setGreetingIndex(chatId: ChatId, greetingIndex: number): Promise<SessionSnapshot> {
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
		return this.getSnapshot(chatId);
	}
}
