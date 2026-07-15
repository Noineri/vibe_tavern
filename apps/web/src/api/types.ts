/**
 * Frontend-specific view types for the API client layer.
 *
 * These are NOT DB types — they represent the wire format the frontend
 * receives and normalizes. DB/domain types live in @vibe-tavern/domain
 * and @vibe-tavern/db.
 */
import type { Chat, ChatBranch, ChatId, CharacterId, Message, MessageVariant } from "@vibe-tavern/domain";
import type { AssemblePromptResponse, PromptPresetDto, PromptTraceRecordDto } from "@vibe-tavern/domain";
import type { SceneTrackerConfig, SceneTrackerConfigPatch, SceneTrackerRecord } from "@vibe-tavern/domain";

// Wire-format output types shared with the backend (single source of truth in
// @vibe-tavern/api-contracts). Two are imported under local aliases that the
// frontend has historically used: ProviderProfileRecord (canonical:
// ClientProviderProfileRecord) and CachedModelsRecord (canonical:
// CachedProviderModelsRecord). Defining these in a shared package makes drift
// a compile error instead of a silent runtime bug (see wire-types.ts).
import type {
	ClientProviderProfileRecord as ProviderProfileRecord,
	CachedProviderModelsRecord as CachedModelsRecord,
	FavoriteProviderModelRecord,
	ProviderModelSettingsRecord,
	PersonaRecord,
	ChatListItem,
} from "@vibe-tavern/api-contracts";
export type {
	ProviderProfileRecord,
	CachedModelsRecord,
	FavoriteProviderModelRecord,
	ProviderModelSettingsRecord,
	PersonaRecord,
	ChatListItem,
};

// ─── Chat ─────────────────────────────────────────────────────────────

export interface AppMessage extends Message {
  variants: MessageVariant[];
  selectedVariantIndex: number | null;
  modelId: string | null;
  /** Active Scene record — mirrors the currently selected variant, swapped
   *  locally on selection (no fetch). Null when the selected variant has none. */
  sceneTracker: SceneTrackerRecord | null;
  coauthorModuleId?: string | null;
  coauthorSkillId?: string | null;
  attachments?: { id: string; assetId: string; type: string; name?: string; mimeType?: string; sizeBytes?: number; description?: string | null }[];
}

export interface AutoSummaryConfig {
  enabled: boolean;
  everyN: number;
  useChatModel: boolean;
  excludeSummarized: boolean;
  providerProfileId?: string;
  model?: string;
}

/** Per-chat Insights toggles + nested Scene Tracker config (INSIGHTS_PLAN / SCENE_TRACKER_PLAN). */
export interface InsightsConfig {
  objectiveEnabled: boolean;
  trackerEnabled: boolean;
  /** Scene Tracker per-chat config; absent on old chats (normalized to defaults at read). */
  tracker?: SceneTrackerConfig;
}

/** PATCH body for `updateInsightsConfig`: toggles + an optional partial tracker config (deep-merged server-side). */
export interface InsightsConfigPatch {
  objectiveEnabled?: boolean;
  trackerEnabled?: boolean;
  tracker?: SceneTrackerConfigPatch;
}

/** Objective task status (mirrors domain OBJECTIVE_TASK_STATUS). */
export type ObjectiveTaskStatus = "pending" | "active" | "completed" | "abandoned";

/** A single task in the objective route (flat ordered list). */
export interface ObjectiveTask {
  id: string;
  description: string;
  status: ObjectiveTaskStatus;
}

/** The full objective state for a chat. Stored as JSON in chats.insights_objective_state_json; sent to the frontend as a freeform object on activeChat.insightsObjectiveState. Empty `{}` when unused. */
export interface ObjectiveState {
  objectiveDescription: string;
  tasks: ObjectiveTask[];
  autoCheckFrequency: number;
  /** Internal persisted count of qualifying assistant events since the last completed auto-check. */
  autoCheckEventCount: number;
  contextWindow: number;
  injectionDepth: number;
  generatePrompt: string;
  checkPrompt: string;
  injectPrompt: string;
  useChatModel: boolean;
  providerProfileId: string | null;
  model: string | null;
}

export interface InsightsCompletionTarget {
  branchId: string;
  messageId: string;
  /** Immutable variant id. Present when Scene-aware — the refresh joins the
   *  exact variant's Scene job concurrently with Objective and returns a scoped
   *  message patch. Absent for the Objective-only refresh (no message patch). */
  variantId?: string;
}

export interface InsightsCompletionPatchResponse {
  target: InsightsCompletionTarget & { chatId: string };
  patch: {
    objectiveState?: ObjectiveState;
    message?: AppMessage;
  };
}

/** Non-persisting Scene preview (SCN-11): the scene state a DRAFT config would
 *  produce for the target variant, generated but NOT committed. Drives the
 *  config editor's cancellable trial-run preview. */
export interface ScenePreviewResponse {
  target: InsightsCompletionTarget & { chatId: string };
  /** Transient (never persisted to the variant record). */
  sceneState: Record<string, unknown>;
}

export type ChatGenerationStatus =
  | "idle"
  | "preparing"
  | "waiting_full"
  | "streaming"
  | "aborting"
  | "cancelled"
  | "failed";

// ─── Snapshot element types ────────────────────────────────────────────
//
// Named element shapes used by AppSnapshot, the snapshot store, and build
// mode. Named (not inline + indexed-access) so that making AppSnapshot's
// fields optional (absence pipeline) does NOT leak `| undefined` into every
// consumer via AppSnapshot["…"]. The store holds these as `T | null`
// (concrete value or null, never "absent"); absence exists only on the wire.

export interface AppCharacter {
  id: string;
  name: string;
  description: string;
  scenario: string;
  systemPrompt: string;
  subtitle: string;
  firstMessage: string | null;
  mesExample: string | null;
  mesExampleMode: string;
  mesExampleDepth: number;
  alternateGreetings: string[];
  postHistoryInstructions: string | null;
  creatorNotes: string | null;
  depthPrompt: string | null;
  depthPromptDepth: number | null;
  depthPromptRole: string | null;
  tags: string[];
  avatarAssetId: string | null;
  avatarFullAssetId: string | null;
  avatarCropJson: string | null;
  /** Folder-resident avatar extension (CFS migration). Null = legacy flat avatar or none. */
  avatarExt: string | null;
  /** Folder-resident FULL avatar extension. Null = no separate full (thumbnail is itself uncropped). */
  avatarFullExt: string | null;
  personalitySummary: string | null;
  // Media gallery / avatar-appearance prompt injection (MEDIA_GALLERY). Mirrors
  // the backend CharacterRecord — backend always sends these (required), so no
  // normalize-default is needed (same as avatarExt).
  includeGalleryInPrompt: boolean;
  includeAvatarInPrompt: boolean;
  avatarDescription: string | null;
  /** bumped on every avatar upload; used as ?v= cache-buster (immutable cache). */
  updatedAt: string;
}

/**
 * Alias of `PersonaRecord` (defined in the Persona section below) — the
 * canonical persona shape on the frontend. Kept as a named alias for import
 * stability across snapshot/consumer sites (AppSnapshot.persona, selectors,
 * hooks). See `resolveEntityAvatarUrl` for the `updatedAt` cache-bust use.
 */
export type AppPersona = PersonaRecord;

export interface AppCharacterEntry {
  id: string;
  name: string;
  subtitle: string;
  tags: string[];
  avatarAssetId: string | null;
  avatarFullAssetId: string | null;
  avatarCropJson: string | null;
  avatarExt: string | null;
  avatarFullExt: string | null;
  /** bumped on every avatar upload; used as ?v= cache-buster (immutable cache). */
  updatedAt: string;
}

/** A character version (VTF Phase 3 folder-snapshot branching). Meta only on the wire. */
export interface AppCharacterVersion {
  id: string;
  characterId: string;
  title: string;
  isActive: boolean;
  createdAt: string;
}

// ─── Snapshot ──────────────────────────────────────────────────────────

/*
 * AppSnapshot is the wire shape the frontend receives from the backend.
 *
 * EVERY field is optional: a given endpoint returns only the fields its
 * consumer needs (Phase 3.4.2 per-endpoint response builders). Absence is
 * meaningful — it means "this endpoint did not touch this data, so preserve
 * whatever the store already holds". An explicit `null` (where allowed) or
 * `[]` means "the server actively set this to empty".
 *
 * The absence pipeline (normalizeSnapshot → ingestSnapshot) distinguishes
 * absent (preserve) from present-empty (replace): normalizeSnapshot passes
 * absent fields through untouched, and ingestSnapshot guards each field with
 * a presence check ("x" in snapshot / Array.isArray) before writing.
 *
 * Today the backend still sends full snapshots from getSnapshot(), so every
 * bootstrap/mutation response populates all fields. The optional types exist
 * so tsc enforces presence-aware reads as endpoint-scoped responses land.
 *
 * NOTE: the backend's SessionSnapshot (services/api/src/session/session-
 * runtime.ts) is the parallel type with REQUIRED fields — it is truthful
 * there because getSnapshot() always returns full. The two are decoupled by
 * the explicit `unwrapRpc<AppSnapshot>` cast in apps/web/src/api/*.ts.
 */
export interface AppSnapshot {
  /** Sidebar: ordered list of chats with metadata. Absent → preserve. */
  chats?: ChatListItem[];
  /** All known characters (sidebar, build mode). Absent → preserve. */
  allCharacters?: AppCharacterEntry[];
  /** Active chat metadata (title, settings, greetingIndex, etc). Absent → preserve. */
  activeChat?: Chat & { summary?: string; messageHistoryLimit?: number; autoSummaryConfig?: AutoSummaryConfig; insightsConfig?: InsightsConfig; insightsObjectiveState?: ObjectiveState };
  /** Currently active branch. Absent → preserve. */
  activeBranch?: ChatBranch;
  /** All branches for the active chat. Absent → preserve. */
  branches?: ChatBranch[];
  /** Messages for the active branch, with variant data. Absent → preserve (chat switching clears via clearMessages()). */
  messages?: AppMessage[];
  /** Ranged summaries for the active branch. Absent → preserve. */
  summaries?: Array<{ id: string; kind: string; summary: string }>;
  /** Latest prompt trace for the active branch (null if no traces). Absent → preserve. */
  promptTrace?: PromptTraceRecordDto | null;
  /** Live context preview (Phase 3.1 decouples this from prompt trace). Absent → preserve. */
  contextPreview?: AssemblePromptResponse | null;
  /** Active character record. Absent → preserve. */
  character?: AppCharacter;
  /** Active persona record (null if no persona set). Absent → preserve. */
  persona?: AppPersona | null;
}

// ─── Settings ──────────────────────────────────────────────────────────

export interface UiSettingsRecord {
  id: string;
  theme: string;
  chatFontSize: number;
  uiFontSize: number;
  messageWidth: number;
  language: string;
  activePromptPresetId: string | null;
  aiAssistantProviderId: string | null;
  aiAssistantModelName: string | null;
  updatedAt: string;
}

// ─── Chat Summary ──────────────────────────────────────────────────────

export interface ChatSummaryRecord {
  id: string;
  chatId: string;
  branchId: string;
  label: string;
  content: string;
  summarizedFrom: number;
  summarizedTo: number;
  includeInContext: boolean;
  excludeSummarized: boolean;
  source: "manual" | "auto";
  sortOrder: number;
  contentHash: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Provider ──────────────────────────────────────────────────────────

export interface ProviderModelOption {
  id: string;
  label: string;
  contextLength?: number;
  capabilities?: { vision?: boolean; reasoning?: boolean; tools?: boolean; webSearch?: boolean; premium?: boolean };
  supportsTools: boolean;
  pricing?: { input?: number; output?: number };
  description?: string;
}

export interface TestChatResponse {
  success: boolean;
  reply?: string;
  error?: string;
}

// ─── Lorebook ──────────────────────────────────────────────────────────

export interface LoreEntryRecord {
  id: string;
  lorebookId: string;
  title: string;
  content: string;
  keys: string[];
  secondaryKeys: string[];
  logic: string;
  position: string;
  depth: number;
  priority: number;
  stickyWindow: number;
  cooldownWindow: number;
  delayWindow: number;
  enabled: boolean;
  constant: boolean;
  probability: number;
  ignoreBudget: boolean;
  role: string;
  groupName: string;
  groupWeight: number;
  prioritizeInclusion: boolean;
  useGroupScoring: boolean;
  excludeRecursion: boolean;
  preventRecursion: boolean;
  delayUntilRecursion: boolean;
  recursionLevel: number;
  scanDepthOverride: number | null;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  characterFilter: Array<{ id: string | null; name: string }>;
  characterFilterExclude: boolean;
  matchSources: string[];
  sortOrder: number;
}

export interface LorebookRecord {
  id: string;
  name: string;
  description: string;
  scopeType: string;
  characterId: string | null;
  personaId: string | null;
  chatId: string | null;
  scanDepth: number;
  tokenBudget: number;
  tokenBudgetPercent: number | null;
  recursiveScanning: boolean;
  enabled: boolean;
}

export interface LorebookLinkRecord {
  lorebookId: string;
  targetType: "character" | "persona";
  targetId: string;
}

// ─── Scripts ───────────────────────────────────────────────────────────

export interface ScriptRecord {
  id: string;
  name: string;
  description: string;
  code: string;
  scopeType: string;
  characterId: string | null;
  personaId: string | null;
  chatId: string | null;
  enabled: boolean;
  sortOrder: number;
}

export interface ScriptLinkRecord {
  scriptId: string;
  targetType: "character" | "persona";
  targetId: string;
}

// ─── Import ────────────────────────────────────────────────────────────

export interface ImportJsonResponse {
  activeChatId: ChatId;
  // Absent on the lean mass-import path (server skips the O(N²) getSnapshot).
  // Single-card import always returns a snapshot.
  snapshot?: AppSnapshot;
  // Set on the lean path so the caller can resolve avatar uploads without
  // the snapshot. Absent on the full path (read snapshot.character.id).
  characterId?: CharacterId;
  imported: {
    kind: "character" | "lorebook" | "chat";
    name: string;
    fileName: string;
    warningCount: number;
    warnings: string[];
    attachedToCharacterName?: string;
  };
}

// ─── AI Assistant ──────────────────────────────────────────────────────

export interface AiAssistantChunk {
  type: "text" | "reasoning" | "partial_json" | "error" | "done";
  text?: string;
  json?: Record<string, unknown>;
  error?: string;
}

export type AiAssistantMode = "script" | "lore_entry" | "lore_keys" | "chat_impersonate" | "md_import" | "vision_describe";

export interface AiAssistantRequestBody {
  mode: AiAssistantMode;
  instruction: string;
  existingContent?: string;
  providerProfileId: string;
  model?: string;
  enabledLayers: string[];
  characterIds?: string[];
  personaIds?: string[];
  loreEntryIds?: string[];
  lorebookIds?: string[];
  chatId?: string;
  recentMessageCount?: number;
  existingKeys?: string[];
  existingSecondaryKeys?: string[];
  logic?: string;
  keyTarget?: "primary" | "secondary" | "both";
  maxOutputTokens?: number;
  temperature?: number;
}
