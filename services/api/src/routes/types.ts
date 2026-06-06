import type { AiAssistantStreamChunk } from "../ai-assistant/reasoning-split.js";
import type { AiAssistantStreamRequest } from "../ai-assistant/ai-assistant-stream.js";

export interface RuntimeApi {
  bootstrap: () => Promise<unknown>;
  getChatSnapshot: (chatId: string) => Promise<unknown>;
  createChatForCharacter: (characterId: string) => Promise<unknown>;
  cloneChat: (chatId: string) => Promise<unknown>;
  duplicateCharacter: (characterId: string) => Promise<unknown>;
  duplicatePersona: (personaId: string) => Promise<unknown>;
  exportCharacter: (characterId: string) => Promise<unknown>;
  exportChatJsonl: (chatId: string) => Promise<string>;
  exportPromptTrace: (traceId: string) => Promise<unknown>;
  updateChatSettings: (chatId: string, body: { title: string; subtitle: string; scenario: string; systemPrompt: string }) => unknown;
  branchChat: (chatId: string, messageId: string) => unknown;
  renameBranch: (chatId: string, branchId: string, label: string) => unknown;
  regenerateMessage: (chatId: string, messageId: string, body: unknown, signal?: AbortSignal) => Promise<unknown>;
  regenerateMessageStream: (chatId: string, messageId: string, body: unknown, signal?: AbortSignal) => AsyncIterable<{ event: string; data: string }>;
  selectVariant: (chatId: string, messageId: string, variantIndex: number) => unknown;
  deleteVariant: (chatId: string, messageId: string, variantIndex: number) => unknown;
  editMessage: (chatId: string, messageId: string, content: string) => unknown;
  deleteMessage: (chatId: string, messageId: string) => unknown;
  sendMessage: (chatId: string, body: { content: string }, signal?: AbortSignal) => Promise<unknown>;
  sendMessageStream: (chatId: string, body: { content: string }, signal?: AbortSignal) => AsyncIterable<{ event: string; data: string }>;
  listChatSummaries: (chatId: string) => Promise<unknown>;
  createChatSummary: (chatId: string, body: { label?: string; content?: string; summarizedFrom: number; summarizedTo: number; includeInContext?: boolean; excludeSummarized?: boolean; source?: "manual" | "auto"; sortOrder?: number }) => Promise<unknown>;
  updateChatSummaryRecord: (chatId: string, summaryId: string, body: { label?: string; content?: string; summarizedFrom?: number; summarizedTo?: number; includeInContext?: boolean; excludeSummarized?: boolean; sortOrder?: number }) => Promise<unknown>;
  deleteChatSummaryRecord: (chatId: string, summaryId: string) => Promise<unknown>;
  generateChatSummary: (chatId: string, body: { providerProfileId: string; model?: string; summarizedFrom: number; summarizedTo: number; targetSummaryId?: string; label?: string; includeInContext?: boolean; excludeSummarized?: boolean }, signal?: AbortSignal) => Promise<unknown>;
  updateMemorySettings: (chatId: string, body: { messageHistoryLimit?: number; autoSummaryConfig?: { enabled?: boolean; everyN?: number; useChatModel?: boolean; providerProfileId?: string; model?: string } }) => Promise<unknown>;
  summarizeChat: (chatId: string, body: { providerProfileId: string; model?: string; maxMessages: number }, signal?: AbortSignal) => Promise<unknown>;
  saveChatSummary: (chatId: string, body: { summary: string }) => Promise<unknown>;
  generateReply: (chatId: string, signal?: AbortSignal) => Promise<unknown>;
  generateReplyStream: (chatId: string, signal?: AbortSignal) => AsyncIterable<{ event: string; data: string }>;
  updateCharacter: (characterId: string, body: Record<string, unknown>) => Promise<unknown>;
  updatePersona: (personaId: string, body: Record<string, unknown>) => unknown;
  listPersonas: () => Promise<unknown>;
  setChatPersona: (chatId: string, personaId: string) => Promise<unknown>;
  setChatPromptPreset: (chatId: string, promptPresetId: string) => Promise<unknown>;
  createPersona: (body: { name: string; description: string; pronouns?: string | null; defaultForNewChats?: boolean }) => Promise<unknown>;
  deletePersona: (personaId: string) => Promise<void>;
  getPersonalLorebookStatus: (personaId: string) => unknown;
  setPersonalLorebookEnabled: (personaId: string, enabled: boolean) => unknown;
  listAllLorebooks: () => Promise<unknown>;
  listLorebooks: (scopeType: string, ownerId?: string) => Promise<unknown>;
  createLorebook: (body: { name: string; description?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string; scanDepth?: number; tokenBudget?: number; recursiveScanning?: boolean }) => Promise<unknown>;
  updateLorebookMeta: (lorebookId: string, body: { name?: string; description?: string; scanDepth?: number; tokenBudget?: number; recursiveScanning?: boolean; enabled?: boolean; scopeType?: string }) => Promise<unknown>;
  deleteLorebook: (lorebookId: string) => Promise<void>;
  createLoreEntry: (lorebookId: string, body: Record<string, unknown>) => Promise<unknown>;
  updateLoreEntry: (lorebookId: string, entryId: string, body: Record<string, unknown>) => Promise<unknown>;
  deleteLoreEntry: (lorebookId: string, entryId: string) => Promise<void>;
  listLoreEntries: (lorebookId: string) => Promise<unknown>;
  reorderLoreEntries: (lorebookId: string, updates: Array<{ id: string; sortOrder: number; position?: string }>) => Promise<unknown>;
  testLoreActivation: (lorebookId: string, body: { text: string }) => Promise<unknown>;
  importLorebook: (lorebookId: string | null, body: { format: string; data: unknown; mode: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string; fallbackName?: string }) => Promise<unknown>;
  getLorebookLinks: (lorebookId: string) => Promise<unknown>;
  setLorebookLinks: (lorebookId: string, links: Array<{ targetType: string; targetId: string }>) => Promise<unknown>;
  duplicateLorebook: (lorebookId: string, overrides?: { name?: string; scopeType?: string; characterId?: string | null; personaId?: string | null }) => Promise<unknown>;
  exportLorebook: (lorebookId: string) => Promise<unknown>;
  // ── Scripts ──
  listScripts: (scopeType: string, ownerId?: string) => Promise<unknown>;
  getScript: (scriptId: string) => Promise<unknown>;
  createScript: (body: { name: string; description?: string; code?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string; enabled?: boolean; sortOrder?: number }) => Promise<unknown>;
  updateScript: (scriptId: string, body: { name?: string; description?: string; code?: string; enabled?: boolean; sortOrder?: number }) => Promise<unknown>;
  deleteScript: (scriptId: string) => Promise<void>;
  testScript: (scriptId: string, body: { messages?: Array<{ role: string; content: string }>; characterName?: string; characterPersonality?: string; characterScenario?: string; lastMessage?: string }) => Promise<unknown>;
  importScript: (body: { format: "js" | "json"; code?: string; jsonText?: string; name?: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string }) => Promise<unknown>;
  streamAiAssistant: (body: AiAssistantStreamRequest) => AsyncIterable<AiAssistantStreamChunk>;
  countAiAssistantTokens: (body: AiAssistantStreamRequest) => Promise<{ tokens: number; model: string; layerCount: number; messageCount: number }>;
  listProviderProfiles: () => unknown;
  fetchProviderProfile: (providerProfileId: string) => unknown;
  activateProviderProfile: (providerProfileId: string) => unknown;
  updateProviderProfile: (providerProfileId: string, body: Record<string, unknown>) => unknown;
  saveProviderDraft: (body: Record<string, unknown>) => unknown;
  testProviderDraft: (body: { endpoint?: string; apiKey?: string; providerType?: string } | null) => Promise<unknown>;
  testProviderProfile: (providerProfileId: string) => Promise<unknown>;
  deleteProviderProfile: (providerProfileId: string) => void;
  fetchProviderModels: (providerProfileId: string) => Promise<{ models: unknown }>;
  listFavoriteProviderModels: (providerProfileId: string) => unknown;
  addFavoriteProviderModel: (providerProfileId: string, body: { modelId: string; label?: string | null; contextLength?: number | null }) => unknown;
  removeFavoriteProviderModel: (providerProfileId: string, modelId: string) => unknown;
  fetchModelsByEndpoint: (baseUrl: string, apiKey?: string, providerType?: string) => Promise<unknown>;
  importJson: (body: { fileName: string; jsonText: string; chatId?: string }) => unknown;
  forkBranch: (chatId: string, fromMessageId?: string) => unknown;
  activateBranch: (chatId: string, branchId: string) => unknown;
  deleteBranch: (chatId: string, branchId: string) => unknown;
  archiveCharacter: (characterId: string) => Promise<unknown>;
  unarchiveCharacter: (characterId: string) => Promise<unknown>;
  deleteCharacter: (characterId: string) => Promise<void>;
  deleteChat: (chatId: string) => void;
  renameChat: (chatId: string, title: string) => unknown;
  setGreetingIndex: (chatId: string, greetingIndex: number) => unknown;
  listPromptPresets: () => unknown;
  createPromptPreset: (body: Record<string, unknown> & { name: string }) => unknown;
  updatePromptPreset: (presetId: string, body: Record<string, unknown>) => unknown;
  deletePromptPreset: (presetId: string) => void;
  uploadAsset: (file: File) => Promise<{ assetId: string; url: string }>;
  serveAsset: (assetId: string) => Promise<Response | null>;

  // ── Methods absorbed from former routerDeps ─────────────────────────

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

  createFreeChat: () => Promise<unknown>;

  testProviderChatByEndpoint: (opts: {
    baseUrl: string;
    apiKey: string;
    model: string;
    providerType?: string;
  }) => Promise<unknown>;

  testProviderChatByProfile: (providerProfileId: string, model: string) => Promise<unknown>;

  scanSillyTavernDirectory: (dirPath: string) => Promise<unknown>;
  importSillyTavernDirectory: (dirPath: string) => Promise<unknown>;

  // ── UI Settings ──
  getUiSettings: () => Promise<unknown>;
  updateUiSettings: (body: Record<string, unknown>) => Promise<unknown>;

  // ── Mobile Access ──
  getMobileAccessInfo: () => Promise<unknown>;
  regenerateMobileAccessToken: () => Promise<{ token: string }>;
  revokeMobileAccess: () => Promise<{ token: null }>;
}
