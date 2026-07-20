import type { StoreContainer } from "@vibe-tavern/db";
import {
	brandId,
	type CharacterId,
	type ChatBranchId,
	type ChatId,
	type ChatMode,
	type PersonaId,
	type PromptPresetId,
	SYSTEM_RESOURCE_ID,
} from "@vibe-tavern/domain";
import { notFound, validation } from "../../shared/errors.js";
import type { ChatApplicationService } from "../../domain/chat/chat-application-service.js";
import type { BuiltPipelineContext, PromptTraceDraft } from "../../domain/prompt/prompt-assembly-service.js";
import type { IChatOrder } from "./session-runtime-chat-order.js";
import type { PersonaRuntime } from "../../domain/persona/persona-runtime.js";
import type {
	SessionSnapshot,
	ChatSwitchResponse,
	ChatCreateResponse,
	ConfigPatchResponse,
} from "./session-runtime.js";

function buildGreetingVariants(firstMessage: string | null | undefined, alternateGreetings: string[] = []): string[] {
	// Preserve the imported/card ordering exactly: first_mes is variant 0 when
	// present, alternate_greetings follow in file order. If a card has no
	// first_mes but does define alternates, still seed those as usable greetings.
	return firstMessage?.trim() ? [firstMessage, ...alternateGreetings] : alternateGreetings;
}

/** Default chat title — mode-aware so a co-author chat reads distinctly from
 *  an RP chat of the same character in the sidebar/rail (avoids the visual
 *  collision that a bare `${name}` would cause next to `${name} chat`). */
function defaultChatTitle(characterName: string, mode: ChatMode | undefined): string {
	return mode === "coauthor" ? `Co-Author · ${characterName}` : `${characterName} chat`;
}

export interface ChatLifecycleRuntimeDeps {
	stores: StoreContainer;
	chatApp: ChatApplicationService;
	chatOrder: IChatOrder;
	persona: PersonaRuntime;
	resolveDefaultPromptPresetId: () => Promise<PromptPresetId>;
	getSnapshot: (chatId: ChatId) => Promise<SessionSnapshot>;
	/** Narrowed config-patch response: set-preset / chat.summary-write (CFR Wave B1.5). */
	buildConfigPatchResponse: (
		chatId: ChatId,
		opts?: { persona?: boolean; character?: boolean; activeChat?: boolean },
	) => Promise<ConfigPatchResponse>;
	/** Narrowed chat-switch response: switch / clone (full reload of the active chat's view). */
	buildChatSwitchResponse: (
		chatId: ChatId,
		opts?: { persona?: boolean; chats?: boolean },
	) => Promise<ChatSwitchResponse>;
	/** Narrowed chat-create response: create / clear (new chat appears in the sidebar). */
	buildChatCreateResponse: (chatId: ChatId) => Promise<ChatCreateResponse>;
	seedImportedOpening: (chatId: ChatId, firstMessage: string, alternateGreetings?: string[]) => Promise<void>;
	assemblePrompt: (
		chatId: ChatId,
		branchId?: ChatBranchId,
		options?: {
			excludeMessageIds?: import("@vibe-tavern/domain").MessageId[];
			model?: string;
			recentMessageLimit?: number;
			summary?: boolean;
			contextBudget?: number | null;
			responseReserve?: number;
		},
	) => Promise<{
		branchId: ChatBranchId;
		prompt: import("@vibe-tavern/domain").AssemblePromptResponse;
		promptTraceDraft: PromptTraceDraft;
	}>;
	/** Build the raw RP world context (pre-assembly) for an insight one-shot
	 *  (objective check/generate, scene generate). Mirrors assemblePrompt but
	 *  returns the context instead of assembling it — insight assemblers reuse
	 *  buildLayers on it. */
	buildPipelineContext: (
		chatId: ChatId,
		branchId?: ChatBranchId,
		options?: {
			model?: string;
			recentMessageLimit?: number;
			contextBudget?: number | null;
			responseReserve?: number;
			throughMessageId?: import("@vibe-tavern/domain").MessageId;
			excludeMessageIds?: import("@vibe-tavern/domain").MessageId[];
		},
	) => Promise<BuiltPipelineContext>;
}

/**
 * Manages the lifecycle of chats: creation, switching, preset binding,
 * summary prompt assembly, and seeding opening messages from imported cards.
 */
export class ChatLifecycleRuntime {
	private readonly deps: ChatLifecycleRuntimeDeps;

	constructor(deps: ChatLifecycleRuntimeDeps) {
		this.deps = deps;
	}

	async createChatForCharacter(characterId: string, mode?: ChatMode): Promise<ChatCreateResponse> {
		const typedCharacterId = brandId<CharacterId>(characterId);
		const character = await this.deps.stores.characters.getById(typedCharacterId);
		if (!character) {
			throw notFound("Character", `Character '${characterId}' was not found.`);
		}

		const created = await this.deps.chatApp.createChat({
			characterId: typedCharacterId,
			personaId: await this.deps.persona.resolveDefaultId(),
			title: defaultChatTitle(character.name, mode),
			promptPresetId: await this.deps.resolveDefaultPromptPresetId(),
			mode,
		});

		const createdChatId = created.id;
		this.deps.chatOrder.add(createdChatId);

		// Seed the opening turn, branching on mode: co-author chats open with
		// the active module's framing message (default module on a fresh chat
		// since coauthorModuleId is null); RP/play/build seed the card greeting.
		const chat = await this.deps.stores.chats.getById(createdChatId);
		if (chat) {
			if (mode === "coauthor") {
				await this.seedCoauthorOpening(createdChatId, chat.activeBranchId, chat.coauthorModuleId);
			} else {
				const greetingVariants = buildGreetingVariants(character.firstMessage, character.alternateGreetings);
				if (greetingVariants.length > 0) {
					await this.deps.stores.messages.addMessage({
						chatId: createdChatId,
						branchId: chat.activeBranchId,
						role: "assistant",
						authorType: "assistant",
						content: greetingVariants[0],
						variants: greetingVariants,
					});
				}
			}
		}

		return this.deps.buildChatCreateResponse(createdChatId);
	}

	/**
	 * Seed a co-author chat's opening turn: the active module's `openingMessage`
	 * as a real persisted assistant message. `{{char}}`/`{{user}}` stay literal
	 * (CS-26: the co-author surface edits a template and never resolves macros
	 * to a name). An empty `openingMessage` seeds nothing — the chat starts blank,
	 * which is fine for an editor surface. The module resolves seed-first; a
	 * null/unknown id falls back to the bundled default.
	 */
	private async seedCoauthorOpening(
		chatId: ChatId,
		branchId: string,
		moduleId: string | null,
	): Promise<void> {
		const { getCoauthorModule, isSeedModule } = await import("../../domain/coauthor/modules/module-registry.js");
		const userModules = moduleId && !isSeedModule(moduleId)
			? await this.deps.stores.coauthorModules.list()
			: [];
		const mod = await getCoauthorModule(moduleId, userModules);
		const opening = mod.openingMessage.trim();
		if (!opening) return;
		await this.deps.stores.messages.addMessage({
			chatId,
			branchId,
			role: "assistant",
			authorType: "assistant",
			content: opening,
			variants: [opening],
		});
	}

	/**
	 * Clear a chat: delete it and create a fresh one for the same character
	 * with the first greeting message. Returns the create-scoped response
	 * (new chat appears in the sidebar, fresh view state for the new chat).
	 */
	async clearChat(chatId: ChatId): Promise<ChatCreateResponse> {
		const oldChat = await this.deps.stores.chats.getById(chatId);
		if (!oldChat) throw notFound("Chat", `Chat '${chatId}' not found.`);

		const characterId = oldChat.characterId as CharacterId;
		const character = await this.deps.stores.characters.getById(characterId);
		if (!character) throw notFound("Character", `Character '${characterId}' not found.`);

		// Create fresh chat
		const created = await this.deps.chatApp.createChat({
			characterId,
			personaId: oldChat.personaId as PersonaId ?? await this.deps.persona.resolveDefaultId(),
			title: oldChat.title ?? defaultChatTitle(character.name, oldChat.mode),
			promptPresetId: (oldChat.promptPresetId ?? await this.deps.resolveDefaultPromptPresetId()) as PromptPresetId,
			mode: oldChat.mode,
		});

		this.deps.chatOrder.add(created.id);

		// Preserve a non-default co-author module across clear: a fresh chat row
		// defaults to null (= default module), so only a custom selection needs
		// restoring before the opening-message seed reads it back.
		if (oldChat.mode === "coauthor" && oldChat.coauthorModuleId) {
			await this.deps.stores.chats.setCoauthorModuleId(created.id, oldChat.coauthorModuleId);
		}

		// Seed the opening turn, branching on mode (mirrors createChatForCharacter):
		// co-author → module openingMessage; RP → card greeting.
		const chat = await this.deps.stores.chats.getById(created.id);
		if (chat) {
			if (oldChat.mode === "coauthor") {
				await this.seedCoauthorOpening(created.id, chat.activeBranchId, chat.coauthorModuleId);
			} else {
				const greetingVariants = buildGreetingVariants(character.firstMessage, character.alternateGreetings);
				if (greetingVariants.length > 0) {
					await this.deps.stores.messages.addMessage({
						chatId: created.id,
						branchId: chat.activeBranchId,
						role: "assistant",
						authorType: "assistant",
						content: greetingVariants[0],
						variants: greetingVariants,
					});
				}
			}
		}

		// Switch to new chat, then delete old (cascade deletes messages/summaries/memory)
		this.deps.chatOrder.remove(chatId);
		await this.deps.stores.chats.delete(chatId);

		return this.deps.buildChatCreateResponse(created.id);
	}

	async assembleSummaryPrompt(input: {
		chatId: ChatId;
		model: string;
		recentMessageLimit: number;
		contextBudget?: number | null;
	}) {
		const chat = await this.deps.stores.chats.getById(input.chatId);
		if (!chat) {
			throw notFound("Chat", `Chat '${input.chatId}' was not found.`);
		}
		return this.deps.assemblePrompt(input.chatId, chat.activeBranchId as ChatBranchId, {
			model: input.model,
			recentMessageLimit: input.recentMessageLimit,
			contextBudget: input.contextBudget ?? null,
			summary: true,
		});
	}

	async assembleRangedSummaryPrompt(input: {
		chatId: ChatId;
		model: string;
		summarizedFrom: number;
		summarizedTo: number;
		contextBudget?: number | null;
	}) {
		const chat = await this.deps.stores.chats.getById(input.chatId);
		if (!chat) {
			throw notFound("Chat", `Chat '${input.chatId}' was not found.`);
		}
		const branchId = chat.activeBranchId as ChatBranchId;
		const messages = await this.deps.stores.messages.getMessages(branchId);
		const from = Math.max(1, Math.floor(input.summarizedFrom));
		const to = Math.max(from, Math.floor(input.summarizedTo));
		const excludeMessageIds = messages
			.filter((message) => {
				const oneBasedPosition = message.position + 1;
				return oneBasedPosition < from || oneBasedPosition > to;
			})
			.map((message) => brandId<import("@vibe-tavern/domain").MessageId>(message.id));
		return this.deps.assemblePrompt(input.chatId, branchId, {
			model: input.model,
			recentMessageLimit: messages.length,
			excludeMessageIds,
			contextBudget: input.contextBudget ?? null,
			summary: true,
		});
	}

	/**
	 * Build the raw RP world context for an insight one-shot (objective
	 * check/generate, scene generate) WITHOUT assembling it — the insight
	 * assemblers reuse buildLayers on this context. Mirrors assembleSummaryPrompt
	 * but returns the pre-assembly context instead of the assembled prompt.
	 * Background callers pass the committed event branch explicitly; interactive
	 * callers may omit it to retain the active-branch fallback.
	 */
	async buildPipelineContext(input: {
		chatId: ChatId;
		branchId?: ChatBranchId;
		model: string;
		recentMessageLimit?: number;
		contextBudget?: number | null;
		responseReserve?: number;
		throughMessageId?: import("@vibe-tavern/domain").MessageId;
		excludeMessageIds?: import("@vibe-tavern/domain").MessageId[];
	}): Promise<BuiltPipelineContext> {
		const chat = await this.deps.stores.chats.getById(input.chatId);
		if (!chat) {
			throw notFound("Chat", `Chat '${input.chatId}' was not found.`);
		}
		return this.deps.buildPipelineContext(
			input.chatId,
			input.branchId ?? (chat.activeBranchId as ChatBranchId),
			{
				model: input.model,
				recentMessageLimit: input.recentMessageLimit,
				contextBudget: input.contextBudget ?? null,
				responseReserve: input.responseReserve,
				...(input.throughMessageId ? { throughMessageId: input.throughMessageId } : {}),
				...(input.excludeMessageIds ? { excludeMessageIds: input.excludeMessageIds } : {}),
			},
		);
	}

	async updateChatSummary(chatId: ChatId, summary: string): Promise<ConfigPatchResponse> {
		await this.deps.stores.chats.updateSummary(chatId, summary);
		// chat.summary is a field on the chat row — return activeChat so the
		// UI (AppShell currentSummary) refreshes, plus contextPreview since
		// the summary text is injected into the prompt.
		return this.deps.buildConfigPatchResponse(chatId, { activeChat: true });
	}

	async switchChat(chatId: ChatId): Promise<ChatSwitchResponse> {
		// Chat order is managed server-side (updatedAt DESC).
		// No touch/move-to-front on selection — prevents chat list jumping.
		// persona is included so the switched-to chat's persona loads with the
		// view (the sidebar chat list is NOT re-sent here — it lives in the
		// store from bootstrap; switch explicitly does no move-to-front).
		return this.deps.buildChatSwitchResponse(chatId, { persona: true });
	}

	async setChatPromptPreset(chatId: ChatId, promptPresetId: string): Promise<ConfigPatchResponse> {
		const [chat, preset] = await Promise.all([
			this.deps.stores.chats.getById(chatId),
			this.deps.stores.presets.getById(promptPresetId),
		]);
		if (!chat) {
			throw notFound("Chat", `Chat '${chatId}' was not found.`);
		}
		if (!preset) {
			throw notFound("PromptPreset", `Prompt preset '${promptPresetId}' was not found.`);
		}
		await this.deps.stores.chats.setPromptPreset(chatId, promptPresetId);
		// activeChat MUST be returned: promptPresetId lives on the chat row and
		// is read from activeChat by TopBar (activeChat.promptPresetId) to show
		// the currently-selected preset in BOTH the topbar quick-switcher and
		// the preset modal. The preset BODY is re-read from the preset store,
		// but the ID round-trips through activeChat.
		return this.deps.buildConfigPatchResponse(chatId, { activeChat: true });
	}

	async setCoauthorModule(chatId: ChatId, moduleId: string | null): Promise<ConfigPatchResponse> {
		const chat = await this.deps.stores.chats.getById(chatId);
		if (!chat) {
			throw notFound("Chat", `Chat '${chatId}' was not found.`);
		}
		if (chat.mode !== "coauthor") {
			throw validation("Only coauthor chats can have a coauthor module.");
		}
		if (moduleId) {
			// Validate the module id exists among seed (built-in) OR user modules.
			// Seed ids resolve without a DB read; user ids need the store.
			const { getCoauthorModules, isSeedModule } = await import("../../domain/coauthor/modules/module-registry.js");
			const userModules = isSeedModule(moduleId) ? [] : await this.deps.stores.coauthorModules.list();
			const moduleExists = (await getCoauthorModules(userModules)).some((m) => m.id === moduleId);
			if (!moduleExists) {
				throw notFound("CoauthorModule", `Module '${moduleId}' was not found.`);
			}
		}
		await this.deps.stores.chats.setCoauthorModuleId(chatId, moduleId);
		return this.deps.buildConfigPatchResponse(chatId, { activeChat: true });
	}

	/**
	 * Seeds an imported character's opening as a chat-local assistant message.
	 * The card's first_mes and alternate_greetings are copied into message
	 * variants so chat edits/swipes do not mutate the character card.
	 */
	async seedImportedOpening(
		chatId: ChatId,
		firstMessage: string,
		alternateGreetings: string[] = [],
		opts?: { withTrace?: boolean },
	): Promise<void> {
		const greetingVariants = buildGreetingVariants(firstMessage, alternateGreetings);
		if (greetingVariants.length === 0) {
			return;
		}

		const chat = (await this.deps.stores.chats.getById(chatId))!;
		// Prompt assembly is O(N) in (lorebook entries × message text × keys) and is
		// only needed to seed the trace. Mass-import doesn't need a trace (the
		// user hasn't opened the chat yet; the trace is rebuilt on first real
		// turn), so callers can pass withTrace:false to skip the whole pipeline.
		// This is the difference between a 68s and a 0.1s import for one card
		// when a heavy global lorebook is active.
		const withTrace = opts?.withTrace ?? true;
		const message = await this.deps.stores.messages.addMessage({
			chatId,
			branchId: chat.activeBranchId,
			role: "assistant",
			authorType: "assistant",
			content: greetingVariants[0],
			variants: greetingVariants,
		});
		if (withTrace) {
			const assembled = await this.deps.assemblePrompt(chatId, chat.activeBranchId as ChatBranchId);
			await this.deps.stores.traces.saveTrace({
				...assembled.promptTraceDraft,
				messageId: message.id,
			});
		}
	}
}
