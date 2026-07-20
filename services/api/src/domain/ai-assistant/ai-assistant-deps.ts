import type { StoreContainer } from "@vibe-tavern/db";
import {
	brandId,
	resolveEffectiveSettings,
	type ChatBranchId,
	type ChatId,
	type MessageId,
} from "@vibe-tavern/domain";
import type { SessionRuntime } from "../../runtime/session/session-runtime.js";
import { notFound } from "../../shared/errors.js";
import { logSendDebug } from "../../shared/send-debug-log.js";
import { resolveModel } from "../../infrastructure/ai/provider-executor-utils.js";

/**
 * Builds the dependency object expected by streamAiAssistant / countAiAssistantTokens.
 * Keeps AI-assistant concerns out of the adapter layer.
 */
export function createAiAssistantDeps(stores: StoreContainer, sessionRuntime: SessionRuntime) {
	const getPresetPromptData = async (chatId?: string) => {
		const [settings, chat] = await Promise.all([
			stores.uiSettings.get(),
			chatId ? stores.chats.getById(chatId) : Promise.resolve(null),
		]);
		const presetId = chat?.promptPresetId ?? settings.activePromptPresetId;
		if (!presetId) {
			return { aiAssistantPrompts: null, scriptAiSystemPrompt: null };
		}
		const preset = await stores.presets.getById(presetId);
		if (!preset) {
			return { aiAssistantPrompts: null, scriptAiSystemPrompt: null };
		}
		let aiAssistantPrompts: Record<string, string> | null = null;
		try {
			const parsed = JSON.parse(preset.aiAssistantPrompts || "{}");
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				aiAssistantPrompts = Object.fromEntries(
					Object.entries(parsed).filter(([, value]) => typeof value === "string"),
				) as Record<string, string>;
			}
		} catch (err) {
			logSendDebug("api.ai-assistant.prompt-map-parse-error", { error: String(err), presetId: preset.id });
		}
		return {
			aiAssistantPrompts,
			scriptAiSystemPrompt: preset.scriptAiSystemPrompt ?? null,
		};
	};

	return {
		resolveModel,
		getProviderProfile: (id: string) => stores.providers.getById(id),
		getEffectiveProviderProfile: async (id: string, model: string) => {
			const profile = await stores.providers.getById(id);
			if (!profile) {
				throw notFound("ProviderProfile", `Provider profile '${id}' was not found.`);
			}
			if (!profile.bindPerModel) return profile;
			const overlay = await stores.providers.getModelSettings(id, model);
			return resolveEffectiveSettings(profile, overlay?.settings ?? null);
		},
		getPresetPromptData,
		getCharacterById: async (id: string) => {
			const character = await stores.characters.getById(id);
			if (!character) return null;
			return {
				id: character.id,
				name: character.name,
				description: character.description,
				personality: character.personalitySummary ?? "",
				scenario: character.defaultScenario ?? "",
			};
		},
		getPersonaById: async (id: string) => {
			const persona = await stores.personas.getById(id);
			if (!persona) return null;
			return {
				id: persona.id,
				name: persona.name,
				description: persona.description,
				pronouns: persona.pronouns ?? undefined,
				pronounForms: persona.pronounForms ?? null,
			};
		},
		getLoreEntryById: async (id: string) => {
			const entry = await stores.lorebooks.getEntry(id);
			if (!entry || !entry.enabled) return null;
			return {
				id: entry.id,
				title: entry.title,
				content: entry.content,
			};
		},
		getLoreEntriesByLorebookId: async (id: string) => {
			const lorebook = await stores.lorebooks.getLorebook(id);
			if (!lorebook?.enabled) return [];
			const entries = await stores.lorebooks.listEntries(id);
			return entries
				.filter((entry) => entry.enabled)
				.map((entry) => ({
					id: entry.id,
					title: entry.title,
					content: entry.content,
				}));
		},
		logDebug: logSendDebug,
		getChatMessages: async (chatId: string, count: number) => {
			const chat = await stores.chats.getById(chatId);
			if (!chat) return [];
			const allMessages = await stores.messages.getMessages(chat.activeBranchId);
			const sliced = allMessages.slice(-count);
			return sliced.map((message) => ({ id: message.id, role: message.role, content: message.content }));
		},
		getMessageEditorChat: (chatId: string) => stores.chats.getById(chatId),
		getMessageEditorMessages: (branchId: string) => stores.messages.getMessages(branchId),
		getMessageEditorVariantsByBranch: (branchId: string) => stores.messages.getVariantsByBranch(branchId),
		getPromptPresetName: async (presetId: string) => (await stores.presets.getById(presetId))?.name ?? null,
		buildMessageEditorPipelineContext: (input: {
			chatId: string;
			branchId: string;
			model: string;
			contextBudget: number | null;
			responseReserve: number;
			throughMessageId: string;
			excludeMessageIds: string[];
		}) => sessionRuntime.chatLifecycle.buildPipelineContext({
			chatId: brandId<ChatId>(input.chatId),
			branchId: brandId<ChatBranchId>(input.branchId),
			model: input.model,
			contextBudget: input.contextBudget,
			responseReserve: input.responseReserve,
			throughMessageId: brandId<MessageId>(input.throughMessageId),
			excludeMessageIds: input.excludeMessageIds.map((id) => brandId<MessageId>(id)),
		}),
	};
}
