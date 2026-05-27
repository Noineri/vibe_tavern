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
import { notFound } from "./errors.js";
import type { ChatApplicationService } from "./chat-application-service.js";
import type { IChatOrder } from "./session-runtime-chat-order.js";
import type { PersonaRuntime } from "./session-runtime-persona.js";
import type { SessionSnapshot } from "./session-runtime.js";

export interface ChatLifecycleRuntimeDeps {
	stores: StoreContainer;
	chatApp: ChatApplicationService;
	chatOrder: IChatOrder;
	persona: PersonaRuntime;
	resolveDefaultPromptPresetId: () => Promise<PromptPresetId>;
	getSnapshot: (chatId: ChatId) => Promise<SessionSnapshot>;
	seedImportedOpening: (chatId: ChatId, firstMessage: string) => Promise<void>;
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

		const greeting = character.firstMessage;
		if (greeting) {
			const chat = await this.deps.stores.chats.getById(createdChatId);
			if (chat) {
				await this.deps.stores.chats.addMessage({
					chatId: createdChatId,
					branchId: chat.activeBranchId,
					role: "assistant",
					authorType: "assistant",
					content: greeting,
				});
			}
		}

		return this.deps.getSnapshot(createdChatId);
	}

	async createFreeChat(): Promise<SessionSnapshot> {
		const systemChar = await this.deps.stores.characters.getSystemCharacter();

		const created = await this.deps.chatApp.createChat({
			characterId: systemChar.id as CharacterId,
			personaId: await this.deps.persona.resolveDefaultId(),
			title: "Free chat",
			promptPresetId: await this.deps.resolveDefaultPromptPresetId(),
		});

		const freeChatId = created.id;
		this.deps.chatOrder.add(freeChatId);
		return this.deps.getSnapshot(freeChatId);
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

	async updateChatSummary(chatId: ChatId, summary: string): Promise<SessionSnapshot> {
		await this.deps.stores.chats.updateSummary(chatId, summary);
		return this.deps.getSnapshot(chatId);
	}

	async switchChat(chatId: ChatId): Promise<SessionSnapshot> {
		await this.deps.stores.chats.touchLastAccessed(chatId);
		this.deps.chatOrder.moveToFront(chatId);
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
	 * Seeds an imported character's first message as an assistant message
	 * and records a prompt trace for it.
	 */
	async seedImportedOpening(chatId: ChatId, firstMessage: string): Promise<void> {
		const trimmed = firstMessage.trim();
		if (!trimmed) {
			return;
		}

		const chat = (await this.deps.stores.chats.getById(chatId))!;
		const assembled = await this.deps.assemblePrompt(chatId, chat.activeBranchId as ChatBranchId);
		const message = await this.deps.stores.chats.addMessage({
			chatId,
			branchId: chat.activeBranchId,
			role: "assistant",
			authorType: "assistant",
			content: trimmed,
		});
		await this.deps.stores.chats.saveTrace({
			...assembled.promptTraceDraft,
			messageId: message.id,
		});
	}
}
