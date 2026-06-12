import type { AiAssistantStreamChunk } from "../ai-assistant/reasoning-split.js";
import type { AiAssistantStreamRequest } from "../ai-assistant/ai-assistant-stream.js";

// ─── Bootstrap / Debug ───────────────────────────────────────────────

export interface BootstrapRuntimeApi {
	bootstrap: () => Promise<unknown>;
}

// ─── Chat ────────────────────────────────────────────────────────────

export interface ChatRuntimeApi {
	getChatSnapshot: (chatId: string) => Promise<unknown>;
	createChatForCharacter: (characterId: string) => Promise<unknown>;
	createFreeChat: () => Promise<unknown>;
	cloneChat: (chatId: string) => Promise<unknown>;
	deleteChat: (chatId: string) => void;
	clearChat: (chatId: string) => Promise<unknown>;
	renameChat: (chatId: string, title: string) => unknown;
	setGreetingIndex: (chatId: string, greetingIndex: number) => unknown;
	updateChatSettings: (chatId: string, body: { title: string; subtitle: string; scenario: string; systemPrompt: string }) => unknown;
	setChatPersona: (chatId: string, personaId: string) => Promise<unknown>;
	setChatPromptPreset: (chatId: string, promptPresetId: string) => Promise<unknown>;

	// Branches
	branchChat: (chatId: string, messageId: string) => unknown;
	forkBranch: (chatId: string, fromMessageId?: string) => unknown;
	activateBranch: (chatId: string, branchId: string) => unknown;
	deleteBranch: (chatId: string, branchId: string) => unknown;
	renameBranch: (chatId: string, branchId: string, label: string) => unknown;

	// Messages
	sendMessage: (chatId: string, body: { content: string }, signal?: AbortSignal) => Promise<unknown>;
	sendMessageStream: (chatId: string, body: { content: string }, signal?: AbortSignal) => AsyncIterable<{ event: string; data: string }>;
	regenerateMessage: (chatId: string, messageId: string, body: unknown, signal?: AbortSignal) => Promise<unknown>;
	regenerateMessageStream: (chatId: string, messageId: string, body: unknown, signal?: AbortSignal) => AsyncIterable<{ event: string; data: string }>;
	generateReply: (chatId: string, signal?: AbortSignal) => Promise<unknown>;
	generateReplyStream: (chatId: string, signal?: AbortSignal) => AsyncIterable<{ event: string; data: string }>;
	selectVariant: (chatId: string, messageId: string, variantIndex: number) => unknown;
	deleteVariant: (chatId: string, messageId: string, variantIndex: number) => unknown;
	editMessage: (chatId: string, messageId: string, content: string) => unknown;
	deleteMessage: (chatId: string, messageId: string) => unknown;
	updateAttachmentDescription: (chatId: string, messageId: string, attachmentId: string, description: string) => Promise<{ ok: boolean }>;

	// Export
	exportChatJsonl: (chatId: string) => Promise<string>;
	exportPromptTrace: (traceId: string) => Promise<unknown>;

	// Summaries & Memory
	listChatSummaries: (chatId: string) => Promise<unknown>;
	createChatSummary: (chatId: string, body: { label?: string; content?: string; summarizedFrom: number; summarizedTo: number; includeInContext?: boolean; excludeSummarized?: boolean; source?: "manual" | "auto"; sortOrder?: number }) => Promise<unknown>;
	updateChatSummaryRecord: (chatId: string, summaryId: string, body: { label?: string; content?: string; summarizedFrom?: number; summarizedTo?: number; includeInContext?: boolean; excludeSummarized?: boolean; sortOrder?: number }) => Promise<unknown>;
	deleteChatSummaryRecord: (chatId: string, summaryId: string) => Promise<unknown>;
	generateChatSummary: (chatId: string, body: { providerProfileId: string; model?: string; summarizedFrom: number; summarizedTo: number; targetSummaryId?: string; label?: string; includeInContext?: boolean; excludeSummarized?: boolean }, signal?: AbortSignal) => Promise<unknown>;
	updateMemorySettings: (chatId: string, body: { messageHistoryLimit?: number; autoSummaryConfig?: { enabled?: boolean; everyN?: number; useChatModel?: boolean; providerProfileId?: string; model?: string } }) => Promise<unknown>;
	summarizeChat: (chatId: string, body: { providerProfileId: string; model?: string; maxMessages: number }, signal?: AbortSignal) => Promise<unknown>;
	saveChatSummary: (chatId: string, body: { summary: string }) => Promise<unknown>;
}

// ─── Character ───────────────────────────────────────────────────────

export interface CharacterRuntimeApi {
	createCharacterFromScratch: (body: {
		name: string;
		description?: string;
		firstMessage?: string;
		scenario?: string;
		personalitySummary?: string;
		mesExample?: string;
		mesExampleMode?: string;
		mesExampleDepth?: number;
		alternateGreetings?: string[];
		postHistoryInstructions?: string;
		creatorNotes?: string;
		systemPrompt?: string;
		depthPrompt?: string;
		depthPromptDepth?: number;
		depthPromptRole?: string;
		tags?: string[];
	}) => Promise<unknown>;
	updateCharacter: (characterId: string, body: Record<string, unknown>) => Promise<unknown>;
	archiveCharacter: (characterId: string) => Promise<unknown>;
	unarchiveCharacter: (characterId: string) => Promise<unknown>;
	deleteCharacter: (characterId: string) => Promise<void>;
	exportCharacter: (characterId: string) => Promise<unknown>;
	duplicateCharacter: (characterId: string) => Promise<unknown>;
}

// ─── Persona ─────────────────────────────────────────────────────────

export interface PersonaRuntimeApi {
	listPersonas: () => Promise<unknown>;
	createPersona: (body: { name: string; description: string; pronouns?: string | null; defaultForNewChats?: boolean }) => Promise<unknown>;
	updatePersona: (personaId: string, body: Record<string, unknown>) => unknown;
	deletePersona: (personaId: string) => Promise<void>;
	duplicatePersona: (personaId: string) => Promise<unknown>;
	setDefaultPersona: (personaId: string) => Promise<void>;
	getPersonalLorebookStatus: (personaId: string) => unknown;
	setPersonalLorebookEnabled: (personaId: string, enabled: boolean) => unknown;
}

// ─── Lorebook ────────────────────────────────────────────────────────

export interface LorebookRuntimeApi {
	listAllLorebooks: () => Promise<unknown>;
	listLorebooks: (scopeType: string, ownerId?: string) => Promise<unknown>;
	createLorebook: (body: { name: string; description?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string; scanDepth?: number; tokenBudget?: number; recursiveScanning?: boolean }) => Promise<unknown>;
	updateLorebookMeta: (lorebookId: string, body: { name?: string; description?: string; scanDepth?: number; tokenBudget?: number; recursiveScanning?: boolean; enabled?: boolean; scopeType?: string }) => Promise<unknown>;
	deleteLorebook: (lorebookId: string) => Promise<void>;
	duplicateLorebook: (lorebookId: string, overrides?: { name?: string; scopeType?: string; characterId?: string | null; personaId?: string | null }) => Promise<unknown>;
	exportLorebook: (lorebookId: string) => Promise<unknown>;
	getLorebookLinks: (lorebookId: string) => Promise<unknown>;
	setLorebookLinks: (lorebookId: string, links: Array<{ targetType: string; targetId: string }>) => Promise<unknown>;
	importLorebook: (lorebookId: string | null, body: { format: string; data: unknown; mode: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string; fallbackName?: string }) => Promise<unknown>;

	// Entries
	createLoreEntry: (lorebookId: string, body: Record<string, unknown>) => Promise<unknown>;
	updateLoreEntry: (lorebookId: string, entryId: string, body: Record<string, unknown>) => Promise<unknown>;
	deleteLoreEntry: (lorebookId: string, entryId: string) => Promise<void>;
	listLoreEntries: (lorebookId: string) => Promise<unknown>;
	reorderLoreEntries: (lorebookId: string, updates: Array<{ id: string; sortOrder: number; position?: string }>) => Promise<unknown>;
	testLoreActivation: (lorebookId: string, body: { text: string }) => Promise<unknown>;
}

// ─── Script ──────────────────────────────────────────────────────────

export interface ScriptRuntimeApi {
	listScripts: (scopeType: string, ownerId?: string) => Promise<unknown>;
	getScript: (scriptId: string) => Promise<unknown>;
	createScript: (body: { name: string; description?: string; code?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string; enabled?: boolean; sortOrder?: number }) => Promise<unknown>;
	updateScript: (scriptId: string, body: { name?: string; description?: string; code?: string; enabled?: boolean; sortOrder?: number }) => Promise<unknown>;
	deleteScript: (scriptId: string) => Promise<void>;
	testScript: (scriptId: string, body: { messages?: Array<{ role: string; content: string }>; characterName?: string; characterPersonality?: string; characterScenario?: string; lastMessage?: string }) => Promise<unknown>;
	importScript: (body: { format: "js" | "json"; code?: string; jsonText?: string; name?: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string }) => Promise<unknown>;
}

// ─── Provider ────────────────────────────────────────────────────────

export interface ProviderRuntimeApi {
	listProviderProfiles: () => unknown;
	fetchProviderProfile: (providerProfileId: string) => unknown;
	activateProviderProfile: (providerProfileId: string) => unknown;
	updateProviderProfile: (providerProfileId: string, body: Record<string, unknown>) => unknown;
	saveProviderDraft: (body: Record<string, unknown>) => unknown;
	deleteProviderProfile: (providerProfileId: string) => void;
	testProviderDraft: (body: { endpoint?: string; apiKey?: string; providerType?: string } | null) => Promise<unknown>;
	testProviderProfile: (providerProfileId: string) => Promise<unknown>;
	fetchProviderModels: (providerProfileId: string) => Promise<{ models: unknown }>;
	listFavoriteProviderModels: (providerProfileId: string) => unknown;
	addFavoriteProviderModel: (providerProfileId: string, body: { modelId: string; label?: string | null; contextLength?: number | null }) => unknown;
	removeFavoriteProviderModel: (providerProfileId: string, modelId: string) => unknown;
	fetchModelsByEndpoint: (baseUrl: string, apiKey?: string, providerType?: string) => Promise<unknown>;
	testProviderChatByEndpoint: (opts: { baseUrl: string; apiKey: string; model: string; providerType?: string }) => Promise<unknown>;
	testProviderChatByProfile: (providerProfileId: string, model: string) => Promise<unknown>;
}

// ─── Preset ──────────────────────────────────────────────────────────

export interface PresetRuntimeApi {
	listPromptPresets: () => unknown;
	createPromptPreset: (body: Record<string, unknown> & { name: string }) => unknown;
	updatePromptPreset: (presetId: string, body: Record<string, unknown>) => unknown;
	deletePromptPreset: (presetId: string) => void;
}

// ─── Import/Export ───────────────────────────────────────────────────

export interface ImportExportRuntimeApi {
	importJson: (body: { fileName: string; jsonText: string; chatId?: string }) => unknown;
	scanSillyTavernDirectory: (dirPath: string) => Promise<unknown>;
	importSillyTavernDirectory: (dirPath: string) => Promise<unknown>;
}

// ─── Asset ───────────────────────────────────────────────────────────

export interface AssetRuntimeApi {
	uploadAsset: (file: File) => Promise<{ assetId: string; url: string }>;
	serveAsset: (assetId: string) => Promise<Response | null>;
}

// ─── AI Assistant ────────────────────────────────────────────────────

export interface AiAssistantRuntimeApi {
	streamAiAssistant: (body: AiAssistantStreamRequest) => AsyncIterable<AiAssistantStreamChunk>;
	countAiAssistantTokens: (body: AiAssistantStreamRequest) => Promise<{ tokens: number; model: string; layerCount: number; messageCount: number }>;
}

// ─── Settings ────────────────────────────────────────────────────────

export interface SettingsRuntimeApi {
	getUiSettings: () => Promise<unknown>;
	updateUiSettings: (body: Record<string, unknown>) => Promise<unknown>;
}

// ─── Mobile Access ───────────────────────────────────────────────────

export interface MobileAccessRuntimeApi {
	getMobileAccessInfo: () => Promise<unknown>;
	regenerateMobileAccessToken: () => Promise<{ token: string }>;
	revokeMobileAccess: () => Promise<{ token: null }>;
}

// ─── Composite ───────────────────────────────────────────────────────

/**
 * Aggregate contract between Hono routes and the backend service layer.
 * Each sub-interface is consumed by exactly one route file.
 */
export interface RuntimeApi {
	bootstrap: BootstrapRuntimeApi["bootstrap"];
	chat: ChatRuntimeApi;
	character: CharacterRuntimeApi;
	persona: PersonaRuntimeApi;
	lorebook: LorebookRuntimeApi;
	script: ScriptRuntimeApi;
	provider: ProviderRuntimeApi;
	preset: PresetRuntimeApi;
	importExport: ImportExportRuntimeApi;
	asset: AssetRuntimeApi;
	aiAssistant: AiAssistantRuntimeApi;
	settings: SettingsRuntimeApi;
	mobileAccess: MobileAccessRuntimeApi;
}
