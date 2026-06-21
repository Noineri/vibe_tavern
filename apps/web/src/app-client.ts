/**
 * Backward-compatible barrel re-export.
 *
 * All API functions and types have been moved to apps/web/src/api/.
 * This file exists so existing imports from "../../app-client.js" keep working.
 *
 * New code should import directly from the domain modules:
 *   import { sendChatMessage } from "../api/chat-api.js";
 *   import type { AppSnapshot } from "../api/types.js";
 */

// ─── Types ──────────────────────────────────────────────────────────────
export type {
  AppSnapshot,
  AppMessage,
  AppCharacter,
  AppPersona,
  AppCharacterEntry,
  ChatListItem,
  ChatGenerationStatus,
  PersonaRecord,
  UiSettingsRecord,
  ChatSummaryRecord,
  AutoSummaryConfig,
  ImportJsonResponse,
  ProviderProfileRecord,
  FavoriteProviderModelRecord,
  ProviderModelOption,
  TestChatResponse,
  LoreEntryRecord,
  LorebookRecord,
  LorebookLinkRecord,
  ScriptRecord,
  AiAssistantChunk,
  AiAssistantMode,
  AiAssistantRequestBody,
} from "./api/types.js";

// ─── Bootstrap & Settings ───────────────────────────────────────────────
export { bootstrapApp, fetchUiSettings, updateUiSettings } from "./api/settings-api.js";

// ─── Chat ───────────────────────────────────────────────────────────────
export {
  fetchChat,
  createChat,
  deleteChat,
  clearChat,
  renameChat,
  setGreetingIndex,
  setChatPersona,
  setChatPromptPreset,
  sendChatMessage,
  regenerateChatMessage,
  generateReply,
  editChatMessage,
  deleteChatMessage,
  selectMessageVariant,
  deleteMessageVariant,
  updateAttachmentDescription,
  deleteAttachment,
  regenerateAttachmentDescription,
  sendChatMessageStream,
  regenerateChatMessageStream,
  generateReplyStream,
  forkBranch,
  activateBranch,
  renameBranch,
  deleteBranch,
  summarizeChat,
  saveChatSummary,
  listChatSummaries,
  createChatSummary,
  updateChatSummary,
  deleteChatSummary,
  generateChatSummary,
  updateMemorySettings,
  exportChatJsonl,
  exportPromptTrace,
  logClientSendDebug,
} from "./api/chat-api.js";

// ─── Character ──────────────────────────────────────────────────────────
export {
  createCharacter,
  updateCharacter,
  updateCharacterAvatar,
  uploadCharacterAvatar,
  duplicateCharacter,
  archiveCharacter,
  unarchiveCharacter,
  deleteCharacter,
  exportCharacter,
} from "./api/character-api.js";

// ─── Persona ────────────────────────────────────────────────────────────
export {
  listPersonas,
  createPersona,
  updatePersona,
  uploadPersonaAvatar,
  deletePersona,
  duplicatePersona,
  setDefaultPersona,
} from "./api/persona-api.js";

// ─── Lorebook ───────────────────────────────────────────────────────────
export {
  listAllLorebooks,
  listLorebooks,
  createLorebook,
  updateLorebookMeta,
  deleteLorebook,
  duplicateLorebook,
  exportLorebookSt,
  getLorebookLinks,
  setLorebookLinks,
  listLoreEntries,
  createLoreEntry,
  updateLoreEntry,
  deleteLoreEntry,
  reorderLoreEntries,
  testLoreActivation,
  importLorebookEntries,
} from "./api/lorebook-api.js";

// ─── Scripts ────────────────────────────────────────────────────────────
export {
  listAllScripts,
  listScripts,
  getScript,
  createScript,
  updateScript,
  deleteScript,
  testScript,
  importScript,
} from "./api/script-api.js";

// ─── Provider ───────────────────────────────────────────────────────────
export {
  listProviderProfiles,
  fetchProviderProfile,
  saveProviderProfile,
  updateProviderProfile,
  deleteProviderProfile,
  activateProviderProfile,
  testProviderDraft,
  testProviderProfile,
  fetchProviderProfileModels,
  listFavoriteProviderModels,
  addFavoriteProviderModel,
  removeFavoriteProviderModel,
  fetchModelsByEndpoint,
  testProviderChat,
  testProfileChat,
} from "./api/provider-api.js";

// ─── Presets ────────────────────────────────────────────────────────────
export {
  listPromptPresets,
  createPromptPreset,
  updatePromptPreset,
  deletePromptPreset,
} from "./api/preset-api.js";

// ─── Asset ──────────────────────────────────────────────────────────────
export { uploadAsset } from "./api/asset-api.js";

// ─── Gallery (character media gallery) ──────────────────────────────────
export {
  serveCharacterAssetUrl,
  listCharacterAssets,
  uploadCharacterAsset,
  updateCharacterAsset,
  reorderCharacterAssets,
  deleteCharacterAsset,
  describeCharacterAssets,
  describeCharacterAvatar,
  describePersonaAvatar,
} from "./api/gallery-api.js";

// ─── AI Assistant ───────────────────────────────────────────────────────
export { streamAiAssistant, countAiAssistantTokens } from "./api/ai-assistant-api.js";

// ─── Import ─────────────────────────────────────────────────────────────
export { importJson } from "./api/import-api.js";
