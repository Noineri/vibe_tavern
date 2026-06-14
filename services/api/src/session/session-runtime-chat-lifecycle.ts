import type { StoreContainer } from "@vibe-tavern/db";
import {
	brandId,
	type CharacterId,
	type ChatBranchId,
	type ChatId,
	type PersonaId,
	type PromptPresetId,
	SYSTEM_RESOURCE_ID,
} from "@vibe-tavern/domain";
import { notFound } from "../errors.js";
import type { ChatApplicationService } from "../domain/chat/chat-application-service.js";
import type { IChatOrder } from "./session-runtime-chat-order.js";
import type { PersonaRuntime } from "../domain/persona/persona-runtime.js";
import type { SessionSnapshot } from "./session-runtime.js";

function buildGreetingVariants(firstMessage: string | null | undefined, alternateGreetings: string[] = []): string[] {
	// Preserve the imported/card ordering exactly: first_mes is variant 0 when
	// present, alternate_greetings follow in file order. If a card has no
	// first_mes but does define alternates, still seed those as usable greetings.
	return firstMessage?.trim() ? [firstMessage, ...alternateGreetings] : alternateGreetings;
}

export interface ChatLifecycleRuntimeDeps {
	stores: StoreContainer;
	chatApp: ChatApplicationService;
	chatOrder: IChatOrder;
	persona: PersonaRuntime;
	resolveDefaultPromptPresetId: () => Promise<PromptPresetId>;
	getSnapshot: (chatId: ChatId) => Promise<SessionSnapshot>;
	seedImportedOpening: (chatId: ChatId, firstMessage: string, alternateGreetings?: string[]) => Promise<void>;
	assemblePrompt: (
		chatId: ChatId,
		branchId?: ChatBranchId,
		options?: {
			excludeMessageIds?: import("@vibe-tavern/domain").MessageId[];
			model?: string;
			recentMessageLimit?: number;
			mode?: "chat" | "continue" | "regenerate" | "summary" | "tool_call";
			contextBudget?: number | null;
			responseReserve?: number;
		},
	) => Promise<{
		branchId: ChatBranchId;
		prompt: import("@vibe-tavern/domain").AssemblePromptResponse;
		promptTraceDraft: Omit<import("@vibe-tavern/domain").PromptTrace, "id" | "messageId" | "createdAt">;
	}>;
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

	async createChatForCharacter(characterId: string): Promise<SessionSnapshot> {
		const typedCharacterId = brandId<CharacterId>(characterId);
		const character = await this.deps.stores.characters.getById(typedCharacterId);
		if (!character) {
			throw notFound("Character", `Character '${characterId}' was not found.`);
		}

		const created = await this.deps.chatApp.createChat({
			characterId: typedCharacterId,
			personaId: await this.deps.persona.resolveDefaultId(),
			title: `${character.name} chat`,
			promptPresetId: await this.deps.resolveDefaultPromptPresetId(),
		});

		const createdChatId = created.id;
		this.deps.chatOrder.add(createdChatId);

		const greetingVariants = buildGreetingVariants(character.firstMessage, character.alternateGreetings);
		if (greetingVariants.length > 0) {
			const chat = await this.deps.stores.chats.getById(createdChatId);
			if (chat) {
				await this.deps.stores.chats.addMessage({
					chatId: createdChatId,
					branchId: chat.activeBranchId,
					role: "assistant",
					authorType: "assistant",
					content: greetingVariants[0],
					variants: greetingVariants,
				});
			}
		}

		return this.deps.getSnapshot(createdChatId);
	}

	/**
	 * Clear a chat: delete it and create a fresh one for the same character
	 * with the first greeting message. Returns the new session snapshot.
	 */
	async clearChat(chatId: ChatId): Promise<SessionSnapshot> {
		const oldChat = await this.deps.stores.chats.getById(chatId);
		if (!oldChat) throw notFound("Chat", `Chat '${chatId}' not found.`);

		const characterId = oldChat.characterId as CharacterId;
		const character = await this.deps.stores.characters.getById(characterId);
		if (!character) throw notFound("Character", `Character '${characterId}' not found.`);

		// Create fresh chat
		const created = await this.deps.chatApp.createChat({
			characterId,
			personaId: oldChat.personaId as PersonaId ?? await this.deps.persona.resolveDefaultId(),
			title: oldChat.title ?? `${character.name} chat`,
			promptPresetId: (oldChat.promptPresetId ?? await this.deps.resolveDefaultPromptPresetId()) as PromptPresetId,
		});

		this.deps.chatOrder.add(created.id);

		// Add greeting message
		const greetingVariants = buildGreetingVariants(character.firstMessage, character.alternateGreetings);
		if (greetingVariants.length > 0) {
			const chat = await this.deps.stores.chats.getById(created.id);
			if (chat) {
				await this.deps.stores.chats.addMessage({
					chatId: created.id,
					branchId: chat.activeBranchId,
					role: "assistant",
					authorType: "assistant",
					content: greetingVariants[0],
					variants: greetingVariants,
				});
			}
		}

		// Switch to new chat, then delete old (cascade deletes messages/summaries/memory)
		this.deps.chatOrder.remove(chatId);
		await this.deps.stores.chats.delete(chatId);

		return this.deps.getSnapshot(created.id);
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
			mode: "summary",
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
		const messages = await this.deps.stores.chats.getMessages(branchId);
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
			mode: "summary",
		});
	}

	async updateChatSummary(chatId: ChatId, summary: string): Promise<SessionSnapshot> {
		await this.deps.stores.chats.updateSummary(chatId, summary);
		return this.deps.getSnapshot(chatId);
	}

	async switchChat(chatId: ChatId): Promise<SessionSnapshot> {
		// Chat order is managed server-side (updatedAt DESC).
		// No touch/move-to-front on selection — prevents chat list jumping.
		return this.deps.getSnapshot(chatId);
	}

	async setChatPromptPreset(chatId: ChatId, promptPresetId: string): Promise<SessionSnapshot> {
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
		return this.deps.getSnapshot(chatId);
	}

	/**
	 * Seeds an imported character's opening as a chat-local assistant message.
	 * The card's first_mes and alternate_greetings are copied into message
	 * variants so chat edits/swipes do not mutate the character card.
	 */
	async seedImportedOpening(chatId: ChatId, firstMessage: string, alternateGreetings: string[] = []): Promise<void> {
		const greetingVariants = buildGreetingVariants(firstMessage, alternateGreetings);
		if (greetingVariants.length === 0) {
			return;
		}

		const chat = (await this.deps.stores.chats.getById(chatId))!;
		const assembled = await this.deps.assemblePrompt(chatId, chat.activeBranchId as ChatBranchId);
		const message = await this.deps.stores.chats.addMessage({
			chatId,
			branchId: chat.activeBranchId,
			role: "assistant",
			authorType: "assistant",
			content: greetingVariants[0],
			variants: greetingVariants,
		});
		await this.deps.stores.chats.saveTrace({
			...assembled.promptTraceDraft,
			messageId: message.id,
		});
	}
}
