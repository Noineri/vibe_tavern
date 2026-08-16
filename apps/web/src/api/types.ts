/**
 * Frontend-specific view types for the API client layer.
 *
 * These are NOT DB types — they represent the wire format the frontend
 * receives and normalizes. DB/domain types live in @vibe-tavern/domain
 * and @vibe-tavern/db.
 */
import type { Chat, ChatBranch, ChatId, CharacterId, Message, MessageVariant } from "@vibe-tavern/domain";
import type { AssemblePromptResponse, PromptPresetDto, PromptTraceRecordDto } from "@vibe-tavern/domain";
import type { SceneTrackerConfig, SceneTrackerConfigPatch, SceneTrackerRecord, SceneBackfillErrorEntry, SceneBackfillSummary } from "@vibe-tavern/domain";
import type { DiceActorType, DiceAttempt, DiceCheckDefinition, DiceMode, DiceRollSnapshot, ScriptKind } from "@vibe-tavern/domain";
import type {
	ExperienceActionDescriptor,
	ExperienceContextMode,
	ExperienceEffectRequest,
	ExperienceEvent,
	ExperienceParticipant,
	ExperiencePublicReport,
	ExperienceSessionStatus,
} from "@vibe-tavern/domain";
import type {
	ExperienceChatConfigRow,
	ExperienceEffectRow,
	ExperienceVisualRow,
} from "@vibe-tavern/db";
import type { z } from "zod";

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
	ClientProxyRecord as ProxyRecord,
	PersonaRecord,
	ChatListItem,
	ExperienceActionDto,
	ExperienceDefinitionDto,
	ExperienceFinishRequestDto,
	ExperienceSessionResponseDto,
} from "@vibe-tavern/api-contracts";
// Type-only schema imports: the interactive-runtime request DTOs that the
// contracts index does NOT re-export are derived here via `z.input` of the
// exported schemas — the schema stays the single source of truth, nothing is
// hand-written, and no runtime value enters the browser bundle.
import type {
	experienceConfigUpdateSchema,
	experienceContextCaptureRequestSchema,
	experiencePlaygroundAdvanceRequestSchema,
	experiencePlaygroundStartRequestSchema,
	experiencePromptOverrideContentSchema,
	experienceRecalculateRequestSchema,
	experienceReportQueueRequestSchema,
	experienceStartRequestSchema,
	experienceTestRunRequestSchema,
	experienceTestSimulateRequestSchema,
	experienceUndoRequestSchema,
	experienceVisualCreateSchema,
	experienceVisualUpdateSchema,
	experienceVisualsQuerySchema,
} from "@vibe-tavern/api-contracts";
export type {
	ProviderProfileRecord,
	CachedModelsRecord,
	FavoriteProviderModelRecord,
	ProviderModelSettingsRecord,
	ProxyRecord,
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
  /** Message-owned Dice result snapshots bound to this user message (DICE-F9 /
   *  DICE-F10). The backend `MessageDto` populates it for user messages that
   *  have rolls; `normalizeMessage` spreads the DTO, so the field survives at
   *  runtime even though the domain `Message` base type doesn't declare it.
   *  Absent/undefined on assistant/system messages and on user messages with
   *  no rolls — readers coerce with `?? []`. Immutable historical snapshots. */
  diceRolls?: DiceRollSnapshot[];
}

export interface AutoSummaryConfig {
  enabled: boolean;
  everyN: number;
  useChatModel: boolean;
  excludeSummarized: boolean;
  /** SUMMARY_PRIOR_CONTEXT_PLAN: include preceding summaries as read-only
   *  continuity context so auto-generated summaries are continuation-aware. */
  includePriorSummaries: boolean;
  /** SUMMARY_PRIOR_CONTEXT_PLAN: how many of the most-recent preceding summaries
   *  to include when `includePriorSummaries` is on (count-based user control). */
  maxPriorSummaries: number;
  providerProfileId?: string;
  model?: string;
}

/** Per-chat Insights toggles + nested Scene Tracker config (INSIGHTS_PLAN / SCENE_TRACKER_PLAN). */
export interface InsightsConfig {
  objectiveEnabled: boolean;
  trackerEnabled: boolean;
  /** Dice feature toggle (DICE B9). OFF by default; old chats normalize to
   *  `false` (the backend schema defaults it). When off, no dice UI/prompt. */
  diceEnabled?: boolean;
  /** Dice turn mode (DICE B9): selects the active pending lane. Default
   *  `"normal"` on old chats (backend schema default). */
  diceMode?: DiceMode;
  /** Chat-local Dice script override (DICE_ASSIGNMENT_AND_TRAY_UX_REPORT fix 1).
   *  `null`/absent = inherit (resolver union); an array = use exactly those ids
   *  for this chat. The backend filters disabled/deleted/non-dice ids. */
  diceScriptIds?: string[] | null;
  /** Chat-local per-script actor distribution (Rework R1). `null`/absent = each
   *  check uses its declared actors; a record overrides per script with full
   *  freedom (expand or narrow beyond the script's declared check.actors). */
  diceActorBindings?: Record<string, DiceActorType[]> | null;
  /** Scene Tracker per-chat config; absent on old chats (normalized to defaults at read). */
  tracker?: SceneTrackerConfig;
}

/** PATCH body for `updateInsightsConfig`: toggles + an optional partial tracker config (deep-merged server-side). */
export interface InsightsConfigPatch {
  objectiveEnabled?: boolean;
  trackerEnabled?: boolean;
  /** Dice toggle / mode (DICE B9) — optional partial patch; the canonical
   *  `updateInsightsConfigSchema` already accepts both. */
  diceEnabled?: boolean;
  diceMode?: DiceMode;
  /** Chat-local Dice script override patch (fix 1): absent preserves stored;
   *  `null` returns to inherit; an array sets the explicit chat-local set. */
  diceScriptIds?: string[] | null;
  /** Chat-local actor-distribution patch (Rework R1): absent preserves stored;
   *  `null` clears; a record sets the per-script binding. */
  diceActorBindings?: Record<string, DiceActorType[]> | null;
  tracker?: SceneTrackerConfigPatch;
}

/** Objective Tracker mode (mirrors domain OBJECTIVE_MODE). Absent on legacy snapshots → route. */
export type ObjectiveMode = "route" | "goals";

/** Objective task/goal status (mirrors domain OBJECTIVE_TASK_STATUS). */
export type ObjectiveTaskStatus = "pending" | "active" | "completed" | "abandoned";

/** A single task in the objective route (flat ordered list). */
export interface ObjectiveTask {
  id: string;
  description: string;
  status: ObjectiveTaskStatus;
}

/** Goals mode: the singular enduring goal (no id — one per chat). */
export interface ObjectiveLongTermGoal {
  description: string;
  status: ObjectiveTaskStatus;
}

/** Goals mode: a flat independent near-term goal; same item shape as a route task. */
export type ObjectiveShortTermGoal = ObjectiveTask;

/** The full objective state for a chat. Stored as JSON in chats.insights_objective_state_json; sent to the frontend as a freeform object on activeChat.insightsObjectiveState. Empty `{}` when unused. */
export interface ObjectiveState {
  /** Optional for legacy snapshots; readers normalize absent/unknown to `route`. */
  mode?: ObjectiveMode;
  objectiveDescription: string;
  tasks: ObjectiveTask[];
  longTermGoal?: ObjectiveLongTermGoal | null;
  shortTermGoals?: ObjectiveShortTermGoal[];
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

/** Branch-scoped live context preview (lazy hydration target). The server echoes
 *  the immutable { chatId, branchId } so the client can reject a result that no
 *  longer matches the active branch before caching it. `preview` is null only
 *  when assembly itself fails. */
export interface ContextPreviewResponse {
  target: { chatId: string; branchId: string };
  preview: AssemblePromptResponse | null;
}

/** Non-persisting Scene preview (SCN-11): the scene state a DRAFT config would
 *  produce for the target variant, generated but NOT committed. Drives the
 *  config editor's cancellable trial-run preview. */
export interface ScenePreviewResponse {
  target: InsightsCompletionTarget & { chatId: string };
  /** Transient (never persisted to the variant record). */
  sceneState: Record<string, unknown>;
}

/** Manual Scene mutation response (SCN-12): generate/update/edit/delete all
 *  return the target's refreshed message — the frontend applies the scoped
 *  message patch (never a whole snapshot). `message.sceneTracker` mirrors the
 *  currently selected variant, so a generate/edit that succeeds swaps the
 *  rendered record in place. */
export interface SceneTargetResponse {
  target: InsightsCompletionTarget & { chatId: string };
  message: AppMessage;
}

/** Server-authoritative Scene status (SCN-12): `generating` reflects the target
 *  coordinator (drives the header loading state + edit lock on reload/multi-tab);
 *  `record` is the variant's current canonical record (null when absent). */
export interface SceneStatusResponse {
  target: InsightsCompletionTarget & { chatId: string };
  generating: boolean;
  record: SceneTrackerRecord | null;
}

/** Scene history backfill mode (SCN-14/15). `fill-missing` skips variants that
 *  already carry a current record; `rebuild` regenerates all. Mirrors the domain
 *  `SceneBackfillMode` / `SCENE_BACKFILL_MODE` constants. */
export type SceneBackfillMode = "fill-missing" | "rebuild";

/** Server-authoritative backfill run status (SCN-14/15). The run row owns JOB
 *  state only (manifest/cursor/errors/cancel/summary); canonical Scene records
 *  remain the durable result on the variants. Polled by the client; a reload
 *  reattaches via the persisted runId. Mirrors `SceneBackfillStatusResponse`. */
export interface SceneBackfillStatusResponse {
  runId: string;
  chatId: string;
  mode: SceneBackfillMode;
  status: "pending" | "running" | "completed" | "cancelled" | "failed";
  total: number;
  processed: number;
  current: { messageId: string; variantId: string } | null;
  errors: SceneBackfillErrorEntry[];
  summary: SceneBackfillSummary | null;
  cancelRequested: boolean;
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
  coauthorProviderId: string | null;
  coauthorModelName: string | null;
  /** Optional for compatibility with bootstrap snapshots predating token overrides. */
  coauthorMaxTokens?: number | null;
  coauthorContextBudget?: number | null;
  /** Optional for compatibility with bootstrap snapshots predating the
   *  copilot binding. Null → the copilot shell defaults to the first profile. */
  copilotProviderId?: string | null;
  copilotModelName?: string | null;
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
  /** Runtime contract (DICE_SYSTEM Wave B1). Defaults to `prompt` on legacy rows. */
  scriptKind: ScriptKind;
  scopeType: string;
  characterId: string | null;
  personaId: string | null;
  chatId: string | null;
  enabled: boolean;
  sortOrder: number;
  /** Default visual paired with this experience (interactive scripts only).
   *  Null for non-interactive and pre-existing rows. */
  defaultVisualId: string | null;
  /** Copilot profile assigned to this experience (interactive scripts only).
   *  Soft link; null = use the built-in seed. */
  copilotProfileId: string | null;
}

export interface ScriptLinkRecord {
  scriptId: string;
  targetType: "character" | "persona";
  targetId: string;
}

// ─── Dice ──────────────────────────────────────────────────────────────
//
// Wire types for the chat-scoped Dice API (DICE_SYSTEM_FRONTEND_PLAN, Wave F1).
// The canonical entity shapes (`DiceRollSnapshot`, `DiceAttempt`,
// `DiceCheckDefinition`, the enum types) live in `@vibe-tavern/domain` and are
// re-exported here for import stability; only the response/lane envelopes and
// the thin request shapes are defined locally.

export type { DiceActorType, DiceAttempt, DiceCheckDefinition, DiceMode, DiceRollSnapshot };

/** One pending lane (GET /pending): the server's monotonic revision + its
 *  unbound rolls. Bound message-owned results are NOT part of the lane. */
export interface DiceLaneState {
  revision: number;
  rolls: DiceRollSnapshot[];
}

/** GET /pending response — both lanes keyed by mode. */
export interface DicePendingState {
  normal: DiceLaneState;
  immersive: DiceLaneState;
}

/** One script's resolvable checks (GET /definitions, grouped by script). */
export interface DiceScriptDefinitions {
  scriptId: string;
  scriptLabel: string;
  scriptRevision: number;
  checks: DiceCheckDefinition[];
}

/** GET /definitions response. */
export interface DiceDefinitionsResponse {
  scripts: DiceScriptDefinitions[];
}

/** POST /roll body. The client is server-authoritative: it sends only ids,
 *  actor, mode, and a DB-unique `requestId` idempotency key — NEVER dice faces
 *  or totals (the server rolls). */
export interface DiceRollRequest {
  scriptId: string;
  checkId: string;
  actorType: DiceActorType;
  actorId: string;
  mode: DiceMode;
  requestId: string;
}

/** Optional send commit intent threaded onto stream/non-stream send bodies
 *  (Wave F2). Both fields are present or both absent; omitted ⇒ no-Dice send. */
export interface DiceSendCommitIntent {
  diceMode: DiceMode;
  pendingRevision: number;
}

/** Optional interactive-runtime (experience) attachment commit intent threaded
 *  onto stream/non-stream send bodies (IR-51). All three fields are present or
 *  all absent; omitted ⇒ no-experience send. Carries ONLY identifiers the server
 *  already stored — never raw transcript/events/state. */
export interface ExperienceSendCommitIntent {
  experienceAttachmentId: string;
  experienceQueueRevision: number;
  experienceSessionRevision: number;
}

// ─── Experience (interactive runtime) ───────────────────────────────────────
//
// Wire types for the experience API (INTERACTIVE_RUNTIME_FOUNDATION_PLAN,
// Wave 7 / IR-71A). Canonical entity shapes come from `@vibe-tavern/domain`,
// store row shapes from `@vibe-tavern/db`, and request/response DTOs from
// `@vibe-tavern/api-contracts` (directly re-exported, or derived via `z.input`
// of the exported schema when the contracts index does not re-export the DTO).
// Response envelopes that exist only inside `services/api` (whose package
// exports expose only `AppType` to the browser) are mirrored as local
// interfaces, each documented with its backend authority.

export type {
  ExperienceActionDescriptor,
  ExperienceContextMode,
  ExperienceEvent,
  ExperienceParticipant,
  ExperiencePublicReport,
  ExperienceChatConfigRow,
  ExperienceEffectRow,
  ExperienceVisualRow,
  ExperienceSessionResponseDto,
};

// ── Request bodies (schema-derived; never hand-written) ─────────────────────

/** PUT /config body (partial patch). */
export type ExperienceConfigUpdateRequest = z.input<typeof experienceConfigUpdateSchema>;
/** GET /visuals query (scope + optional owner). */
export type ExperienceVisualsQuery = z.input<typeof experienceVisualsQuerySchema>;
/** POST /visuals body. */
export type ExperienceVisualCreateRequest = z.input<typeof experienceVisualCreateSchema>;
/** PATCH /visuals/:id body. */
export type ExperienceVisualUpdateRequest = z.input<typeof experienceVisualUpdateSchema>;
/** POST /sessions body. `settings`/`participants` are optional on input (the
 *  schema defaults them); participant seats carry the IR-70E pinned
 *  `providerProfileId`/`modelId` for model controllers via the canonical
 *  start-participant schema. */
export type ExperienceStartRequest = z.input<typeof experienceStartRequestSchema>;
/** POST /sessions/:id/actions body. The schema has no defaults, so the
 *  exported DTO IS the input shape. */
export type ExperienceActionRequest = ExperienceActionDto;
/** POST /sessions/:id/end body (`{ expectedRevision }`, strict). */
export type ExperienceFinishRequest = ExperienceFinishRequestDto;
/** POST /sessions/:id/reports/queue body (`{ expectedRevision }`). */
export type ExperienceReportQueueRequest = z.input<typeof experienceReportQueueRequestSchema>;
/** POST /sessions/:id/undo body (`{ targetRevision }`). */
export type ExperienceUndoRequest = z.input<typeof experienceUndoRequestSchema>;
/** POST /sessions/:id/recalculate body (`{ rulesCode }`). */
export type ExperienceRecalculateRequest = z.input<typeof experienceRecalculateRequestSchema>;
/** POST /sessions/:id/context/capture body (strict; IR-70D). */
export type ExperienceContextCaptureRequest = z.input<typeof experienceContextCaptureRequestSchema>;
/** PUT /prompt-overrides/{global|character} body (`{ content }`, strict). */
export type ExperiencePromptOverrideContentRequest = z.input<typeof experiencePromptOverrideContentSchema>;

// ── Responses ────────────────────────────────────────────────────────────────

/** Session response (start / get / branch discovery). Extends the canonical
 * validated DTO with the additional public metadata serialized by the backend's
 * `ExperienceSessionView`; the DTO carries the pinned visual snapshot
 * (visualId/visualSource/visualSourceHash) so IR-73B renders the exact start-
 * pinned source rather than a mutable live re-fetch. The extension adds only
 * the rules revision/hash (the rules SOURCE stays private — only the revision
 * + hash are public, never `rulesSource`). Includes IR-70E participant
 * provider/model assignments through the canonical participant schema. */
export interface ExperienceSessionResponse extends ExperienceSessionResponseDto {
  rulesRevision: number;
  rulesSourceHash: string;
}

/** Per-viewer projected view (GET /view, and the `view` member of every
 *  session response). Indexed off the canonical session DTO so it can never
 *  drift from the wire schema. */
export type ExperienceProjection = ExperienceSessionResponseDto["view"];

/** Whose turn the session awaits after an action round. Local literal union
 *  mirroring `TurnAwait` in services/api `experience-service.ts` (not exported
 *  across the package boundary); structurally aligned with the runtime
 *  contract. */
export type ExperienceTurnAwait = "human" | "model" | "completed" | "idle";

/** Action-round response (POST /actions, POST /undo): the session + projected
 *  view after the applied action AND any auto-resolved script seats, plus the
 *  emitted events and whose turn is next. Mirrors `ExperienceActionResponse`
 *  in services/api `api/contract/runtime-api.ts` (backend-only module). */
export type ExperienceActionResponse = ExperienceSessionResponse & {
  events: ExperienceEvent[];
  await: ExperienceTurnAwait;
};

/** Privacy-safe queued-attachment view (IR-70A): the attachment row MINUS its
 *  hidden checkpoint. Mirrors `ExperienceQueuedAttachmentView` in services/api
 *  `experience-service.ts` (backend-only module); `publicReport` uses the
 *  canonical domain `ExperiencePublicReport`. */
export interface ExperienceQueuedAttachmentView {
  id: string;
  chatId: string;
  branchId: string;
  sessionId: string;
  sessionRevision: number;
  queueRevision: number;
  kind: string;
  /** Parsed public report envelope; null when the stored JSON was malformed. */
  publicReport: ExperiencePublicReport | null;
  rulesSourceHash: string;
  visualSourceHash: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Queued-attachment read (GET /attachment, POST /end): null when the session
 *  has no current queued (unbound) attachment. */
export type ExperienceQueuedAttachmentResponse = ExperienceQueuedAttachmentView | null;

/** Server report status (GET /reports/status). Mirrors `ExperienceReportStatus`
 *  in services/api `experience-report-service.ts` (backend-only module). */
export interface ExperienceReportStatus {
  revision: number;
  reportFrontier: number;
  pendingPublicEventCount: number;
  queuedAttachment: ExperienceQueuedAttachmentView | null;
}

/** One replay checkpoint (recalculation preview). Mirrors `ReplayCheckpoint`
 *  in services/api `experience-replay-service.ts` (backend-only module). */
export interface ExperienceReplayCheckpoint {
  revision: number;
  state: unknown;
  cursor: number;
}

/** Replay outcome discriminated union. Mirrors `ReplayOutcome` in services/api
 *  `experience-replay-service.ts` (backend-only module). */
export type ExperienceReplayOutcome =
  | { ok: true; finalState: unknown; cursor: number; checkpoints: ExperienceReplayCheckpoint[] }
  | {
      ok: false;
      failedAtRevision: number;
      reason: "create_failed" | "illegal_action" | "vm_error";
      message: string;
      partialState: unknown;
    };

/** Recalculation preview (POST /recalculate; safe, no commit). Mirrors
 *  `RecalculationPreview` in services/api `experience-replay-service.ts`
 *  (backend-only module). */
export interface ExperienceRecalculationPreview {
  originalRulesHash: string;
  originalState: unknown;
  originalRevision: number;
  newManifestId: string;
  newRulesHash: string;
  outcome: ExperienceReplayOutcome;
}

/** Effect-run response (POST /effects/:effectId/run). Mirrors
 *  `ExperienceEffectRunResponse` in services/api `api/contract/runtime-api.ts`
 *  (backend-only module): the terminal effect row + whether its result was
 *  delivered into the reducer (false on stale completion), with the post-
 *  feed-back session when delivered. */
export interface ExperienceEffectRunResponse {
  effect: ExperienceEffectRow;
  delivered: boolean;
  /** Present when the host owns this effect's execution (timer effects are
   *  host-scheduled; the route answered 202 and ran nothing). */
  hostScheduled?: boolean;
  /** Machine-readable failure reason when status is `failed`. */
  error?: string;
  session?: ExperienceSessionResponse;
}

/** Privacy-safe context-bundle status (IR-70D; GET /context/status — null when
 *  never captured — and POST /context/capture). Mirrors
 *  `ExperienceContextStatusDto` in services/api `api/contract/runtime-api.ts`
 *  (backend-only module): ONLY session-scoped metadata + provider/model ids,
 *  never payload fields. `branchFrontierRevision` is the IR-70D field. */
export interface ExperienceContextStatusDto {
  sessionId: string;
  mode: ExperienceContextMode;
  branchFrontierRevision: number | null;
  messageFrontierPosition: number | null;
  providerProfileId: string | null;
  modelId: string | null;
  /** Provenance of the captured RP-context source (report item 6): bare ids,
   *  never content. Both null ⇔ captured from the ambient host chat. */
  sourceCharacterId: string | null;
  sourceChatId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One prompt-override layer (IR-70D). A null layer means no override is
 *  persisted for that scope. Mirrors `ExperiencePromptOverrideDto` in
 *  services/api `api/contract/runtime-api.ts` (backend-only module). */
export interface ExperiencePromptOverrideDto {
  scope: "global" | "character";
  content: string;
  characterId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Both independent prompt-override layers (GET /prompt-overrides and both
 *  PUTs return the updated combined layers). Mirrors
 *  `ExperiencePromptOverridesResponse` in services/api
 *  `api/contract/runtime-api.ts` (backend-only module). */
export interface ExperiencePromptOverridesResponse {
  global: ExperiencePromptOverrideDto | null;
  character: ExperiencePromptOverrideDto | null;
}

// ── Stateless unsaved-source tester (Wave 8 / IR-81B backend, IR-81D client) ─

/** POST /experience/test/run body. `settings`/`participants`/`capabilityGrants`/
 *  `actions` are optional on input (the schema defaults them). */
export type ExperienceTestRunRequest = z.input<typeof experienceTestRunRequestSchema>;
/** POST /experience/test/simulate body. `maxIterations`/`maxEffects` default
 *  server-side when omitted. */
export type ExperienceTestSimulateRequest = z.input<typeof experienceTestSimulateRequestSchema>;
/** POST /experience/playground/start body. `settings`/`participants`/
 *  `capabilityGrants` are optional on input (the schema defaults them). */
export type ExperiencePlaygroundStartRequest = z.input<typeof experiencePlaygroundStartRequestSchema>;
/** POST /experience/playground/advance body (`playgroundSessionId` + the ONE
 *  human action carrying the requestId/expectedRevision CAS pair). */
export type ExperiencePlaygroundAdvanceRequest = z.input<typeof experiencePlaygroundAdvanceRequestSchema>;

/** One captured VM console line. Mirrors `ExperienceConsoleEntry` in
 *  services/api `domain/interactive/experience-sandbox.ts` (backend-only
 *  module). */
export interface ExperienceTestConsoleEntry {
  level: "log" | "warn" | "error";
  args: string[];
}

/** The discovered definition over the wire: the schema-normalized DTO plus the
 *  kernel's method-presence flags. Mirrors `ExperienceDefinition` in
 *  services/api `domain/interactive/experience-kernel.ts` (backend-only). */
export interface ExperienceTestDefinition extends ExperienceDefinitionDto {
  hasChoose: boolean;
  hasFlavor: boolean;
}

/** One replayed action's outcome inside a test run / simulation trace. Mirrors
 *  `ExperienceTestStepTrace` in services/api
 *  `domain/interactive/experience-tester.ts` (backend-only). */
export interface ExperienceTestStepTrace {
  requestId: string;
  actionType: string;
  participantId?: string;
  replayed: boolean;
  revision: number;
  status: ExperienceSessionStatus;
  events: ExperienceEvent[];
  effects: ExperienceEffectRequest[];
  console: ExperienceTestConsoleEntry[];
}

/** POST /experience/test/run success body. Mirrors `ExperienceTestRunData` in
 *  services/api `domain/interactive/experience-tester.ts` (backend-only). */
export interface ExperienceTestRunData {
  definition: ExperienceTestDefinition;
  sourceHash: string;
  initialState: unknown;
  finalState: unknown;
  revision: number;
  status: ExperienceSessionStatus;
  projection: { state: unknown; actions: ExperienceActionDescriptor[] };
  events: ExperienceEvent[];
  effects: ExperienceEffectRequest[];
  console: ExperienceTestConsoleEntry[];
  steps: ExperienceTestStepTrace[];
}

/** Why a bounded simulation stopped. Mirrors `ExperienceTestStopReason` in
 *  services/api `domain/interactive/experience-tester.ts` (backend-only). */
export type ExperienceTestStopReason =
  | "completed"
  | "awaiting_human"
  | "awaiting_model"
  | "no_legal_action"
  | "no_choose_method"
  | "bounded_non_termination"
  | "effects_bound";

/** POST /experience/test/simulate success body. Mirrors
 *  `ExperienceTestSimulateData` in services/api
 *  `domain/interactive/experience-tester.ts` (backend-only). */
export interface ExperienceTestSimulateData {
  definition: ExperienceTestDefinition;
  sourceHash: string;
  initialState: unknown;
  finalState: unknown;
  revision: number;
  status: ExperienceSessionStatus;
  events: ExperienceEvent[];
  effects: ExperienceEffectRequest[];
  console: ExperienceTestConsoleEntry[];
  steps: ExperienceTestStepTrace[];
  stopReason: ExperienceTestStopReason;
  iterations: number;
  stopDetail?: { participantId?: string };
}

// ── Interactive playground session driver (Wave 8 / IR-84A backend, IR-84B client) ─

/** The playground turn envelope: start returns the full envelope (including
 *  the validated definition); advance returns the same shape with `definition`
 *  OMITTED. Mirrors `ExperiencePlaygroundData` in services/api
 *  `domain/interactive/experience-playground.ts` (backend-only module),
 *  reusing the IR-81D tester wire mirrors where the shapes coincide. */
export interface ExperiencePlaygroundData {
  playgroundSessionId: string;
  definition?: ExperienceTestDefinition;
  initialState: unknown;
  state: unknown;
  projection: { state: unknown; actions: ExperienceActionDescriptor[] };
  events: ExperienceEvent[];
  effects: ExperienceEffectRequest[];
  console: ExperienceTestConsoleEntry[];
  revision: number;
  status: ExperienceSessionStatus;
  stopReason: ExperienceTestStopReason;
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
  /** Present only on the `done` chunk for message-editor completions (MAE-22
   *  wire shape). The backend attaches these as merge provenance; the runner
   *  hook captures them additively — existing modes emit a bare `{ type: "done" }`
   *  and these fields stay `undefined`, so no behavior change for them. */
  modelId?: string;
  promptPresetId?: string | null;
  finishReason?: string;
}

export type AiAssistantMode = "script" | "lore_entry" | "lore_keys" | "chat_impersonate" | "md_import" | "vision_describe" | "scene_schema" | "scene_rules" | "message_edit" | "message_merge" | "dice_script";

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
  /** Message editor modes: canonical target message in the chat's active
   *  branch (message_edit/message_merge). Mirrors the backend wire type. */
  targetMessageId?: string;
  /** Message editor modes: immutable canonical variant IDs selected as editor
   *  sources (edit: the selected variant; merge: the starred set). */
  sourceVariantIds?: string[];
  existingKeys?: string[];
  existingSecondaryKeys?: string[];
  logic?: string;
  keyTarget?: "primary" | "secondary" | "both";
  maxOutputTokens?: number;
  temperature?: number;
  /** scene_schema: select the format-aware default prompt (json/xml) so the
   *  generated schema obeys XML-safe key rules when needed. */
  promptFormat?: "json" | "xml";
}
