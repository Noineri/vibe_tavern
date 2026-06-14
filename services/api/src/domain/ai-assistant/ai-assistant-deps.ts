import type { StoreContainer } from "@vibe-tavern/db";
import { logSendDebug } from "../../send-debug-log.js";
import { resolveModel } from "../../ai/provider-executor-utils.js";

/**
 * Builds the dependency object expected by streamAiAssistant / countAiAssistantTokens.
 * Keeps AI-assistant concerns out of the adapter layer.
 */
export function createAiAssistantDeps(stores: StoreContainer) {
	return {
		resolveModel,
		getProviderProfile: (id: string) => stores.providers.getById(id),
		getPresetPromptData: async () => {
			const settings = await stores.uiSettings.get();
			if (!settings?.activePromptPresetId) {
				return { aiAssistantPrompts: null, scriptAiSystemPrompt: null };
			}
			const preset = await stores.presets.getById(settings.activePromptPresetId);
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
		},
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
			const allMessages = await stores.chats.getMessages(chat.activeBranchId);
			const sliced = allMessages.slice(-count);
			return sliced.map((m) => ({ id: m.id, role: m.role, content: m.content }));
		},
	};
}
