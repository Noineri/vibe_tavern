import type { AiAssistantStreamChunk } from "../../domain/ai-assistant/reasoning-split.js";
import type { AiAssistantStreamRequest } from "../../domain/ai-assistant/ai-assistant-stream.js";
import type { PersonaRecord } from "../../domain/persona/persona-runtime.js";
import type { ClientProviderProfileRecord } from "../../runtime/session/session-runtime-dto.js";
import type {
	BootstrapState,
	ImportResult,
	MessageResponse,
	SessionSnapshot,
	VariantResponse,
	BranchResponse,
	BranchMetaResponse,
	ChatSwitchResponse,
	ChatCreateResponse,
	ChatListResponse,
	ConfigPatchResponse,
	SummaryResponse,
} from "./session-types.js";
import type { PromptTraceRecordDto, PromptPresetDto } from "@vibe-tavern/domain";
import type {
	ChatSummary,
	FavoriteModel,
	LorebookLink,
	UiSettings,
} from "@vibe-tavern/db";
import type { LorebookRow, LoreEntryRow, ScriptRow } from "@vibe-tavern/db";
import type { ProviderProbeResult, ProviderModelOption, TestChatResult } from "../../domain/providers/provider-gateway.js";
import type { GenerateChatSummaryResult, SummarizeChatResult } from "../../domain/chat/chat-summary-service.js";
import type { LorebookImportResult } from "../../domain/lorebook/lorebook-import-service.js";
import type { ScriptTestResult } from "../../domain/scripts-engine/script-test-service.js";
import type { StDirectoryScanResult, StDirectoryImportResult } from "../../shared/st-directory-scanner.js";
import type { MobileAccessInfo } from "../../domain/mobile-access/mobile-access-service.js";

// ─── Shared type aliases ────────────────────────────────────────────
//
// This file defines `RuntimeApi` — the single contract between Hono route
// handlers (routes/*.ts) and the adapter layer (api/adapters/runtime-api-adapter.ts +
// adapters/*.ts). Routes should never import store/runtime internals directly;
// they go through this interface.
//
// Response-type conventions:
//   - Mutating chat endpoints currently return `SessionSnapshot` (monolithic).
//     This will move to per-endpoint response shapes (Phase 3.4 refactor).
//   - Some endpoints already return slim/partial responses:
//       renameChat        → { chatId, title }
//       archiveCharacter  → { characterId, status }
//     These are the first examples of endpoint-scoped responses.
//   - Body params typed as `Record<string, unknown>` are Zod-validated upstream
//     in the route handler before reaching the adapter.

/** DB row shape returned by the lorebook store. */
type Lorebook = LorebookRow;
type LoreEntry = LoreEntryRow;
type Script = ScriptRow;

// `PersonaRecord` is imported from domain/persona/persona-runtime.js (canonical
// shape — see PERSONA_DTO_CONSOLIDATION_PLAN.md). The contract previously
// redeclared it as a wire-type duplicate; that and `PersonaDuplicateRecord`
// (the duplicate path that missed `avatarCropJson`) are removed — duplicate
// now returns the canonical `PersonaRecord`.

/** A single image in a character's media gallery (plain-string DTO for the API layer). */
interface CharacterAssetRecord {
	id: string;
	characterId: string;
	ext: string;
	mimeType: string;
	caption: string;
	description: string | null;
	includeInPrompt: boolean;
	/** D8: crop geometry (percentages JSON) for a salvaged former-avatar row; null otherwise. */
	avatarCropJson: string | null;
	order: number;
	createdAt: string;
}

// ─── Bootstrap / Debug ───────────────────────────────────────────────

export interface BootstrapRuntimeApi {
	bootstrap: () => Promise<BootstrapState>;
}

// ─── Chat ────────────────────────────────────────────────────────────

export interface ChatRuntimeApi {
	getChatSnapshot: (chatId: string) => Promise<ChatSwitchResponse>;
	createChatForCharacter: (characterId: string) => Promise<ChatCreateResponse>;
	cloneChat: (chatId: string) => Promise<SessionSnapshot>;
	deleteChat: (chatId: string) => Promise<void>;
	clearChat: (chatId: string) => Promise<ChatCreateResponse>;
	renameChat: (chatId: string, title: string) => Promise<ChatListResponse>;
	setGreetingIndex: (chatId: string, greetingIndex: number) => Promise<VariantResponse>;
	setChatPersona: (chatId: string, personaId: string) => Promise<ConfigPatchResponse>;
	setChatPromptPreset: (chatId: string, promptPresetId: string) => Promise<ConfigPatchResponse>;

	// Branches
	branchChat: (chatId: string, messageId: string) => Promise<BranchResponse>;
	forkBranch: (chatId: string, fromMessageId?: string) => Promise<BranchResponse>;
	activateBranch: (chatId: string, branchId: string) => Promise<BranchResponse>;
	deleteBranch: (chatId: string, branchId: string) => Promise<BranchResponse>;
	renameBranch: (chatId: string, branchId: string, label: string) => Promise<BranchMetaResponse>;

	// Messages
	sendMessage: (chatId: string, body: { content: string }, signal?: AbortSignal) => Promise<MessageResponse>;
	sendMessageStream: (chatId: string, body: { content: string }, signal?: AbortSignal) => AsyncIterable<{ event: string; data: string }>;
	regenerateMessage: (chatId: string, messageId: string, body: Record<string, unknown>, signal?: AbortSignal) => Promise<MessageResponse>;
	regenerateMessageStream: (chatId: string, messageId: string, body: Record<string, unknown>, signal?: AbortSignal) => AsyncIterable<{ event: string; data: string }>;
	generateReply: (chatId: string, signal?: AbortSignal) => Promise<MessageResponse>;
	generateReplyStream: (chatId: string, signal?: AbortSignal) => AsyncIterable<{ event: string; data: string }>;
	selectVariant: (chatId: string, messageId: string, variantIndex: number) => Promise<VariantResponse>;
	deleteVariant: (chatId: string, messageId: string, variantIndex: number) => Promise<MessageResponse>;
	editMessage: (chatId: string, messageId: string, content: string) => Promise<MessageResponse>;
	deleteMessage: (chatId: string, messageId: string) => Promise<MessageResponse>;
	updateAttachmentDescription: (chatId: string, messageId: string, attachmentId: string, description: string) => Promise<{ ok: boolean }>;
	deleteAttachment: (chatId: string, messageId: string, attachmentId: string) => Promise<{ ok: boolean }>;
	regenerateAttachmentDescription: (chatId: string, messageId: string, attachmentId: string) => Promise<{ description: string }>;

	// Export
	exportChatJsonl: (chatId: string) => Promise<string>;
	exportPromptTrace: (traceId: string) => Promise<PromptTraceRecordDto>;

	// Summaries & Memory
	listChatSummaries: (chatId: string) => Promise<ChatSummary[]>;
	createChatSummary: (chatId: string, body: { label?: string; content?: string; summarizedFrom: number; summarizedTo: number; includeInContext?: boolean; excludeSummarized?: boolean; source?: "manual" | "auto"; sortOrder?: number }) => Promise<{ summary: ChatSummary; snapshot: SummaryResponse }>;
	updateChatSummaryRecord: (chatId: string, summaryId: string, body: { label?: string; content?: string; summarizedFrom?: number; summarizedTo?: number; includeInContext?: boolean; excludeSummarized?: boolean; sortOrder?: number }) => Promise<{ summary: ChatSummary; snapshot: SummaryResponse }>;
	deleteChatSummaryRecord: (chatId: string, summaryId: string) => Promise<{ ok: boolean; snapshot: SummaryResponse }>;
	generateChatSummary: (chatId: string, body: { providerProfileId: string; model?: string; summarizedFrom: number; summarizedTo: number; targetSummaryId?: string; label?: string; includeInContext?: boolean; excludeSummarized?: boolean }, signal?: AbortSignal) => Promise<GenerateChatSummaryResult>;
	updateMemorySettings: (chatId: string, body: { messageHistoryLimit?: number; autoSummaryConfig?: { enabled?: boolean; everyN?: number; useChatModel?: boolean; providerProfileId?: string; model?: string } }) => Promise<ConfigPatchResponse>;
	summarizeChat: (chatId: string, body: { providerProfileId: string; model?: string; maxMessages: number }, signal?: AbortSignal) => Promise<SummarizeChatResult>;
	saveChatSummary: (chatId: string, body: { summary: string }) => Promise<SummarizeChatResult>;
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
	}) => Promise<ImportResult>;
	updateCharacter: (characterId: string, body: Record<string, unknown>) => Promise<ConfigPatchResponse>;
	archiveCharacter: (characterId: string) => Promise<{ characterId: string; status: "archived" }>;
	unarchiveCharacter: (characterId: string) => Promise<{ characterId: string; status: "active" }>;
	deleteCharacter: (characterId: string) => Promise<void>;
	exportCharacter: (characterId: string) => Promise<Record<string, unknown>>;
	duplicateCharacter: (characterId: string) => Promise<ImportResult>;
	uploadCharacterAvatar: (characterId: string, crop: File, full?: File) => Promise<{ avatarExt: string; avatarFullExt: string | null }>;
	serveCharacterAvatar: (characterId: string) => Promise<Response | null>;
	serveCharacterAvatarFull: (characterId: string) => Promise<Response | null>;

	// Vision describe (A6) — uses the active provider profile's visionModel.
	describeCharacterAvatar: (characterId: string, signal?: AbortSignal) => Promise<{ description: string }>;
}

// ─── Character media gallery ───────────────────────────────────────

export interface CharacterAssetRuntimeApi {
	listCharacterAssets: (characterId: string) => Promise<CharacterAssetRecord[]>;
	serveCharacterAsset: (characterId: string, assetRowId: string) => Promise<Response | null>;
	uploadCharacterAsset: (characterId: string, file: File) => Promise<CharacterAssetRecord>;
	updateCharacterAsset: (characterId: string, assetRowId: string, patch: { caption?: string; description?: string | null; includeInPrompt?: boolean }) => Promise<CharacterAssetRecord>;
	reorderCharacterAssets: (characterId: string, orderedIds: string[]) => Promise<void>;
	deleteCharacterAsset: (characterId: string, assetRowId: string) => Promise<void>;

	// Vision describe (A6) — uses the active provider profile's visionModel.
	describeCharacterAssets: (characterId: string, assetRowIds?: string[], signal?: AbortSignal) => Promise<{ updated: string[]; failed: string[] }>;

	// D8: set a gallery image as the character's avatar. Salvages the current
	// avatar (full bytes + its cropJson) into a new gallery row before
	// overwriting, so nothing is lost. `crop` is the cropped thumbnail File;
	// `cropJson` is the crop geometry (percentages JSON) to store on the
	// character for future restore. Returns the new avatar state + the salvaged
	// row id (null when there was no prior avatar to salvage).
	setAvatarFromGallery: (characterId: string, sourceAssetId: string, crop: File, cropJson: string) => Promise<{ avatarExt: string; avatarFullExt: string | null; avatarCropJson: string; updatedAt: string; salvagedAssetId: string | null }>;

	// D1/R5: promote a gallery image into the general asset store so it can be
	// attached to a chat message draft without a client re-upload. Copies the
	// gallery bytes (server-side) into `data/assets/{assetId}` and returns the
	// flat-attachment descriptor the chat draft expects. `name` is derived from
	// the row's caption (falling back to `media-{rowId}.{ext}`). Same philosophy
	// as the D8 salvage: bytes move server-side, no round-trip to the client.
	promoteGalleryAssetToAttachment: (characterId: string, assetRowId: string) => Promise<{ assetId: string; name: string; mimeType: string; sizeBytes: number }>;
}

// ─── Persona ─────────────────────────────────────────────────────────

export interface PersonaRuntimeApi {
	listPersonas: () => Promise<PersonaRecord[]>;
	createPersona: (body: { name: string; description: string; pronouns?: string | null; defaultForNewChats?: boolean }) => Promise<PersonaRecord>;
	updatePersona: (personaId: string, body: Record<string, unknown>) => Promise<ConfigPatchResponse | { id: string }>;
	deletePersona: (personaId: string) => Promise<void>;
	duplicatePersona: (personaId: string) => Promise<PersonaRecord>;
	setDefaultPersona: (personaId: string) => Promise<void>;
	uploadPersonaAvatar: (personaId: string, crop: File, full?: File) => Promise<{ avatarExt: string; avatarFullExt: string | null }>;
	servePersonaAvatar: (personaId: string) => Promise<Response | null>;
	servePersonaAvatarFull: (personaId: string) => Promise<Response | null>;

	// Vision describe (A6) — uses the active provider profile's visionModel.
	describePersonaAvatar: (personaId: string) => Promise<{ description: string }>;
}

// ─── Lorebook ────────────────────────────────────────────────────────

export interface LorebookRuntimeApi {
	listAllLorebooks: () => Promise<Lorebook[]>;
	listLorebooks: (scopeType: string, ownerId?: string) => Promise<Lorebook[]>;
	createLorebook: (body: { name: string; description?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string; scanDepth?: number; tokenBudget?: number; recursiveScanning?: boolean }) => Promise<Lorebook>;
	updateLorebookMeta: (lorebookId: string, body: { name?: string; description?: string; scanDepth?: number; tokenBudget?: number; recursiveScanning?: boolean; enabled?: boolean; scopeType?: string }) => Promise<Lorebook>;
	deleteLorebook: (lorebookId: string) => Promise<void>;
	duplicateLorebook: (lorebookId: string, overrides?: { name?: string; scopeType?: string; characterId?: string | null; personaId?: string | null }) => Promise<{ lorebook: Lorebook; links: LorebookLink[] }>;
	exportLorebook: (lorebookId: string) => Promise<Record<string, unknown>>;
	getLorebookLinks: (lorebookId: string) => Promise<LorebookLink[]>;
	setLorebookLinks: (lorebookId: string, links: Array<{ targetType: string; targetId: string }>) => Promise<LorebookLink[]>;
	importLorebook: (lorebookId: string | null, body: { format: string; data: unknown; mode: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string; fallbackName?: string }) => Promise<LorebookImportResult>;

	// Entries
	createLoreEntry: (lorebookId: string, body: Record<string, unknown>) => Promise<LoreEntry>;
	updateLoreEntry: (lorebookId: string, entryId: string, body: Record<string, unknown>) => Promise<LoreEntry>;
	deleteLoreEntry: (lorebookId: string, entryId: string) => Promise<void>;
	listLoreEntries: (lorebookId: string) => Promise<LoreEntry[]>;
	reorderLoreEntries: (lorebookId: string, updates: Array<{ id: string; sortOrder: number; position?: string }>) => Promise<LoreEntry[]>;
	testLoreActivation: (lorebookId: string, body: { text: string }) => Promise<{ activatedIds: string[]; totalEntries: number }>;
}

// ─── Script ──────────────────────────────────────────────────────────

export interface ScriptRuntimeApi {
	listAllScripts: () => Promise<Script[]>;
	listScripts: (scopeType: string, ownerId?: string) => Promise<Script[]>;
	getScript: (scriptId: string) => Promise<Script | null>;
	createScript: (body: { name: string; description?: string; code?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string; enabled?: boolean; sortOrder?: number }) => Promise<Script>;
	updateScript: (scriptId: string, body: { name?: string; description?: string; code?: string; enabled?: boolean; sortOrder?: number }) => Promise<Script>;
	deleteScript: (scriptId: string) => Promise<void>;
	testScript: (scriptId: string, body: { messages?: Array<{ role: string; content: string }>; characterName?: string; characterPersonality?: string; characterScenario?: string; lastMessage?: string }) => Promise<ScriptTestResult>;
	importScript: (body: { format: "js" | "json"; code?: string; jsonText?: string; name?: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string }) => Promise<Script>;
}

// ─── Provider ────────────────────────────────────────────────────────

export interface ProviderRuntimeApi {
	listProviderProfiles: () => Promise<ClientProviderProfileRecord[]>;
	fetchProviderProfile: (providerProfileId: string) => Promise<ClientProviderProfileRecord>;
	activateProviderProfile: (providerProfileId: string) => Promise<ClientProviderProfileRecord>;
	updateProviderProfile: (providerProfileId: string, body: Record<string, unknown>) => Promise<ClientProviderProfileRecord>;
	saveProviderDraft: (body: Record<string, unknown>) => Promise<ClientProviderProfileRecord>;
	deleteProviderProfile: (providerProfileId: string) => Promise<void>;
	testProviderDraft: (body: { endpoint?: string; apiKey?: string; providerType?: string } | null) => Promise<ProviderProbeResult>;
	testProviderProfile: (providerProfileId: string) => Promise<ProviderProbeResult>;
	fetchProviderModels: (providerProfileId: string) => Promise<{ models: ProviderModelOption[] }>;
	listFavoriteProviderModels: (providerProfileId: string) => Promise<FavoriteModel[]>;
	addFavoriteProviderModel: (providerProfileId: string, body: { modelId: string; label?: string | null; contextLength?: number | null }) => Promise<FavoriteModel>;
	removeFavoriteProviderModel: (providerProfileId: string, modelId: string) => Promise<void>;
	fetchModelsByEndpoint: (baseUrl: string, apiKey?: string, providerType?: string) => Promise<ProviderModelOption[]>;
	testProviderChatByEndpoint: (opts: { baseUrl: string; apiKey: string; model: string; providerType?: string }) => Promise<TestChatResult>;
	testProviderChatByProfile: (providerProfileId: string, model: string) => Promise<TestChatResult>;
}

// ─── Preset ──────────────────────────────────────────────────────────

export interface PresetRuntimeApi {
	listPromptPresets: () => Promise<PromptPresetDto[]>;
	createPromptPreset: (body: Record<string, unknown> & { name: string }) => Promise<PromptPresetDto>;
	updatePromptPreset: (presetId: string, body: Record<string, unknown>) => Promise<PromptPresetDto>;
	deletePromptPreset: (presetId: string) => Promise<void>;
}

// ─── Import/Export ───────────────────────────────────────────────────

export interface ImportExportRuntimeApi {
	importJson: (body: { fileName: string; jsonText: string; chatId?: string }) => Promise<ImportResult>;
	scanSillyTavernDirectory: (dirPath: string) => Promise<StDirectoryScanResult>;
	importSillyTavernDirectory: (dirPath: string) => Promise<StDirectoryImportResult>;
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
	getUiSettings: () => Promise<UiSettings>;
	updateUiSettings: (body: Record<string, unknown>) => Promise<UiSettings>;
}

// ─── Mobile Access ───────────────────────────────────────────────────

export interface MobileAccessRuntimeApi {
	getMobileAccessInfo: () => Promise<MobileAccessInfo>;
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
	character: CharacterRuntimeApi & CharacterAssetRuntimeApi;
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
