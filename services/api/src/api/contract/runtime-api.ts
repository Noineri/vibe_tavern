import type { AiAssistantStreamChunk } from "../../domain/ai-assistant/reasoning-split.js";
import type { AiAssistantStreamRequest } from "../../domain/ai-assistant/ai-assistant-stream.js";
import type { PersonaRecord } from "../../domain/persona/persona-runtime.js";
import type { ClientProviderProfileRecord, ClientProxyRecord } from "../../runtime/session/session-runtime-dto.js";
import type {
	BootstrapState,
	ImportResult,
	BatchImportResult,
	MessageResponse,
	SessionSnapshot,
	VariantResponse,
	BranchResponse,
	BranchMetaResponse,
	ChatSwitchResponse,
	ChatCreateResponse,
	ChatListResponse,
	ChatListItem,
	ConfigPatchResponse,
	ContextPreviewResponse,
	InsightsCompletionPatchResponse,
	SceneBackfillStatusResponse,
	ScenePreviewResponse,
	SceneStatusResponse,
	SceneTargetResponse,
	CoauthorApplyResponse,
	SummaryResponse,
	CharacterVersionResponse,
} from "./session-types.js";
import type { ObjectiveMode, ObjectiveTaskStatus, PromptTraceRecordDto, PromptPresetDto, PronounForms, SceneTrackerConfig, SceneTrackerConfigPatch, CoauthorContextLink, MessageVariantId, DiceActorType, DiceMode, DiceRollSnapshot, ProviderProxyMode } from "@vibe-tavern/domain";
import type { ChatMode } from "@vibe-tavern/domain";
import type { DiceDefinitionsResponse } from "../../domain/scripts-engine/dice-script-service.js";
import type { DicePendingState } from "../../domain/dice/dice-service.js";
import type { SkillCatalogEntryDto } from "@vibe-tavern/api-contracts";
// Re-export so existing imports from this module (the skill adapter) keep
// resolving; the canonical wire type lives in api-contracts (single source).
export type { SkillCatalogEntryDto };
import type {
	ChatSummary,
	FavoriteModel,
	ProviderModelSettings,
	LorebookLink,
	ScriptLink,
	UiSettings,
} from "@vibe-tavern/db";
import type { CoauthorTransport, ModelFavoriteScope, ModelSettingsOverlay } from "@vibe-tavern/domain";
import type { LorebookRow, LoreEntryRow, ScriptRow } from "@vibe-tavern/db";
import type { RegenerateOverride, CoauthorApplyRequest } from "@vibe-tavern/api-contracts";
import type { ProviderProbeResult, ProviderModelOption, TestChatResult } from "../../domain/providers/provider-gateway.js";
import type { GenerateChatSummaryResult, SummarizeChatResult } from "../../domain/chat/chat-summary-service.js";
import type { LorebookImportResult } from "../../domain/lorebook/lorebook-import-service.js";
import type { ScriptTestResult } from "../../domain/scripts-engine/script-test-service.js";
import type { StDirectoryScanResult, StDirectoryImportResult, ImportStreamEvent } from "../../shared/st-directory-scanner.js";
import type { MobileAccessInfo } from "../../domain/mobile-access/mobile-access-service.js";
import type { SkillImportFile, SkillImportResult } from "../../domain/coauthor/skills/skill-library.js";

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
	createChatForCharacter: (characterId: string, mode?: ChatMode) => Promise<ChatCreateResponse>;
	/** Co-Author chats for a character (mode='coauthor'), for the Co-Author
	 *  entry screen. Each is a normal chats row driven through the universal
	 *  send/stream pipeline — no separate transport. */
	listCoauthorChats: (characterId: string) => Promise<ChatListItem[]>;
	/** Apply a co-author turn's aggregated proposed state to the underlying
	 *  character card (CA-7). Does NOT touch chat messages — it persists the
	 *  model's proposed `profile.md` / greetings via the normal character-update
	 *  dual-write, and returns a config-patch snapshot plus any data-loss
	 *  `corrections` (e.g. an empty name restored from the existing card). */
	applyCoauthorDraft: (chatId: string, body: CoauthorApplyRequest) => Promise<CoauthorApplyResponse>;
	cloneChat: (chatId: string) => Promise<SessionSnapshot>;
	deleteChat: (chatId: string) => Promise<ChatListResponse>;
	clearChat: (chatId: string) => Promise<ChatCreateResponse>;
	renameChat: (chatId: string, title: string) => Promise<ChatListResponse>;
	setGreetingIndex: (chatId: string, greetingIndex: number) => Promise<VariantResponse>;
	setCoauthorContextLinks: (chatId: string, links: CoauthorContextLink[]) => Promise<VariantResponse>;
	setChatPersona: (chatId: string, personaId: string) => Promise<ConfigPatchResponse>;
	setChatPromptPreset: (chatId: string, promptPresetId: string) => Promise<ConfigPatchResponse>;
	setCoauthorModule: (chatId: string, moduleId: string | null) => Promise<ConfigPatchResponse>;
	listCoauthorModules: () => Promise<import("@vibe-tavern/api-contracts").CoauthorModule[]>;
	createCoauthorModule: (input: import("@vibe-tavern/api-contracts").CoauthorModuleCreate) => Promise<import("@vibe-tavern/api-contracts").CoauthorModule>;
	updateCoauthorModule: (id: string, input: import("@vibe-tavern/api-contracts").CoauthorModuleUpdate) => Promise<import("@vibe-tavern/api-contracts").CoauthorModule>;
	deleteCoauthorModule: (id: string) => Promise<void>;

	// Branches
	branchChat: (chatId: string, messageId: string) => Promise<BranchResponse>;
	forkBranch: (chatId: string, fromMessageId?: string) => Promise<BranchResponse>;
	activateBranch: (chatId: string, branchId: string) => Promise<BranchResponse>;
	deleteBranch: (chatId: string, branchId: string) => Promise<BranchResponse>;
	renameBranch: (chatId: string, branchId: string, label: string) => Promise<BranchMetaResponse>;

	// Messages
	sendMessage: (chatId: string, body: { content: string; attachments?: import("@vibe-tavern/domain").Attachment[]; diceMode?: "normal" | "immersive"; pendingRevision?: number }, signal?: AbortSignal) => Promise<MessageResponse>;
	sendMessageStream: (chatId: string, body: { content: string; attachments?: import("@vibe-tavern/domain").Attachment[]; diceMode?: "normal" | "immersive"; pendingRevision?: number }, signal?: AbortSignal) => AsyncIterable<{ event: string; data: string }>;
	regenerateMessage: (chatId: string, messageId: string, override: RegenerateOverride, signal?: AbortSignal) => Promise<MessageResponse>;
	regenerateMessageStream: (chatId: string, messageId: string, override: RegenerateOverride, signal?: AbortSignal) => AsyncIterable<{ event: string; data: string }>;
	generateReply: (chatId: string, signal?: AbortSignal) => Promise<MessageResponse>;
	generateReplyStream: (chatId: string, signal?: AbortSignal) => AsyncIterable<{ event: string; data: string }>;
	selectVariant: (chatId: string, messageId: string, variantIndex: number) => Promise<VariantResponse>;
	addEditorVariant: (chatId: string, messageId: string, body: {
		readonly content: string;
		readonly sourceVariantIds: readonly MessageVariantId[];
		readonly modelId?: string;
		readonly promptPresetId?: string;
		readonly finishReason?: string;
	}) => Promise<MessageResponse>;
	deleteVariant: (chatId: string, messageId: string, variantIndex: number) => Promise<MessageResponse>;
	editMessage: (chatId: string, messageId: string, content: string, expectedVariantId?: MessageVariantId) => Promise<MessageResponse>;
	deleteMessage: (chatId: string, messageId: string) => Promise<MessageResponse>;
	updateAttachmentDescription: (chatId: string, messageId: string, attachmentId: string, description: string) => Promise<{ ok: boolean }>;
	deleteAttachment: (chatId: string, messageId: string, attachmentId: string) => Promise<{ ok: boolean }>;
	regenerateAttachmentDescription: (chatId: string, messageId: string, attachmentId: string) => Promise<{ description: string }>;

	// Export
	exportChatJsonl: (chatId: string) => Promise<string>;
	exportPromptTrace: (traceId: string) => Promise<PromptTraceRecordDto>;

	// Prompt traces (lazy-loaded history)
	listPromptTraces: (chatId: string, opts?: { messageId?: string; branchId?: string }) => Promise<PromptTraceRecordDto[]>;

	// Live context preview (lazy branch-scoped hydration target). POST, not GET:
	// current assembly persists lore/script activation state, so it is not a
	// side-effect-free read. The branch is a path param so a long-running request
	// can never silently follow whichever branch is active later.
	getContextPreview: (chatId: string, branchId: string) => Promise<ContextPreviewResponse>;

	// Summaries & Memory
	listChatSummaries: (chatId: string) => Promise<ChatSummary[]>;
	createChatSummary: (chatId: string, body: { label?: string; content?: string; summarizedFrom: number; summarizedTo: number; includeInContext?: boolean; excludeSummarized?: boolean; source?: "manual" | "auto"; sortOrder?: number }) => Promise<{ summary: ChatSummary; snapshot: SummaryResponse }>;
	updateChatSummaryRecord: (chatId: string, summaryId: string, body: { label?: string; content?: string; summarizedFrom?: number; summarizedTo?: number; includeInContext?: boolean; excludeSummarized?: boolean; sortOrder?: number }) => Promise<{ summary: ChatSummary; snapshot: SummaryResponse }>;
	deleteChatSummaryRecord: (chatId: string, summaryId: string) => Promise<{ ok: boolean; snapshot: SummaryResponse }>;
	generateChatSummary: (chatId: string, body: { providerProfileId: string; model?: string; summarizedFrom: number; summarizedTo: number; targetSummaryId?: string; label?: string; includeInContext?: boolean; excludeSummarized?: boolean; temperature?: number; maxOutputTokens?: number; contextBudget?: number }, signal?: AbortSignal) => Promise<GenerateChatSummaryResult>;
	updateMemorySettings: (chatId: string, body: { messageHistoryLimit?: number; autoSummaryConfig?: { enabled?: boolean; everyN?: number; useChatModel?: boolean; providerProfileId?: string; model?: string } }) => Promise<ConfigPatchResponse>;
	updateInsightsConfig: (chatId: string, body: { insightsConfig?: { objectiveEnabled?: boolean; trackerEnabled?: boolean; diceEnabled?: boolean; diceMode?: string; tracker?: SceneTrackerConfigPatch } }) => Promise<ConfigPatchResponse>;
	summarizeChat: (chatId: string, body: { providerProfileId: string; model?: string; maxMessages: number }, signal?: AbortSignal) => Promise<SummarizeChatResult>;
	saveChatSummary: (chatId: string, body: { summary: string }) => Promise<SummarizeChatResult>;
	updateDynamicPrompt: (chatId: string, body: { content: string }) => Promise<ConfigPatchResponse>;
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

	// ─── Character versions (VTF Phase 3 folder-snapshot branching) ─────────
	// list lazily bootstraps an implicit "Base" active version for characters
	// that predate this feature (createFromScratch creates one eagerly).
	listCharacterVersions: (characterId: string) => Promise<CharacterVersionResponse[]>;
	createCharacterVersion: (characterId: string, title: string) => Promise<CharacterVersionResponse>;
	activateCharacterVersion: (characterId: string, versionId: string) => Promise<CharacterVersionResponse>;
	renameCharacterVersion: (characterId: string, versionId: string, title: string) => Promise<CharacterVersionResponse>;
	deleteCharacterVersion: (characterId: string, versionId: string) => Promise<void>;

	// ─── Bound resources (character-editor binding field) ───────────────────
	// Reverse-direction read: lorebooks M:N-linked to this character via
	// lorebook_links. Mirrors listPersonaLorebooks; both back the
	// BoundResourcesField lorebook pill group.
	listCharacterLorebooks: (characterId: string) => Promise<Lorebook[]>;
	listCharacterScripts: (characterId: string) => Promise<Script[]>;
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
	createPersona: (body: { name: string; description: string; pronouns?: string | null; pronounForms?: PronounForms | null; defaultForNewChats?: boolean }) => Promise<PersonaRecord>;
	updatePersona: (personaId: string, body: Record<string, unknown>) => Promise<ConfigPatchResponse | { id: string }>;
	deletePersona: (personaId: string) => Promise<void>;
	duplicatePersona: (personaId: string) => Promise<PersonaRecord>;
	setDefaultPersona: (personaId: string) => Promise<void>;
	uploadPersonaAvatar: (personaId: string, crop: File, full?: File) => Promise<{ avatarExt: string; avatarFullExt: string | null }>;
	servePersonaAvatar: (personaId: string) => Promise<Response | null>;
	servePersonaAvatarFull: (personaId: string) => Promise<Response | null>;

	// Vision describe (A6) — uses the active provider profile's visionModel.
	describePersonaAvatar: (personaId: string) => Promise<{ description: string }>;

	// Export (PR-5). Single returns a format-shaped JSON body; bulk returns a
	// download-ready JSON (ST backup shape or VT-native array of payloads).
	exportPersona: (personaId: string, format: "st" | "vt") => Promise<{ body: Record<string, unknown>; filename: string; contentType: string }>;
	exportAllPersonas: (format: "st" | "vt") => Promise<{ body: unknown; filename: string; contentType: string }>;
	// Import/restore: accepts a VT bulk payload (array of VT v1 payloads), creates
	// personas + writes avatars. Returns a per-persona result summary.
	importPersonas: (payload: unknown) => Promise<{ created: number; skipped: number; errors: string[] }>;

	// Bound resources (PR-12) — reverse-direction reads for the
	// persona-editor binding field. Both are M:N-linked via their junction
	// tables (links-only, excludes FK-owned home scope); both back the
	// BoundResourcesField pill groups.
	listPersonaLorebooks: (personaId: string) => Promise<Lorebook[]>;
	listPersonaScripts: (personaId: string) => Promise<Script[]>;
}

// ─── Lorebook ────────────────────────────────────────────────────────

export interface LorebookRuntimeApi {
	listAllLorebooks: () => Promise<Lorebook[]>;
	listLorebooks: (scopeType: string, ownerId?: string) => Promise<Lorebook[]>;
	createLorebook: (body: { name: string; description?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string; scanDepth?: number; tokenBudget?: number; tokenBudgetPercent?: number | null; recursiveScanning?: boolean }) => Promise<Lorebook>;
	updateLorebookMeta: (lorebookId: string, body: { name?: string; description?: string; scanDepth?: number; tokenBudget?: number; tokenBudgetPercent?: number | null; recursiveScanning?: boolean; enabled?: boolean; scopeType?: string }) => Promise<Lorebook>;
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
	createScript: (body: { name: string; description?: string; code?: string; scriptKind?: string; creationIntentId?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string; enabled?: boolean; sortOrder?: number }) => Promise<Script>;
	updateScript: (scriptId: string, body: { name?: string; description?: string; code?: string; enabled?: boolean; sortOrder?: number; defaultVisualId?: string | null; copilotProfileId?: string | null }) => Promise<Script>;
	setScriptScope: (scriptId: string, scopeType: 'global' | 'character' | 'persona' | 'chat', ownerId: string | null) => Promise<Script>;
	deleteScript: (scriptId: string) => Promise<void>;
	testScript: (scriptId: string, body: { code?: string; messages?: Array<{ role: string; content: string }>; characterName?: string; characterPersonality?: string; characterScenario?: string; lastMessage?: string }) => Promise<ScriptTestResult>;
	importScript: (body: { format: "js" | "json"; code?: string; jsonText?: string; name?: string; scriptKind?: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string }) => Promise<Script>;
	getScriptLinks: (scriptId: string) => Promise<ScriptLink[]>;
	setScriptLinks: (scriptId: string, links: Array<{ targetType: string; targetId: string }>) => Promise<ScriptLink[]>;
	/** List the visuals bound to a script (its equal-peer "skin" set; BE-5 junction). */
	getScriptVisuals: (scriptId: string) => Promise<ExperienceVisualRow[]>;
	/** Bind a visual to a script (idempotent; first bound visual auto-becomes the silent default). */
	bindScriptVisual: (scriptId: string, visualId: string) => Promise<void>;
	/** Unbind a visual (reassigns the silent default if it was the one removed). */
	unbindScriptVisual: (scriptId: string, visualId: string) => Promise<void>;
}

// ─── Provider ────────────────────────────────────────────────────────

export interface ProviderRuntimeApi {
	listProviderProfiles: () => Promise<ClientProviderProfileRecord[]>;
	reorderProviderProfiles: (updates: Array<{ id: string; sortOrder: number }>) => Promise<ClientProviderProfileRecord[]>;
	fetchProviderProfile: (providerProfileId: string) => Promise<ClientProviderProfileRecord>;
	activateProviderProfile: (providerProfileId: string) => Promise<ClientProviderProfileRecord>;
	updateProviderProfile: (providerProfileId: string, body: Record<string, unknown>) => Promise<ClientProviderProfileRecord>;
	saveProviderDraft: (body: Record<string, unknown>) => Promise<ClientProviderProfileRecord>;
	deleteProviderProfile: (providerProfileId: string) => Promise<void>;
	testProviderDraft: (body: { endpoint?: string; apiKey?: string; providerType?: string; proxyMode?: ProviderProxyMode; proxyId?: string | null; providerProfileId?: string } | null) => Promise<ProviderProbeResult>;
	testProviderProfile: (providerProfileId: string) => Promise<ProviderProbeResult>;
	fetchProviderModels: (providerProfileId: string) => Promise<{ models: ProviderModelOption[] }>;
	listFavoriteProviderModels: (providerProfileId: string, scope: ModelFavoriteScope) => Promise<FavoriteModel[]>;
	addFavoriteProviderModel: (providerProfileId: string, body: { modelId: string; label?: string | null; contextLength?: number | null; scope: ModelFavoriteScope }) => Promise<FavoriteModel>;
	removeFavoriteProviderModel: (providerProfileId: string, body: { modelId: string; scope: ModelFavoriteScope }) => Promise<void>;
	listProviderModelSettings: (providerProfileId: string) => Promise<ProviderModelSettings[]>;
	getProviderModelSettings: (providerProfileId: string, modelId: string) => Promise<ProviderModelSettings | null>;
	upsertProviderModelSettings: (providerProfileId: string, modelId: string, settings: ModelSettingsOverlay) => Promise<ProviderModelSettings>;
	deleteProviderModelSettings: (providerProfileId: string, modelId: string) => Promise<void>;
	fetchModelsByEndpoint: (baseUrl: string, apiKey?: string, providerType?: string, proxyMode?: ProviderProxyMode, proxyId?: string | null) => Promise<ProviderModelOption[]>;
	testProviderChatByEndpoint: (opts: { baseUrl: string; apiKey: string; model: string; providerType?: string; proxyMode?: ProviderProxyMode; proxyId?: string | null }) => Promise<TestChatResult>;
	testProviderChatByProfile: (providerProfileId: string, model: string, transport?: CoauthorTransport) => Promise<TestChatResult>;
}

// ─── Proxy ────────────────────────────────────────────────────────────

export interface ProxyRuntimeApi {
	listProxies: () => Promise<ClientProxyRecord[]>;
	getProxy: (proxyId: string) => Promise<ClientProxyRecord>;
	saveProxy: (body: Record<string, unknown>) => Promise<ClientProxyRecord>;
	updateProxy: (proxyId: string, body: Record<string, unknown>) => Promise<ClientProxyRecord>;
	deleteProxy: (proxyId: string) => Promise<void>;
	reorderProxies: (updates: Array<{ id: string; sortOrder: number }>) => Promise<ClientProxyRecord[]>;
	getDefaultProxy: () => Promise<{ defaultProxyId: string | null }>;
	setDefaultProxy: (body: { defaultProxyId: string | null }) => Promise<{ defaultProxyId: string | null }>;
}

// ─── Preset ────────────────────────────────────────────────────────

export interface PresetRuntimeApi {
	listPromptPresets: () => Promise<PromptPresetDto[]>;
	reorderPromptPresets: (updates: Array<{ id: string; sortOrder: number }>) => Promise<PromptPresetDto[]>;
	createPromptPreset: (body: Record<string, unknown> & { name: string }) => Promise<PromptPresetDto>;
	updatePromptPreset: (presetId: string, body: Record<string, unknown>) => Promise<PromptPresetDto>;
	deletePromptPreset: (presetId: string) => Promise<void>;
}

// ─── Import/Export ───────────────────────────────────────────────────

export interface ImportExportRuntimeApi {
	importJson: (body: { fileName: string; jsonText?: string; monolithText?: string; chatId?: string; skipExisting?: boolean; lean?: boolean }) => Promise<ImportResult>;
	importJsonBatch: (body: { items: Array<{ fileName: string; jsonText?: string; monolithText?: string; chatId?: string; skipExisting?: boolean }>; lean?: boolean }) => Promise<BatchImportResult>;
	scanSillyTavernDirectory: (dirPath: string) => Promise<StDirectoryScanResult>;
	importSillyTavernDirectory: (dirPath: string) => Promise<StDirectoryImportResult>;
	/** Streaming variant: yields ImportStreamEvent items (phase/progress/done/
	 *  error) so the route can emit them as SSE for a live progress bar. */
	importSillyTavernDirectoryStream: (dirPath: string) => AsyncGenerator<ImportStreamEvent>;
}

// ─── Asset ───────────────────────────────────────────────────────────

export interface AssetRuntimeApi {
	uploadAsset: (file: File) => Promise<{ assetId: string; url: string }>;
	serveAsset: (assetId: string) => Promise<Response | null>;
}

// ─── AI Assistant ────────────────────────────────────────────────────

export interface AiAssistantRuntimeApi {
	streamAiAssistant: (body: AiAssistantStreamRequest) => AsyncIterable<AiAssistantStreamChunk>;
	countAiAssistantTokens: (body: AiAssistantStreamRequest) => Promise<{ tokens: number; model: string; layerCount: number; messageCount: number; activatedLoreCount: number }>;
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

// ─── Co-Author Skills (filesystem skill libraries) ──────────────────
// CTX-S2: import (multipart files → validated atomic tree under
// <dataDir>/coauthor/skills) + delete one user skill directory.
// CTX-S3: metadata-only catalog (list/read) merging built-in + user roots with
// user precedence. Absolute filesystem paths never leave the server — only the
// portable root-relative manifest path (`<id>/SKILL.md`) is exposed.


export interface CoauthorSkillsRuntimeApi {
	/** Validate + atomically import a skill tree (ordinary files with relative
	 *  paths). Rejects unsafe paths, malformed manifests, and trees with no
	 *  SKILL.md WITHOUT writing anything. Returns the imported skill ids. */
	importSkills: (files: SkillImportFile[]) => Promise<SkillImportResult>;
	/** Delete one top-level user skill directory. A user shadow of a built-in is
	 *  deletable (removes only the user copy); a pure built-in (no user dir) is
	 *  rejected as read-only; unsafe ids and missing ids are rejected. */
	deleteSkill: (id: string) => Promise<{ id: string }>;
	/** Merged metadata-only catalog (built-in + user, user precedence). Malformed
	 *  manifests are surfaced in `errors`, never fatal. */
	listSkills: () => Promise<{ entries: SkillCatalogEntryDto[]; errors: { source: "builtin" | "user"; id: string; reason: string }[] }>;
	/** One catalog entry by id, or `null` if no such skill exists in either root. */
	readSkill: (id: string) => Promise<SkillCatalogEntryDto | null>;
}

// ─── Composite ──────────────────────────────────────────────────────────

/**
 * Aggregate contract between Hono routes and the backend service layer.
 * Each sub-interface is consumed by exactly one route file.
 */
// ─── Insights — Objective Tracker (INSIGHTS_PLAN INS-4) ──────────────────
// Manual actions return directly; automatic completion is delivered through a
// target-scoped join rather than SSE or a whole-session snapshot.

export interface InsightsRuntimeApi {
	refreshInsightsCompletion: (chatId: string, body: { target: { branchId: string; messageId: string; variantId?: string } }, signal?: AbortSignal) => Promise<InsightsCompletionPatchResponse>;
	generateObjectiveTasks: (chatId: string, body: { providerProfileId?: string; model?: string }, signal?: AbortSignal) => Promise<ConfigPatchResponse>;
	checkObjectiveCompletion: (chatId: string, body: { providerProfileId?: string; model?: string }, signal?: AbortSignal) => Promise<ConfigPatchResponse>;
	addObjectiveTask: (chatId: string, body: { description: string }) => Promise<ConfigPatchResponse>;
	updateObjectiveTask: (chatId: string, taskId: string, body: { description?: string; status?: ObjectiveTaskStatus }) => Promise<ConfigPatchResponse>;
	reorderObjectiveTasks: (chatId: string, body: { taskIds: string[] }) => Promise<ConfigPatchResponse>;
	deleteObjectiveTask: (chatId: string, taskId: string) => Promise<ConfigPatchResponse>;
	setObjectiveMode: (chatId: string, body: { mode: ObjectiveMode }) => Promise<ConfigPatchResponse>;
	updateObjectiveLongTermGoal: (chatId: string, body: { description?: string; status?: ObjectiveTaskStatus }) => Promise<ConfigPatchResponse>;
	addObjectiveShortTermGoal: (chatId: string, body: { description: string }) => Promise<ConfigPatchResponse>;
	updateObjectiveShortTermGoal: (chatId: string, goalId: string, body: { description?: string; status?: ObjectiveTaskStatus }) => Promise<ConfigPatchResponse>;
	deleteObjectiveShortTermGoal: (chatId: string, goalId: string) => Promise<ConfigPatchResponse>;
	selectObjectiveShortTermGoal: (chatId: string, body: { goalId: string }) => Promise<ConfigPatchResponse>;
	updateObjectiveConfig: (chatId: string, body: {
		autoCheckFrequency?: number;
		contextWindow?: number;
		injectionDepth?: number;
		generatePrompt?: string;
		checkPrompt?: string;
		injectPrompt?: string;
		useChatModel?: boolean;
		providerProfileId?: string | null;
		model?: string | null;
	}) => Promise<ConfigPatchResponse>;
	setObjectiveDescription: (chatId: string, body: { objectiveDescription: string }) => Promise<ConfigPatchResponse>;
	// ─── Scene Tracker (SCENE_TRACKER_PLAN SCN-9) — immutable variant ownership ──
	generateScene: (chatId: string, body: { target: { branchId: string; messageId: string; variantId: string } }, signal?: AbortSignal) => Promise<SceneTargetResponse>;
	editScene: (chatId: string, body: { target: { branchId: string; messageId: string; variantId: string }; sceneState: Record<string, unknown> }) => Promise<SceneTargetResponse>;
	deleteScene: (chatId: string, body: { target: { branchId: string; messageId: string; variantId: string } }) => Promise<SceneTargetResponse>;
	cancelScene: (chatId: string, body: { target: { branchId: string; messageId: string; variantId: string } }) => { target: { chatId: string; branchId: string; messageId: string; variantId: string }; cancelled: true };
	getSceneStatus: (chatId: string, body: { target: { branchId: string; messageId: string; variantId: string } }) => Promise<SceneStatusResponse>;
	previewScene: (chatId: string, body: { target: { branchId: string; messageId: string; variantId: string }; config: SceneTrackerConfig }, signal?: AbortSignal) => Promise<ScenePreviewResponse>;
	// ─── Scene Tracker history backfill (SCENE_TRACKER_PLAN SCN-14) ───────────
	startSceneBackfill: (chatId: string, mode: string) => Promise<SceneBackfillStatusResponse>;
	getSceneBackfillStatus: (chatId: string, runId: string) => Promise<SceneBackfillStatusResponse>;
	cancelSceneBackfill: (chatId: string, runId: string) => { runId: string; cancelled: true };
	retrySceneBackfill: (chatId: string, runId: string) => Promise<SceneBackfillStatusResponse>;
}

// ─── Dice (DICE_SYSTEM_BACKEND_PLAN, B8) ────────────────────────────────────

export interface DiceRuntimeApi {
	getDefinitions: (chatId: string) => Promise<{ scripts: DiceDefinitionsResponse["scripts"] }>;
	getPending: (chatId: string, branchId: string) => Promise<DicePendingState>;
	roll: (chatId: string, body: { scriptId: string; checkId: string; actorType: DiceActorType; actorId: string; mode: DiceMode; requestId: string }) => Promise<DiceRollSnapshot>;
	removeRoll: (chatId: string, rollId: string) => Promise<void>;
	clearLane: (chatId: string, branchId: string) => Promise<void>;
	setIncluded: (chatId: string, rollId: string, included: boolean) => Promise<void>;
	chooseFinal: (chatId: string, rollId: string, attemptId: string) => Promise<void>;
}

// ─── Experience (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 3 / IR-32) ────────

import type {
	ExperienceSessionView,
	ExperienceProjection,
	ExperienceQueuedAttachmentView,
	TurnAwait,
} from "../../domain/interactive/experience-service.js";
import type { ExperienceReportStatus } from "../../domain/interactive/experience-report-service.js";
import type { RecalculationPreview } from "../../domain/interactive/experience-replay-service.js";
import type {
	ExperienceTestRunData,
	ExperienceTestRunInput,
	ExperienceTestSimulateData,
	ExperienceTestSimulateInput,
} from "../../domain/interactive/experience-tester.js";
import type {
	ExperiencePlaygroundAdvanceInput,
	ExperiencePlaygroundData,
	ExperiencePlaygroundStartInput,
} from "../../domain/interactive/experience-playground.js";
import type {
	ExperienceChatConfigRow,
	ExperienceVisualRow,
	ExperienceEffectRow,
} from "@vibe-tavern/db";
import type {
	ExperienceActionDescriptor,
	ExperienceEvent,
} from "@vibe-tavern/domain";

/** A session response: authoritative session metadata plus the projected view
 *  for the requesting viewer. The adapter shapes this from the service's
 *  {@link ExperienceSessionView} + {@link ExperienceProjection}. Never includes
 *  hidden state for other seats. */
export type ExperienceSessionResponse = ExperienceSessionView & { view: ExperienceProjection };

/** Action-round response: the session + projected view after one submitted
 *  action AND any auto-resolved script seats, plus the emitted events and whose
 *  turn is next. */
export type ExperienceActionResponse = ExperienceSessionResponse & {
	events: ExperienceEvent[];
	await: TurnAwait;
};

/** Effect-run response: the terminal effect row + whether its result was
 *  delivered into the reducer (false on stale completion — the session advanced
 *  past the originating revision, so the effect stays succeeded-but-undelivered).
 *  When delivered, the post-feed-back session + projected view are included. */
export interface ExperienceEffectRunResponse {
	effect: ExperienceEffectRow;
	delivered: boolean;
	/** Present when this path did NOT run the effect because the host owns it:
	 *  `timer` effects are scheduler-driven (fix step 2c) — the route answers
	 *  202 and the row stays whatever the scheduler made it. */
	hostScheduled?: boolean;
	/** Machine-readable failure reason when status is `failed`. */
	error?: string;
	session?: ExperienceSessionResponse;
}

/** Privacy-safe queued-attachment response (IR-70A). `null` when the session
 *  has no current queued (unbound) attachment. The {@link
 *  ExperienceQueuedAttachmentView} DTO is the attachment row minus its hidden
 *  checkpoint — never carry or derive from `hiddenStateCheckpointJson`. */
export type ExperienceQueuedAttachmentResponse = ExperienceQueuedAttachmentView | null;

// ─── IR-70D: Context status + prompt-override DTOs ──────────────────────────

/** Privacy-safe context-bundle status (IR-70D). Strips all payload fields
 *  (variantsJson, compactSummaryJson, character/persona snapshots, source
 *  hashes) — only session-scoped metadata + provider/model/source ids (bare
 *  provenance pointers, never content). */
export interface ExperienceContextStatusDto {
  sessionId: string;
  mode: import("@vibe-tavern/domain").ExperienceContextMode;
  branchFrontierRevision: number | null;
  messageFrontierPosition: number | null;
  providerProfileId: string | null;
  modelId: string | null;
  sourceCharacterId: string | null;
  sourceChatId: string | null;
  sourcePersonaId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One prompt-override layer — scope, content, optional characterId, and
 *  timestamps. A null layer means no override is persisted for that scope. */
export interface ExperiencePromptOverrideDto {
  scope: 'global' | 'character';
  content: string;
  characterId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Both independent prompt-override layers (IR-70D). The setup UI edits each
 *  layer independently — never collapse to only the effective winner here. */
export interface ExperiencePromptOverridesResponse {
  global: ExperiencePromptOverrideDto | null;
  character: ExperiencePromptOverrideDto | null;
}

export interface ExperienceRuntimeApi {
	// ── Config (the config-driven setup source) ──
	getExperienceConfig: (chatId: string) => Promise<ExperienceChatConfigRow>;
	updateExperienceConfig: (chatId: string, body: {
		enabled?: boolean;
		scriptId?: string | null;
		visualId?: string | null;
		contextSourceCharacterId?: string | null;
		contextSourceChatId?: string | null;
		contextSourcePersonaId?: string | null;
		capabilityGrants?: import("@vibe-tavern/domain").ExperienceCapability[];
		contextMode?: import("@vibe-tavern/domain").ExperienceContextMode;
		launcherVisible?: boolean;
	}) => Promise<ExperienceChatConfigRow>;

	// ── Visual resources ──
	listExperienceVisuals: (scopeType: string, ownerId?: string) => Promise<ExperienceVisualRow[]>;
	getExperienceVisual: (id: string) => Promise<ExperienceVisualRow | null>;
	createExperienceVisual: (body: {
		name: string;
		source: string;
		apiVersion: number;
		compatibleManifestIds?: string[];
		scopeType?: string;
		characterId?: string | null;
	}) => Promise<ExperienceVisualRow>;
	updateExperienceVisual: (id: string, patch: {
		name?: string;
		source?: string;
		apiVersion?: number;
		compatibleManifestIds?: string[];
	}) => Promise<ExperienceVisualRow>;
	deleteExperienceVisual: (id: string) => Promise<void>;

	// ── Session lifecycle ──
	startExperienceSession: (chatId: string, body: {
		branchId: string;
		settings?: unknown;
		participants: import("@vibe-tavern/domain").ExperienceParticipant[];
	}) => Promise<ExperienceSessionResponse>;
	getExperienceSession: (sessionId: string) => Promise<ExperienceSessionResponse>;
	/** Branch-scoped active-session discovery (IR-70A): resolve the branch's
	 *  active session and project it for the human viewer. Returns the SAME
	 *  response shape as {@link getExperienceSession}. */
	getActiveExperienceSession: (chatId: string, branchId: string) => Promise<ExperienceSessionResponse>;
	/** Canonical explicit user finish: terminal snapshot is atomically queued.
	 *  `quiet` (pos 2) ends the session WITHOUT any public report card and
	 *  returns null. */
	endExperienceSession: (sessionId: string, body: { expectedRevision: number; quiet?: boolean }) => Promise<ExperienceQueuedAttachmentResponse>;
	/** Restart as a NEW match on the same branch (lobby report LB-2/LB-3):
	 *  fresh session id under a new seed; omitted override fields fall back to
	 *  the source session's frozen snapshots. */
	restartExperienceSession: (sessionId: string, body: { settings?: unknown; participants?: import("@vibe-tavern/domain").ExperienceParticipant[] }) => Promise<ExperienceSessionResponse>;
	submitExperienceAction: (sessionId: string, body: import("@vibe-tavern/domain").ExperienceAction, signal?: AbortSignal) => Promise<ExperienceActionResponse>;

	// ── Per-viewer projection reads ──
	getExperienceView: (sessionId: string, participantId?: string) => Promise<ExperienceProjection>;
	getExperienceActions: (sessionId: string, participantId?: string) => Promise<ExperienceActionDescriptor[]>;

	// ── Queued-attachment read (IR-70A) ──
	/** Read the session's current queued attachment through the privacy-safe DTO,
	 *  or `null` when none is queued. Never includes hidden checkpoint state. */
	getExperienceQueuedAttachment: (sessionId: string) => Promise<ExperienceQueuedAttachmentResponse>;
	/** Explicit Queue / Add later at the exact client revision. */
	queueExperienceReport: (sessionId: string, body: { expectedRevision: number }) => Promise<ExperienceQueuedAttachmentView>;
	/** Privacy-safe server report status and exact validated-public-event count. */
	getExperienceReportStatus: (sessionId: string) => Promise<ExperienceReportStatus>;

	// ── Replay ──
	undoExperienceSession: (sessionId: string, body: { targetRevision: number }) => Promise<ExperienceActionResponse>;
	previewExperienceRecalculation: (sessionId: string, body: { rulesCode: string }) => Promise<RecalculationPreview>;

	// ── Effects (run + explicit retry; further resolve logic is Wave 4) ──
	getExperienceEffects: (sessionId: string) => Promise<ExperienceEffectRow[]>;
	runExperienceEffect: (effectId: string, signal?: AbortSignal) => Promise<ExperienceEffectRunResponse>;
	/** Explicit user retry: a failed/cancelled/unknown effect returns to `pending`
	 *  (attemptCount+1, error cleared); the host runner owns re-running it —
	 *  this never runs the effect. Typed 404 for a missing effect, 409 when the
	 *  current status is not retryable. */
	retryExperienceEffect: (effectId: string) => Promise<ExperienceEffectRow>;

	// ── Context capture + status (IR-70D) ──
	/** Explicit cancellable context capture. Requires immutable session grant
	 *  `rp_context`. The signal passes through to the compact-summary generation
	 *  so a client disconnect persists nothing and preserves the prior bundle. */
	captureExperienceContext: (sessionId: string, body: { mode?: import("@vibe-tavern/domain").ExperienceContextMode; providerProfileId?: string; model?: string; recentMessageLimit?: number; contextSourceCharacterId?: string | null; contextSourceChatId?: string | null; contextSourcePersonaId?: string | null }, signal?: AbortSignal) => Promise<ExperienceContextStatusDto>;
	/** Read the session's current frozen context-bundle metadata, or null when
	 *  never captured. Returns ONLY session metadata + provider/model ids — never
	 *  payload fields (variants, compact summary, character/persona snapshots, RP
	 *  messages, or provider secrets). Requires `rp_context`. */
	getExperienceContextStatus: (sessionId: string) => Promise<ExperienceContextStatusDto | null>;

	// ── Prompt overrides (IR-70D) ──
	/** Read both independent prompt-override layers (global + current-character)
	 *  through a capability gate. Requires immutable session grant `model`.
	 *  Returns null layers when no override is persisted for that scope; never
	 *  collapses to only the effective winner. */
	getExperiencePromptOverrides: (sessionId: string) => Promise<ExperiencePromptOverridesResponse>;
	/** Write the global prompt-override layer. Requires `model`. Returns the
	 *  updated combined layers so both are always visible after a write. */
	updateExperienceGlobalOverride: (sessionId: string, body: { content: string }) => Promise<ExperiencePromptOverridesResponse>;
	/** Write the current-character prompt-override layer. Requires `model` +
	 *  the session's chat must have a character (otherwise 422). Derives the
	 *  character from the session → chat; never accepts an arbitrary characterId.
	 *  Returns the updated combined layers. */
	updateExperienceCharacterOverride: (sessionId: string, body: { content: string }) => Promise<ExperiencePromptOverridesResponse>;

	// ── Stateless unsaved-source tester (Wave 8 / IR-81B) ──
	/** Drive UNSAVED rules source through the real sandbox/kernel with zero
	 *  persistence and zero chat/session/DB binding: discover + create + project
	 *  + legal actions, then replay an ordered action list with the host managing
	 *  the in-memory revision counter, requestId idempotency, and expectedRevision
	 *  compare-and-swap. Authoritative only over its own ephemeral state. */
	runExperienceTest: (body: ExperienceTestRunInput) => Promise<ExperienceTestRunData>;
	/** Discover + create, then run a bounded automated simulation advancing
	 *  script-controlled seats via the real `choose` until a human/model boundary,
	 *  a terminal status, no legal action, or a host bound is reached. Returns a
	 *  typed stop-reason diagnostic per case. */
	simulateExperienceTest: (body: ExperienceTestSimulateInput) => Promise<ExperienceTestSimulateData>;

	// ── Interactive playground session driver (Wave 8 / IR-84A) ──
	/** Start an in-memory interactive play session: discover + create + project
	 *  + advance leading script seats until the first human/model/idle boundary.
	 *  ZERO durable writes — the session lives in process memory keyed by the
	 *  returned playground session id. Authoritative only over its own ephemeral
	 *  state. Model seats are reported as `awaiting_model` and never invoked. */
	startExperiencePlayground: (body: ExperiencePlaygroundStartInput) => Promise<ExperiencePlaygroundData>;
	/** Apply ONE human action via the real reduce, then advance script seats via
	 *  the real `choose` until the next human/model/idle boundary. Returns this
	 *  turn's state/projection/events/effects/console + bumped revision/status/
	 *  stop-reason. requestId idempotency precedes expectedRevision CAS. */
	advanceExperiencePlayground: (body: ExperiencePlaygroundAdvanceInput) => Promise<ExperiencePlaygroundData>;
	/** Execute ONE timer beat: sleep the oldest pending timer's `afterMs`, then
	 *  feed the tick back through the real reducer (claim-time legality
	 *  re-check; late ticks are dropped, timer stale-drop parity). The client's
	 *  beat loop keys on the response's `pendingTimers`. */
	runExperiencePlaygroundTimer: (body: { readonly playgroundSessionId: string }) => Promise<ExperiencePlaygroundData>;
}

// ─── Experience Copilot (EXPERIENCE_EDITOR_REFACTOR_PLAN, Wave 2 / ER-6) ───────

import type { ExperienceCopilotStreamRequest, ExperienceCopilotStreamEvent } from "../../domain/interactive/copilot/experience-copilot-stream.js";
import type { ExperienceCopilotThreadWire, ExperienceCopilotMessageWire, ExperienceCopilotContextMetrics, ExperienceCopilotContextLink } from "@vibe-tavern/api-contracts";

/** GET/PATCH `/context` response: the thread's last-turn metrics (null before the
 *  first turn) plus its auto-compact toggle (CM-4). */
export interface ExperienceCopilotContextState {
  metrics: ExperienceCopilotContextMetrics | null;
  autoCompact: boolean;
}

/** POST `/compact` response (CM-5): the new digest message + the recomputed
 *  post-compaction metrics (source always "estimate" — the provider only
 *  reports usage on an actual turn; the next turn refines it). */
export interface ExperienceCopilotCompactResult {
  digest: ExperienceCopilotMessageWire;
  metrics: ExperienceCopilotContextMetrics;
}

/** The experience-copilot streaming subsystem — a standalone, editor-embedded
 *  pair-editor (own endpoint, own tables — ER-3) that proposes rules/visual
 *  edits via tools (ER-4) and streams one turn at a time. NOT a chat-mode and
 *  NOT the multi-mode AI-assistant. The stream yields SSE-shaped
 *  `{ event, data }` chunks (same contract as `sendMessageStream`) so the route
 *  emits them verbatim through `streamSSE`. */
export interface ExperienceCopilotRuntimeApi {
	/** Stream one copilot turn for a thread. Loads the thread context, assembles
	 *  the prompt (ER-5), builds the tools (ER-4), streams via `streamText`, and
	 *  yields SSE events (`text-delta`, `reasoning-delta`, `tool-call`,
	 *  `tool-result`, `finish`, `error`). Persists the turn (user message + tool
	 *  calls/results + final assistant text) to the ER-3 store. */
	experienceCopilotStream: (threadId: string, body: Omit<ExperienceCopilotStreamRequest, "threadId">, signal?: AbortSignal) => AsyncGenerator<ExperienceCopilotStreamEvent>;

	/** The single active (unarchived) thread for a script, or null. Delegates to
	 *  the ER-3 store's `getActive`. */
	experienceCopilotGetActive: (scriptId: string) => Promise<ExperienceCopilotThreadWire | null>;

	/** All messages for a thread, oldest → newest. Delegates to the ER-3 store's
	 *  `listMessages`. */
	experienceCopilotListMessages: (threadId: string) => Promise<ExperienceCopilotMessageWire[]>;

	/** Archive the current active thread (if any) and create a fresh active one.
	 *  Delegates to the ER-3 store's `startNewSession` (single-tx archive-then-
	 *  insert). */
	experienceCopilotStartNewSession: (scriptId: string, title?: string) => Promise<ExperienceCopilotThreadWire>;

	/** All sessions (active + archived) for a script, newest first. Delegates
	 *  to the ER-3 store's `listSessions`. */
	experienceCopilotListSessions: (scriptId: string) => Promise<ExperienceCopilotThreadWire[]>;

	/** Resume an archived session (archiving its active sibling, if any), or a
	 *  no-op when it is already active. Delegates to the ER-3 store's
	 *  `activate`. Returns null when the thread does not exist. */
	experienceCopilotActivate: (sessionId: string) => Promise<ExperienceCopilotThreadWire | null>;

	/** Archive a single session (idempotent). Delegates to the ER-3 store's
	 *  `archive`. Returns null when the thread does not exist. */
	experienceCopilotArchive: (sessionId: string) => Promise<ExperienceCopilotThreadWire | null>;
	/** Rename a session (trim; empty title clears back to the auto-numbered
	 *  fallback). Returns the updated wire thread, or null when not found. */
	experienceCopilotRenameSession: (
		sessionId: string,
		title: string,
	) => Promise<ExperienceCopilotThreadWire | null>;

	/** Read a thread's last-turn context metrics + auto-compact toggle (CM-4).
	 *  `metrics` is null before the first turn. */
	experienceCopilotGetContext: (threadId: string) => Promise<ExperienceCopilotContextState>;

	/** Toggle the thread's auto-compact flag (CM-4). Returns the full context
	 *  state (`{ metrics, autoCompact }`) so the client can replace its local copy. */
	experienceCopilotPatchContext: (threadId: string, body: { autoCompact?: boolean }) => Promise<ExperienceCopilotContextState>;

	// CX-4: pinned-context links — GET reads, set is a full replace (the client computes add/remove).
	experienceCopilotGetContextLinks: (threadId: string) => Promise<ExperienceCopilotContextLink[]>;
	experienceCopilotSetContextLinks: (threadId: string, links: ExperienceCopilotContextLink[]) => Promise<ExperienceCopilotContextLink[]>;

	/** Manually compact a thread (CM-5): LLM-summarize everything older than the
	 *  keep-window into a new `role: "digest"` message (anchor in `toolCallId`).
	 *  `providerProfileId`/`model` are required when the thread has no last-used
	 *  pair. Rejects 400 when there is nothing to compact; 409 when a compaction
	 *  is already in-flight; provider errors surface as 502 via the global handler. */
	experienceCopilotCompact: (threadId: string, body: { providerProfileId?: string; model?: string }, signal?: AbortSignal) => Promise<ExperienceCopilotCompactResult>;
}

/** Copilot profile CRUD (EXPERIENCE_COPILOT_PROFILES_PLAN, Wave 3). The
 *  built-in "Experience Authoring" seed (id "builtin") is READ-ONLY — update /
 *  delete reject it with a 400. */
export interface CopilotProfileRuntimeApi {
	/** Built-in seed first, then user profiles in store order. */
	listCopilotProfiles: () => Promise<import("@vibe-tavern/api-contracts").CopilotProfile[]>;
	createCopilotProfile: (input: import("@vibe-tavern/api-contracts").CopilotProfileCreate) => Promise<import("@vibe-tavern/api-contracts").CopilotProfile>;
	updateCopilotProfile: (id: string, input: import("@vibe-tavern/api-contracts").CopilotProfileUpdate) => Promise<import("@vibe-tavern/api-contracts").CopilotProfile>;
	deleteCopilotProfile: (id: string) => Promise<void>;
}

export interface RuntimeApi {
	bootstrap: BootstrapRuntimeApi["bootstrap"];
	chat: ChatRuntimeApi;
	character: CharacterRuntimeApi & CharacterAssetRuntimeApi;
	persona: PersonaRuntimeApi;
	lorebook: LorebookRuntimeApi;
	script: ScriptRuntimeApi;
	provider: ProviderRuntimeApi;
	proxy: ProxyRuntimeApi;
	preset: PresetRuntimeApi;
	importExport: ImportExportRuntimeApi;
	asset: AssetRuntimeApi;
	coauthorSkills: CoauthorSkillsRuntimeApi;
	/** Copilot skills (CP-5) — same wire contract as coauthorSkills, different roots. */
	copilotSkills: CoauthorSkillsRuntimeApi;
	aiAssistant: AiAssistantRuntimeApi;
	settings: SettingsRuntimeApi;
	mobileAccess: MobileAccessRuntimeApi;
	insights: InsightsRuntimeApi;
	dice: DiceRuntimeApi;
	experience: ExperienceRuntimeApi;
	experienceCopilot: ExperienceCopilotRuntimeApi;
	copilotProfiles: CopilotProfileRuntimeApi;
}
