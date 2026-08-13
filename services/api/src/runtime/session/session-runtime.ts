import { parseProfileMd, type PromptPreset, type StoreContainer, type UiSettings, type DiceRoll } from "@vibe-tavern/db";
import type { PromptPresetDto, PromptTraceRecordDto } from "@vibe-tavern/domain";
import {
	type CharacterId,
	type ChatBranchId,
	type ChatId,
	type MessageId,
	type PromptPresetId,
	type StoredProviderProfileRecord,
	SYSTEM_RESOURCE_ID,
	tag,
} from "@vibe-tavern/domain";
import { ChatApplicationService } from "../../domain/chat/chat-application-service.js";
import { getChatModeStrategy, type ChatModeStrategy, type ChatModeAssembleLoaders } from "../../domain/chat/chat-mode-strategy.js";
import {
	internal,
	notFound,
	validation,
} from "../../shared/errors.js";
import type { CoauthorApplyRequest, CoauthorCorrection } from "@vibe-tavern/api-contracts";
import { PromptAssemblyService } from "../../domain/prompt/prompt-assembly-service.js";
import { storeRollToSnapshot } from "../../domain/dice/dice-service.js";
import { StaticPromptResolver } from "../../domain/prompt/prompt-resolver.js";
import { createLoreDelegate } from "../../domain/coauthor/lore/lore-delegate.js";
import { createLoreEntityLookup } from "../../domain/coauthor/lore/lore-entity-lookup.js";
import { findUnsafeMacros } from "../../domain/coauthor/macro-subset.js";
import { createContextSearchSession } from "../../domain/context/context-search-service.js";
import { nonstreamingProviderExecute } from "../../infrastructure/ai/nonstreaming-provider-executor.js";
import {
	mapMessageDto,
	mapPromptTraceRecord,
} from "./session-runtime-dto.js";

export type { PreparedLiveTurn } from "./session-runtime-chat.js";
export type { MessageDto } from "./session-runtime-dto.js";

const logger = tag("session.branch");

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
	BatchImportResult,
	MessageResponse,
	VariantResponse,
	BranchResponse,
	BranchMetaResponse,
	ChatListResponse,
	ChatSwitchResponse,
	ChatCreateResponse,
	ConfigPatchResponse,
	CoauthorApplyResponse,
	SummaryResponse,
} from "../../api/contract/session-types.js";
export type {
	ChatListItem,
	SessionSnapshot,
	BootstrapState,
	ImportResult,
	BatchImportResult,
	MessageResponse,
	VariantResponse,
	BranchResponse,
	BranchMetaResponse,
	ChatListResponse,
	ChatSwitchResponse,
	ChatCreateResponse,
	ConfigPatchResponse,
	CoauthorApplyResponse,
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
import type { ImportStreamEvent } from "../../shared/st-directory-scanner.js";

/**
 * Pick the chat the app boots into. Prefers the most-recent NON-coauthor chat
 * so a reload never drops the user into the co-author surface (F-7) — the
 * co-author surface is entered by opening a co-author chat, not by a reload.
 * Falls back to the overall most-recent chat only when no RP chat exists.
 *
 * `orderedIds` is recency-desc (chatOrder.items); `isCoauthor` maps an id to
 * whether it belongs to a co-author chat. Pure — extracted so the F-7 default
 * is unit-testable without spinning a full SessionRuntime.
 */
export function pickBootstrapChatId<T extends string>(
	orderedIds: readonly T[],
	isCoauthor: (id: T) => boolean,
): T | null {
	if (orderedIds.length === 0) return null;
	return orderedIds.find((id) => !isCoauthor(id)) ?? orderedIds[0] ?? null;
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
	private readonly getSkillCatalog: () => Promise<import("../../domain/coauthor/skills/skill-scanner.js").SkillCatalogEntry[]>;

	readonly chatRuntime: ChatRuntime;
	readonly persona: PersonaRuntime;
	readonly character: CharacterRuntime;
	readonly chatLifecycle: ChatLifecycleRuntime;

	constructor(
		stores: StoreContainer,
		options?: {
			getActiveProviderProfile?: () => Promise<StoredProviderProfileRecord | null>;
			dataDir?: string;
			getSkillCatalog?: () => Promise<import("../../domain/coauthor/skills/skill-scanner.js").SkillCatalogEntry[]>;
		},
	) {
		this.stores = stores;
		this.resolver = new StaticPromptResolver(stores);
		this.chatApp = new ChatApplicationService(stores.chats, stores.messages, stores.diceRolls);
		this.promptService = new PromptAssemblyService(stores, this.resolver, this.stores.content.fileStore);
		this.getActiveProviderProfile =
			options?.getActiveProviderProfile ?? (async () => null);
		this.getSkillCatalog =
			options?.getSkillCatalog ?? (async () => []);
		this.chatOrder = new ChatOrderService(stores.chats);
		this.chatRuntime = new ChatRuntime({
			chats: stores.chats,
			messages: stores.messages,
			traces: stores.traces,
			chatApp: this.chatApp,
			diceRolls: stores.diceRolls,
			uiSettings: stores.uiSettings,
			assemblePrompt: (chatId, branchId, opts) =>
				this.assemblePrompt(chatId, branchId, opts),
			getSnapshot: (chatId) => this.getSnapshot(chatId),
			buildMessageResponse: (chatId, opts) => this.buildMessageResponse(chatId, opts),
			buildVariantResponse: (chatId, opts) => this.buildVariantResponse(chatId, opts),
			buildBranchResponse: (chatId) => this.buildBranchResponse(chatId),
			buildBranchMetaResponse: (chatId) => this.buildBranchMetaResponse(chatId),
			buildChatListResponse: () => this.buildChatListResponse(),
			chatOrder: this.chatOrder,
		});
		this.chatOrder.seed();
		this.persona = new PersonaRuntime({
			stores,
			chatOrder: this.chatOrder,
			getSnapshot: (chatId) => this.getSnapshot(chatId),
			buildConfigPatchResponse: (chatId, opts) => this.buildConfigPatchResponse(chatId, opts),
		});
		this.chatLifecycle = new ChatLifecycleRuntime({
			stores,
			chatApp: this.chatApp,
			chatOrder: this.chatOrder,
			persona: this.persona,
			resolveDefaultPromptPresetId: () => this.ensureDefaultPresetId(),
			getSnapshot: (chatId) => this.getSnapshot(chatId),
			buildChatSwitchResponse: (chatId, opts) => this.buildChatSwitchResponse(chatId, opts),
			buildChatCreateResponse: (chatId) => this.buildChatCreateResponse(chatId),
			buildConfigPatchResponse: (chatId, opts) => this.buildConfigPatchResponse(chatId, opts),
			seedImportedOpening: (chatId, firstMessage, alternateGreetings) =>
				this.chatLifecycle.seedImportedOpening(chatId, firstMessage, alternateGreetings),
			assemblePrompt: (chatId, branchId, opts) =>
				this.assemblePrompt(chatId, branchId, opts),
			buildPipelineContext: (chatId, branchId, opts) =>
				this.promptService.buildPipelineContext({
					chatId,
					...(branchId ? { branchId } : {}),
					model: opts?.model ?? "",
					...(opts?.recentMessageLimit !== undefined ? { recentMessageLimit: opts.recentMessageLimit } : {}),
					contextBudget: opts?.contextBudget ?? null,
					responseReserve: opts?.responseReserve,
					...(opts?.throughMessageId ? { throughMessageId: opts.throughMessageId } : {}),
					...(opts?.excludeMessageIds ? { excludeMessageIds: opts.excludeMessageIds } : {}),
				}),
		});
		this.character = new CharacterRuntime({
			stores,
			chatApp: this.chatApp,
			chatOrder: this.chatOrder,
			getSnapshot: (chatId) => this.getSnapshot(chatId),
			buildConfigPatchResponse: (chatId, opts) => this.buildConfigPatchResponse(chatId, opts),
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
		const [userChars, allChats, promptPresets, uiSettings] = await Promise.all([
			this.stores.characters.listAll(),
			this.stores.chats.listAll(),
			this.stores.presets.listAll(),
			this.stores.uiSettings.get(),
		]);
		// Boot into the most-recent NON-coauthor chat so a reload never drops the
		// user into the co-author surface (F-7). Falls back to the overall
		// most-recent chat only when no RP chat exists at all.
		const coauthorIds = new Set(allChats.filter((c) => c.mode === 'coauthor').map((c) => c.id));
		const initialChatId = pickBootstrapChatId(this.chatOrder.items, (id) => coauthorIds.has(id));
		const isArmServer = process.arch.startsWith('arm') && process.platform !== 'darwin';
		return {
			initialChatId,
			snapshot: initialChatId ? await this.getSnapshot(initialChatId) : null,
			isFirstRun: allChats.length === 0 && userChars.length === 0,
			allCharacters: userChars.map((c) => ({
				id: c.id,
				name: c.name,
				subtitle: c.tags.length > 0 ? c.tags[0] : '',
				tags: c.tags,
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
		 * Monolithic snapshot — returns EVERY field on every call, EXCEPT the
		 * live context preview, which is now a standalone branch-scoped query
		 * (`getContextPreview` / POST .../context-preview) hydrated lazily by
		 * the frontend. The latest `promptTrace` still rides the snapshot as
		 * the cheap fallback for context counters and the Trace panel.
		 */
		const { chat, branch, messages: branchMessages } = await this.chatApp.getChatState(chatId);
		// Only the single latest trace is embedded now (for the post-generation
		// badge); the full history is lazy-loaded via GET /api/chats/:chatId/traces.
		const latestTraces = await this.getPromptTraceHistory(
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
			promptTrace: latestTraces[0] ?? null,
			character,
			persona,
		};
	}
	/** Branch-scoped live context preview (lazy hydration target).
	 *
	 *  Validates `branchId` belongs to `chatId` explicitly: {@link getChatState}
	 *  silently falls back to the root branch when given a foreign branchId, so
	 *  without this check a wrong-branch request would assemble the root's
	 *  preview instead of surfacing a 404. The ownership check therefore runs
	 *  OUTSIDE the try/catch so a NotFound propagates to the route; the catch
	 *  only masks assembly failures (returning null) as before. */
	async getContextPreview(chatId: ChatId, branchId: ChatBranchId): Promise<import("@vibe-tavern/domain").AssemblePromptResponse | null> {
		const branches = await this.stores.chats.getBranches(chatId);
		if (!branches.some((b) => b.id === branchId)) {
			throw notFound("Branch", `Branch '${branchId}' was not found for chat '${chatId}'.`);
		}
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
	// affected region. None of them embed `contextPreview` — the live preview
	// is a standalone branch-scoped lazy query (see `getContextPreview`), so
	// navigation and mutations never block on prompt assembly. See the
	// field-ownership table in `CHAT_FRONTEND_REFACTOR_PLAN.md` (Wave B1).
	//
	// B1.1: ADDITIVE ONLY — the builder methods + shared fetch primitives landed
	// here, behavior-pinned by `session-runtime-builders.test.ts`.
	// B1.2: message + variant paths WIRED — appendAssistantReply, appendMessageVariant,
	// select/deleteMessageVariant, editMessage, deleteMessage, setGreetingIndex now
	// return these narrowed shapes (not getSnapshot).
	// B1.3: branch path WIRED — forkBranch, activateBranch, deleteBranch return
	// BranchResponse; renameBranch returns BranchMetaResponse. Remaining paths
	// (navigation / config+summary) still serve `getSnapshot` until B1.4–B1.5.

	/** Message-path mutations: send, regenerate, edit, delete, create-variant. */
	async buildMessageResponse(
		chatId: ChatId,
		opts?: { summaries?: boolean },
	): Promise<MessageResponse> {
		const { branch, messages } = await this.chatApp.getChatState(chatId);
		const branchId = branch.id as ChatBranchId;
		const [messagesWithVariants, latestTrace] = await Promise.all([
			this.buildMessagesWithVariants(messages, branchId),
			// Latest single trace only — the full history is lazy-loaded (TRACE_LAZY_LOADING).
			this.getPromptTraceHistory(chatId, branchId, 1),
		]);
		const response: MessageResponse = {
			messages: messagesWithVariants,
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
		};
		if (opts?.activeChat) {
			response.activeChat = chat;
		}
		return response;
	}

	/** Branch-mutating ops: fork, activate, delete-branch (conversation text moves). */
	async buildBranchResponse(chatId: ChatId): Promise<BranchResponse> {
		const startedAt = performance.now();
		const { branch, messages } = await this.chatApp.getChatState(chatId);
		const branchId = branch.id as ChatBranchId;
		const timings: Record<string, number> = {};
		const measure = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
			const started = performance.now();
			try {
				return await operation();
			} finally {
				timings[name] = Math.round(performance.now() - started);
			}
		};

		// `chats` (sidebar list) is included because fork / activate change the
		// chat's active branch, and each ChatListItem.messageCount is the active
		// branch's count — the sidebar number must refresh on every branch switch.
		const [messagesWithVariants, branches, summaries, chats] = await Promise.all([
			measure("messages", () => this.buildMessagesWithVariants(messages, branchId)),
			measure("branches", () => this.fetchBranchesWithCounts(chatId)),
			measure("summaries", () => this.fetchSummaries(chatId, branchId)),
			measure("chats", () => this.fetchChatList()),
		]);
		logger.info("response chat=%s branch=%s messages=%d totalMs=%d timings=%o", chatId, branchId, messages.length, Math.round(performance.now() - startedAt), timings);
		return {
			messages: messagesWithVariants,
			activeBranch: branch,
			branches,
			summaries,
			chats,
		};
	}

	/** Branch-metadata-only op: rename-branch (text unchanged). */
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
		const [messagesWithVariants, branches, summaries, character] = await Promise.all([
			this.buildMessagesWithVariants(messages, branchId),
			this.fetchBranchesWithCounts(chatId),
			this.fetchSummaries(chatId, branchId),
			this.resolver.getCharacter(chat.characterId),
		]);
		const response: ChatSwitchResponse = {
			messages: messagesWithVariants,
			activeChat: chat,
			activeBranch: branch,
			branches,
			summaries,
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
		const [messagesWithVariants, branches, summaries, character, chats] =
			await Promise.all([
				this.buildMessagesWithVariants(messages, branchId),
				this.fetchBranchesWithCounts(chatId),
				this.fetchSummaries(chatId, branchId),
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
			character,
		};
	}

	/** Config-patch ops: set-persona, set-preset, character-patch, memory-settings.
	 *  No longer embeds `contextPreview` (lazy branch-scoped query); returns only
	 *  whichever of persona/character/activeChat the caller touched. */
	async buildConfigPatchResponse(
		chatId: ChatId,
		opts?: { persona?: boolean; character?: boolean; activeChat?: boolean },
	): Promise<ConfigPatchResponse> {
		const { chat } = await this.chatApp.getChatState(chatId);
		const response: ConfigPatchResponse = {};
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
		// Batch-load bound Dice rolls for user messages in ONE query (the B7 batch
		// read already used by prompt assembly). Assistant messages never carry
		// Dice; user messages without bound rolls get nothing (field absent).
		const userMessageIds = messages.filter((m) => m.role === "user").map((m) => m.id);
		const [variantsByMessage, diceRollsByMessage] = await Promise.all([
			this.stores.messages.getVariantsByBranch(branchId),
			userMessageIds.length > 0
				? this.stores.diceRolls.getRollsForMessages(userMessageIds)
				: Promise.resolve(new Map<string, DiceRoll[]>()),
		]);
		return messages.map((message) => {
			if (message.role !== "user") {
				return mapMessageDto(message, variantsByMessage.get(message.id) ?? []);
			}
			const rolls = diceRollsByMessage.get(message.id);
			return mapMessageDto(
				message,
				variantsByMessage.get(message.id) ?? [],
				rolls && rolls.length > 0 ? rolls.map(storeRollToSnapshot) : undefined,
			);
		});
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
		const traces = await this.stores.traces.getTracesByChat(chatId, branchId);
		return traces.slice(0, limit).map(mapPromptTraceRecord);
	}

	async listPromptTraces(
		chatId: ChatId,
		opts?: { messageId?: string; branchId?: string },
	): Promise<PromptTraceRecordDto[]> {
		// Server-side filtering only — the route's query params flow straight to
		// the store so the frontend never receives traces outside its scope.
		const traces = await this.stores.traces.getTracesByChat(
			chatId,
			opts?.branchId,
			opts?.messageId,
		);
		return traces.map(mapPromptTraceRecord);
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
			seedImportedOpening: (chatId, firstMessage, alternateGreetings, opts) =>
				this.chatLifecycle.seedImportedOpening(chatId, firstMessage, alternateGreetings, opts),
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

	async importJson(input: { fileName: string; jsonText?: string; monolithText?: string; chatId?: string; skipExisting?: boolean; lean?: boolean }): Promise<ImportResult> {
		return importExportModule.importJson(this.importExportDeps, input);
	}

	async importJsonBatch(input: { items: Array<{ fileName: string; jsonText?: string; monolithText?: string; chatId?: string; skipExisting?: boolean }>; lean?: boolean }): Promise<BatchImportResult> {
		return importExportModule.importJsonBatch(this.importExportDeps, input);
	}

	scanSillyTavernDirectory(dirPath: string) {
		return scanST(dirPath);
	}

	importSillyTavernDirectory(dirPath: string) {
		return importST(this.importExportDeps, dirPath);
	}

	/** Streaming import — bridges the scanner's onProgress callback into an
	 *  async generator the SSE route can consume. Events are buffered into a
	 *  queue (unbounded; each is ~50 bytes, max ~10k over a 1300-card import —
	 *  negligible) so the scanner is never blocked waiting for the wire. The
	 *  scanner is the bottleneck (DB + file I/O), so the queue drains roughly
	 *  as fast as it fills and the bar advances in real time. */
	async *importSillyTavernDirectoryStream(dirPath: string): AsyncGenerator<ImportStreamEvent> {
		const queue: ImportStreamEvent[] = [];
		let resolveDrain: (() => void) | null = null;
		let settled = false;
		const wake = () => {
			resolveDrain?.();
			resolveDrain = null;
		};

		// Detached: the scanner reports progress via onProgress (pushed to the
		// queue), then pushes a terminal done/error event and marks settled.
		void importST(this.importExportDeps, dirPath, {
			onProgress: (event) => {
				queue.push(event);
				wake();
			},
		}).then(
			(result) => { queue.push({ type: "done", result }); wake(); },
			(err) => {
				queue.push({ type: "error", message: err instanceof Error ? err.message : String(err) });
				wake();
			},
		).finally(() => { settled = true; wake(); });

		while (true) {
			while (queue.length > 0) {
				const event = queue.shift()!;
				yield event;
				if (event.type === "done" || event.type === "error") return;
			}
			if (settled) return;
			await new Promise<void>((r) => { resolveDrain = r; });
		}
	}

	// ─── Private: prompt wiring ─────────────────────────────────────────

	/**
	 * Resolve the {@link ChatModeStrategy} for a chat from its `mode` column.
	 * Centralized so both prompt assembly and the live-chat orchestrator resolve
	 * per-chat — the extensibility seam: adding a mode never touches the callers,
	 * only the strategy registry.
	 *
	 * Loads the chat row to read `mode`; the loaded chat is NOT reused for
	 * assembly (RP's `assembleForChat` loads it again for the preset cascade).
	 * That double PK lookup is intentional: pre-loading the chat into the
	 * assembly input would force a rewrite of `assembleForChat`, which the plan
	 * forbids until a second mode actually duplicates the loader (rule of three).
	 */
	async resolveChatModeStrategy(chatId: ChatId): Promise<ChatModeStrategy> {
		const chat = await this.stores.chats.getById(chatId);
		if (!chat) {
			throw new Error(`Chat '${chatId}' was not found.`);
		}
		return getChatModeStrategy(chat.mode);
	}

	/**
	 * List a character's co-author chats for the Co-Author mode entry screen.
	 * Reuses mapChatToListItem so items carry the same shape (lastMessageAt,
	 * messageCount, …) the sidebar uses. Several co-author chats per character
	 * fall out for free: each is a chats row with mode='coauthor'.
	 */
	async listCoauthorChats(characterId: CharacterId): Promise<ChatListItem[]> {
		const chats = await this.stores.chats.listByCharacterAndMode(characterId, "coauthor");
		return Promise.all(chats.map((c) => this.mapChatToListItem(c.id as ChatId)));
	}

	/**
	 * Apply a co-author turn's aggregated proposed state to the underlying
	 * character card (CA-7). Does NOT touch chat messages — it parses the
	 * proposed `profile.md` into the canonical character fields and persists
	 * them via the normal character-update dual-write, then returns a
	 * config-patch snapshot.
	 *
	 * R3 (data-loss guard): an empty `name` is restored from the current card
	 * rather than throwing — the omission is surfaced to the user via a
	 * `correction` so it is not silently masked. Section/greeting emptiness is
	 * intentional-or-loss and is handled upstream (tool guard CA-17) or on the
	 * diff (CA-10), not here.
	 */
	async applyCoauthorDraft(chatId: ChatId, body: CoauthorApplyRequest): Promise<CoauthorApplyResponse> {
		const chat = await this.stores.chats.getById(chatId);
		if (!chat) {
			throw notFound("Chat", `Chat '${chatId}' was not found.`);
		}
		const characterId = chat.characterId as CharacterId;

		const corrections: CoauthorCorrection[] = [];
		const updateInput: Parameters<CharacterRuntime["update"]>[1] = { chatId };

		if (body.profileMd !== undefined) {
			const { profile } = parseProfileMd(body.profileMd);
			const current = await this.stores.characters.getById(characterId);
			// R3: empty name → omit (character.update keeps current) + notify user.
			const proposedName = profile.name.trim();
			if (proposedName) {
				updateInput.name = proposedName;
			} else {
				corrections.push({
					field: "name",
					action: "restored",
					reason: `Model returned an empty name; restored "${current?.name ?? ""}" from the card.`,
				});
			}
			updateInput.tags = profile.tags;
			updateInput.creatorNotes = profile.creatorNotes;
			updateInput.description = profile.description;
			updateInput.scenario = profile.scenario ?? "";
			updateInput.mesExample = profile.mesExample;
			updateInput.mesExampleMode = profile.mesExampleMode;
			updateInput.mesExampleDepth = profile.mesExampleDepth;
			// Lossless frontmatter round-trip: creator / character_version live in
			// `extensions` (not top-level update fields). Merge over current so a
			// model edit to either is honored; omitting would preserve current.
			const baseExtensions = (current?.extensions ?? {}) as Record<string, unknown>;
			updateInput.extensions = {
				...baseExtensions,
				...(profile.creator !== null ? { creator: profile.creator } : {}),
				...(profile.characterVersion !== null ? { character_version: profile.characterVersion } : {}),
			};
		}

		if (body.firstMessage !== undefined) {
			updateInput.firstMessage = body.firstMessage;
		}
		if (body.alternateGreetings !== undefined) {
			updateInput.alternateGreetings = body.alternateGreetings;
		}

		// B5: flag macros the model emitted outside the safe reusable subset
		// (identity + pronouns). The prose is preserved as-is — these are warnings,
		// not silent edits; the user decides whether to keep each token. One
		// correction per (field, distinct macro) so the toast names exactly what
		// to review and where.
		const proseFields: Array<[string, string | string[] | null | undefined]> = [
			["name", updateInput.name],
			["description", updateInput.description],
			["scenario", updateInput.scenario],
			["mesExample", updateInput.mesExample],
			["creatorNotes", updateInput.creatorNotes],
			["firstMessage", updateInput.firstMessage],
			["alternateGreetings", updateInput.alternateGreetings],
		];
		for (const [field, value] of proseFields) {
			if (value === null || value === undefined) continue;
			const texts = Array.isArray(value) ? value : [value];
			const unsafe = new Set<string>();
			for (const text of texts) {
				for (const name of findUnsafeMacros(text)) unsafe.add(name);
			}
			for (const name of unsafe) {
				corrections.push({
					field,
					action: "warned",
					reason: `Model used {{${name}}}, which is outside the reusable macro set ({{user}}, {{char}}, pronouns) and may not resolve as intended; left as-is for review.`,
				});
			}
		}

		const patch = await this.character.update(characterId, updateInput, {
			rebuildChatOrder: () => this.rebuildChatOrder(),
		});

		// CTX-L2 (Wave 4): lore-bundle Apply branch. The accepted cumulative draft
		// is persisted idempotently (preallocated ids upsert the same rows) in one
		// transaction. Character-scoped draft books are written with characterId so
		// the activation engine discovers them. Absent/empty bundle = no-op (the
		// common profile/greeting-only Apply path is unchanged).
		let lore: { lorebookIds: string[]; entryIds: string[] } | undefined;
		if (body.loreBundle && (body.loreBundle.lorebooks.length > 0 || body.loreBundle.entries.length > 0)) {
			lore = await this.stores.lorebooks.applyCoauthorLoreDraft(
				characterId as unknown as string,
				body.loreBundle,
			);
		}

		return { ...patch, corrections, ...(lore ? { lore } : {}) };
	}

	/**
	 * Wiring method: resolves the chat's mode strategy and delegates to
	 * `strategy.assemble(...)`. RP delegates to the existing `assembleForChat`
	 * unchanged; co-author builds its editor prompt (CA-5). The mode is read
	 * per-call from `chat.mode`, so the hardcoded RP-only path is gone.
	 */
	private async assemblePrompt(
		chatId: ChatId,
		branchId?: ChatBranchId,
		options?: { excludeMessageIds?: MessageId[]; model?: string; recentMessageLimit?: number; summary?: boolean; contextBudget?: number | null; responseReserve?: number; presetId?: PromptPresetId; priorSummaries?: Array<{ id: string; label?: string; content: string }> },
	) {
		void await this.getActiveProviderProfile();
		const strategy = await this.resolveChatModeStrategy(chatId);
		const model = options?.model ?? SYSTEM_RESOURCE_ID.unresolvedModel;
		// Construct the lore AI-delegation callback (CTX-L2b) when a provider is
		// configured and a real model is selected. The co-author strategy injects
		// it into buildCoauthorTools so ai_write_lore_entry / ai_generate_lore_keys
		// can fire an isolated one-shot LLM call. Absent (undefined) when no
		// provider/model is available — the tools then throw a clear error if the
		// model still tries to invoke them. The delegate reuses the chat's active
		// provider + model by default; a dedicated smaller model is a future
		// config knob on this seam (createLoreDelegate accepts any profile+model).
		const profile = await this.getActiveProviderProfile();
		const loreDelegate =
			profile && model && model !== SYSTEM_RESOURCE_ID.unresolvedModel
				? createLoreDelegate({ execute: nonstreamingProviderExecute, profile, model })
				: undefined;
		// CE-B1: lore entity lookup lets the edit / re-delegation tools target
		// previously-created (persisted) lore entities across turns, not just
		// ones drafted this turn. Built when a lorebook store is wired (production
		// always wires it); absent in minimal/test contexts — edit tools that need
		// it then throw a clear "no lookup configured" error.
		const loreEntityLookup = this.stores?.lorebooks ? createLoreEntityLookup(this.stores.lorebooks) : undefined;
		// CE-D2: context-search session for indexed entity discovery.
		// Lazily projects all canonical entities into FTS5 on first search.
		const contextSearchSession = this.stores ? this.buildContextSearchSession(chatId) : undefined;
		return strategy.assemble({
			promptService: this.promptService,
			loaders: this.buildChatModeLoaders(),
			loreDelegate,
			loreEntityLookup,
			contextSearchSession,
			chatId,
			branchId,
			model,
			excludeMessageIds: options?.excludeMessageIds,
			recentMessageLimit: options?.recentMessageLimit,
			summary: options?.summary,
			contextBudget: options?.contextBudget ?? null,
			responseReserve: options?.responseReserve,
			presetId: options?.presetId,
			priorSummaries: options?.priorSummaries,
		});
	}

	/**
	 * Raw state access handed to non-RP chat-mode strategies (co-author) so they
	 * can build their own prompt without going through the RP assembly pipeline.
	 * Stateless closures over `this.stores`; RP ignores the handle entirely.
	 */
	private buildChatModeLoaders(): ChatModeAssembleLoaders {
		return {
			getMessages: async (chatId, branchId, limit) => {
				const chat = await this.stores.chats.getById(chatId);
				if (!chat) return [];
				const branch = branchId ?? (chat.activeBranchId as ChatBranchId | null);
				if (!branch) return [];
				const msgs = await this.stores.messages.getMessages(branch);
				return limit && limit > 0 ? msgs.slice(-limit) : msgs;
			},
			getChat: async (chatId) => {
				const chat = await this.stores.chats.getById(chatId);
				if (!chat) throw new Error(`Chat '${chatId}' was not found.`);
				return chat;
			},
			getCharacter: async (chatId) => {
				const chat = await this.stores.chats.getById(chatId);
				if (!chat) throw new Error(`Chat '${chatId}' was not found.`);
				const char = await this.stores.characters.getById(chat.characterId);
				if (!char) throw new Error(`Character '${chat.characterId}' was not found.`);
				return char;
			},
			getProfileMdText: (characterId) => this.stores.characters.getProfileMdText(characterId),
			getCoauthorContextItems: async (chatId) => {
				// CE-C1: resolve the entities the user EXPLICITLY pinned to this chat
				// (right-panel picker → chats.coauthorContextLinks) into read-only
				// reference blocks. Generalizes CA-13 (lorebook-only) to
				// character/persona/lorebook/script. NOT RP keyword activation.
				const chat = await this.stores.chats.getById(chatId);
				if (!chat || chat.coauthorContextLinks.length === 0) return [];
				// The active character is already rendered as `currentCard`; skip a
				// pinned link to it to avoid 2x-token duplication.
				const out: import("../../domain/chat/chat-mode-strategy.js").CoauthorContextItem[] = [];
				for (const link of chat.coauthorContextLinks) {
					if (link.targetType === 'character') {
						if (link.targetId === chat.characterId) continue;
						const c = await this.stores.characters.getById(link.targetId);
						if (!c) continue;
						const profile = await this.stores.characters.getProfileMdText(c.id as unknown as import("@vibe-tavern/domain").CharacterId);
						out.push({ type: 'character', id: c.id, title: c.name, content: profile });
					} else if (link.targetType === 'persona') {
						const p = await this.stores.personas.getById(link.targetId);
						if (!p) continue;
						out.push({ type: 'persona', id: p.id, title: p.name, content: p.description });
					} else if (link.targetType === 'lorebook') {
						const lb = await this.stores.lorebooks.getLorebook(link.targetId);
						if (!lb?.enabled) continue;
						const entries = await this.stores.lorebooks.listEntries(link.targetId);
						for (const e of entries.filter((e) => e.enabled)) {
							out.push({ type: 'lorebook', id: e.id, title: e.title, content: e.content });
						}
					} else {
						// script
						const sc = await this.stores.scripts.getById(link.targetId);
						if (!sc) continue;
						const body = sc.description.trim()
							? `${sc.description.trim()}\n\n\`\`\`js\n${sc.code}\n\`\`\``
							: `\`\`\`js\n${sc.code}\n\`\`\``;
						out.push({ type: 'script', id: sc.id, title: sc.name, content: body });
					}
				}
				// Dedupe by type+id (a book bound twice shouldn't double-inject).
				const seen = new Set<string>();
				return out.filter((it) => {
					const key = `${it.type}:${it.id}`;
					if (seen.has(key)) return false;
					seen.add(key);
					return true;
				});
			},
			getChatSummaries: async (chatId, branchId) => {
				return this.stores.chatSummaries.listByChatBranch(chatId, branchId);
			},
			getCoauthorBoundResources: async (characterId) => {
				// CE-C2/C3: the character's M:N-bound lorebooks + scripts as awareness
				// metadata (name + entry titles / name + description) — NOT full
				// content (Level 1) and NOT RP keyword activation. Mirrors exactly
				// what BoundResourcesField shows the user as 'bound' (links-only via
				// listLorebooksLinkedToTarget / listScriptsLinkedToTarget).
				const [boundLorebooks, boundScripts] = await Promise.all([
					this.stores.lorebooks.listLorebooksLinkedToTarget('character', characterId as string),
					this.stores.scripts.listScriptsLinkedToTarget('character', characterId as string),
				]);
				const lorebookItems = await Promise.all(
					boundLorebooks.map(async (lb) => ({
						id: lb.id,
						name: lb.name,
						// Level-2 metadata only: title + stable id, never content. The id
						// lets CE-B1's cross-turn tools target this persisted entry.
						entries: (await this.stores.lorebooks.listEntries(lb.id))
							.filter((e) => e.enabled)
							.map((e) => ({ id: e.id, title: e.title })),
					})),
				);
				const scriptItems = boundScripts.map((sc) => ({
					id: sc.id,
					name: sc.name,
					// Description is the human-written summary; the CODE stays out.
					summary: sc.description.trim(),
				}));
				return { lorebooks: lorebookItems, scripts: scriptItems };
			},
			getCoauthorUserModules: async () => {
				// CS-24: user-created modules (editable). Seed modules never come from
				// here — the registry loads those from disk. The row carries
				// createdAt/updatedAt which the registry's toUserModule drops.
				return this.stores.coauthorModules.list();
			},
			getSkillCatalog: () => this.getSkillCatalog(),
		};
	}

	/**
	 * Build a lazy per-turn context-search session (CE-D2) for the co-author's
	 * search_context / read_context_item tools. Projects all canonical entities
	 * into FTS5 on the first search; the next turn rebuilds from stores.
	 */
	private buildContextSearchSession(chatId: ChatId): import("../../domain/context/context-search-service.js").ContextSearchSession {
		const stores = this.stores;
		return createContextSearchSession(
			{
				listAllCharacters: () => stores.characters.listAll(),
				listAllPersonas: () => stores.personas.listAll(),
				listAllLorebooks: () => stores.lorebooks.listAllLorebooks(),
				listEntries: (lorebookId: string) => stores.lorebooks.listEntries(lorebookId),
				listAllScripts: () => stores.scripts.listAll(),
				listLorebooksLinkedToTarget: (targetType: "character" | "persona", targetId: string) =>
					stores.lorebooks.listLorebooksLinkedToTarget(targetType, targetId),
				listScriptsLinkedToTarget: (targetType: "character" | "persona", targetId: string) =>
					stores.scripts.listScriptsLinkedToTarget(targetType, targetId),
				getCharacter: (id: string) => stores.characters.getById(id),
				getPersona: (id: string) => stores.personas.getById(id),
				getLorebook: (id: string) => stores.lorebooks.getLorebook(id),
				getEntry: (id: string) => stores.lorebooks.getEntry(id),
				getScript: (id: string) => stores.scripts.getById(id),
				listSkills: async () => {
					// CE-D3: project the skill catalog into the search index's skill channel.
					// getSkillCatalog returns SkillCatalogEntry[] (already user>builtin merged);
					// map to the narrow ContextSearchSkillView the session expects.
					const entries = await this.getSkillCatalog();
					return entries.map((s) => ({
						id: s.id,
						name: s.name,
						description: s.description,
						manifestPath: s.rootRelativeManifestPath,
						source: s.source,
					}));
				},
			},
			async () => {
				const chat = await stores.chats.getById(chatId);
				return {
					activeCharacterId: chat?.characterId ?? null,
					activePersonaId: chat?.personaId ?? null,
				};
			},
		);
	}

	private async ensureDefaultPresetId(): Promise<PromptPresetId> {
		await this.ensureDefaultPresetOnce();
		const presets = await this.stores.presets.listAll();
		const globalPreset =
			presets.find((preset) => preset.isDefault) ?? presets[0];
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
				isDefault: true,
			});
		}
	}

	// ─── Private: DTO helpers ───────────────────────────────────────────

	private mapPresetToDto(preset: PromptPreset): PromptPresetDto {
		return {
			id: preset.id,
			name: preset.name,
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
			mergeConsecutiveRoles: preset.mergeConsecutiveRoles,
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
		} catch { /* chat may reference a since-deleted character; keep default name/subtitle */ }
		const messageCount = chatState.messages.length;
		// Recency signal for the sidebar's "recent" sort: the newest message in the
		// active branch (chat.updatedAt reflects metadata edits, not generation).
		// getMessages() returns position-ascending, but reduce on createdAt is
		// order-robust and empty-safe (→ "" → falls back to chat.updatedAt).
		const lastMessageAt = chatState.messages.reduce<string>(
			(max, m) => (m.createdAt > max ? m.createdAt : max),
			"",
		) || chat.updatedAt;
		return {
			id: chat.id as ChatId,
			title: chat.title,
			characterId: chat.characterId as CharacterId,
			characterName,
			subtitle,
			activeBranchLabel: chatState.branch.label,
			mode: chat.mode,
			messageCount,
			lastMessageAt,
			updatedAt: chat.updatedAt,
		};
	}

	private async getAllCharacterEntries(): Promise<Array<{ id: string; name: string; subtitle: string; tags: string[]; avatarAssetId: string | null; avatarFullAssetId: string | null; avatarCropJson: string | null; avatarExt: string | null; updatedAt: string }>> {
		const characters = await this.stores.characters.listAll();
		return characters.map((c) => ({
			id: c.id,
			name: c.name,
			subtitle: c.tags.length > 0 ? c.tags[0] : '',
			tags: c.tags,
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
			const variants = await this.stores.messages.getVariants(firstAssistant.id);
			if (variants.some((variant) => variant.variantIndex === greetingIndex)) {
				await this.stores.messages.selectVariant(firstAssistant.id, greetingIndex);
			}
		}
		await this.stores.chats.setSelectedGreetingIndex(chatId, 0);
		return this.buildVariantResponse(chatId, { activeChat: true });
	}

	/** CE-C1: replace the co-author chat's pinned Level-1 context entities
	 *  (the right-panel picker). Wholesale replace, then return the fresh chat
	 *  row so the frontend picker reflects the persisted state. No message/variant
	 *  side-effects — this is a chat-row config update, like setChatPersona.
	 *  Generalizes CA-13 (lorebook-id-only) to a typed character/persona/
	 *  lorebook/script link list. */
	async setCoauthorContextLinks(chatId: ChatId, links: import("@vibe-tavern/domain").CoauthorContextLink[]): Promise<VariantResponse> {
		await this.stores.chats.setCoauthorContextLinks(chatId, links);
		return this.buildVariantResponse(chatId, { activeChat: true });
	}
}
