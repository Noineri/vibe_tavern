/**
 * Frontend-specific view types for the API client layer.
 *
 * These are NOT DB types — they represent the wire format the frontend
 * receives and normalizes. DB/domain types live in @vibe-tavern/domain
 * and @vibe-tavern/db.
 */
import type { Chat, ChatBranch, ChatId, Message, MessageVariant, ModelSettingsOverlay } from "@vibe-tavern/domain";
import type { AssemblePromptResponse, PromptPresetDto, PromptTraceRecordDto } from "@vibe-tavern/domain";

// ─── Chat ─────────────────────────────────────────────────────────────

export interface ChatListItem {
  id: ChatId;
  title: string;
  characterId: string;
  characterName: string;
  subtitle: string;
  activeBranchLabel: string;
  messageCount: number;
  updatedAt: string;
}

export interface AppMessage extends Message {
  variants: MessageVariant[];
  selectedVariantIndex: number | null;
  modelId: string | null;
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
  avatarAssetId: string | null;
  avatarFullAssetId: string | null;
  avatarCropJson: string | null;
  avatarExt: string | null;
  avatarFullExt: string | null;
  /** bumped on every avatar upload; used as ?v= cache-buster (immutable cache). */
  updatedAt: string;
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
  activeChat?: Chat & { summary?: string; messageHistoryLimit?: number; autoSummaryConfig?: AutoSummaryConfig };
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

// ─── Persona ───────────────────────────────────────────────────────────

/** Canonical persona shape — frontend mirror of the backend domain `PersonaRecord`
 *  (services/api/src/domain/persona/persona-runtime.ts). Single source of truth
 *  for persona on the frontend. `updatedAt` is the avatar cache-bust key
 *  (?v= in resolveEntityAvatarUrl), symmetric with CharacterRecord.updatedAt. */
export interface PersonaRecord {
  id: string;
  name: string;
  description: string;
  pronouns: string | null;
  avatarAssetId: string | null;
  avatarFullAssetId: string | null;
  avatarCropJson: string | null;
  avatarExt: string | null;
  avatarFullExt: string | null;
  defaultForNewChats: boolean;
  // Avatar-appearance prompt injection (MEDIA_GALLERY).
  includeAvatarInPrompt: boolean;
  avatarDescription: string | null;
  /** bumped on every persona update; used as ?v= cache-buster (immutable cache). */
  updatedAt: string;
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

export interface ProviderProfileRecord {
  id: string;
  name: string;
  providerPreset: string;
  endpoint: string;
  defaultModel: string | null;
  contextBudget: number | null;
  pinContextBudget: boolean;
  bindPerModel: boolean;
  maxTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  topA: number;
  typicalP: number;
  tfsZ: number;
  repeatLastN: number;
  mirostat: number;
  mirostatTau: number;
  mirostatEta: number;
  dryMultiplier: number;
  dryBase: number;
  dryAllowedLength: number;
  drySequenceBreakers: string[];
  xtcThreshold: number;
  xtcProbability: number;
  frequencyPenalty: number;
  presencePenalty: number;
  repetitionPenalty: number;
  stopSequences: string[];
  logitBias: Array<{ tokenId: number; bias: number; text?: string; sourceText?: string; model?: string }>;
  seed: string | null;
  reasoningEffort: string;
  showReasoning: boolean;
  streamResponse: boolean;
  customSamplers: boolean;
  isActive: boolean;
  visionModel: string | null;
  createdAt: string;
  updatedAt: string;
  hasStoredApiKey: boolean;
  cachedModels?: CachedModelsRecord;
}

export interface CachedModelsRecord {
  models: Array<{
    id: string;
    label: string;
    contextLength?: number;
    capabilities?: { thinking?: boolean; tools?: boolean; vision?: boolean };
  }>;
  cachedAt: string;
}

export interface FavoriteProviderModelRecord {
  id: string;
  providerProfileId: string;
  modelId: string;
  label: string | null;
  contextLength: number | null;
  createdAt: string;
}

/** Per-model sampler/context overlay (frontend mirror of the backend DTO).
 *  Absent fields in `settings` = inherit the profile base. */
export interface ProviderModelSettingsRecord {
  id: string;
  providerProfileId: string;
  modelId: string;
  settings: ModelSettingsOverlay;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderModelOption {
  id: string;
  label: string;
  contextLength?: number;
  capabilities?: { vision?: boolean; reasoning?: boolean; tools?: boolean; webSearch?: boolean; premium?: boolean };
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

// ─── Import ────────────────────────────────────────────────────────────

export interface ImportJsonResponse {
  activeChatId: ChatId;
  snapshot: AppSnapshot;
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
