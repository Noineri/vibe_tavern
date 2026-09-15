/**
 * Frontend-specific view types for the API client layer.
 *
 * Response shapes are inferred from the Hono routes (`RpcData`); request bodies
 * derive from the api-contracts schemas. Hand-written interfaces remain only
 * where no route or schema declares the shape.
 */
import type { Attachment, ChatBranch, Message, MessageVariant, PromptTraceRecordDto, SceneTrackerRecord } from "@vibe-tavern/domain";
import type { DiceActorType, DiceAttempt, DiceCheckDefinition, DiceMode, DiceRollSnapshot } from "@vibe-tavern/domain";
import type {
	ExperienceActionDescriptor,
	ExperienceContextMode,
	ExperienceEvent,
	ExperienceParticipant,
	ExperiencePublicReport,
} from "@vibe-tavern/domain";
import type { z } from "zod";
import type { client } from "./client.js";
import type { RpcData } from "./unwrap.js";

/** Route-inferred wire shapes: the Hono route is the only declaration of these records. */
type Api = typeof client.api;

// Wire-format output types shared with the backend (single source of truth in
// @vibe-tavern/api-contracts). Two are imported under local aliases that the
// frontend has historically used: ProviderProfileRecord (canonical:
// ClientProviderProfileRecord) and CachedModelsRecord (canonical:
// CachedProviderModelsRecord). Defining these in a shared package makes drift
// a compile error instead of a silent runtime bug (see wire-types.ts).
import type {
	AutoSummaryConfig,
	CharacterListEntry,
	ChatDto,
	InsightsConfig,
	ClientProviderProfileRecord as ProviderProfileRecord,
	CachedProviderModelsRecord as CachedModelsRecord,
	FavoriteProviderModelRecord,
	ProviderModelSettingsRecord,
	ClientProxyRecord as ProxyRecord,
	PersonaRecord,
	ChatListItem,
	ExperienceActionDto,
	ExperienceFinishRequestDto,
	ExperienceRestartRequestDto,
	ExperienceSeatLegality,
	ExperienceSeatLegalityMatrix,
	ExperienceRoundCommitRequestDto,
	ExperienceRoundConfigResponseDto,
	ExperienceRoundModelRequestDto,
	ExperienceRoundModelResponseDto,
} from "@vibe-tavern/api-contracts";
// Type-only schema imports: the interactive-runtime request DTOs that the
// contracts index does NOT re-export are derived here via `z.input` of the
// exported schemas — the schema stays the single source of truth, nothing is
// hand-written, and no runtime value enters the browser bundle.
import type {
	aiAssistantModeSchema,
	aiAssistantRequestSchema,
	diceRollRequestSchema,
	insightsCompletionRefreshSchema,
	updateInsightsConfigSchema,
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
	AutoSummaryConfig,
	InsightsConfig,
	ProviderProfileRecord,
	CachedModelsRecord,
	FavoriteProviderModelRecord,
	ProviderModelSettingsRecord,
	ProxyRecord,
	PersonaRecord,
	ChatListItem,
	ExperienceSeatLegality,
	ExperienceSeatLegalityMatrix,
	ExperienceRoundCommitRequestDto,
	ExperienceRoundConfigResponseDto,
	ExperienceRoundModelRequestDto,
	ExperienceRoundModelResponseDto,
};

// ─── Chat ─────────────────────────────────────────────────────────────

/** The full session snapshot as the server serializes it (bootstrap carries every field). */
type WireSessionSnapshot = NonNullable<RpcData<Api["bootstrap"]["$get"]>["snapshot"]>;

/** Message with variant data. `sceneTracker` mirrors the selected variant (swapped
 *  locally on selection); `diceRolls` is present only on user messages with bound rolls. */
export type AppMessage = WireSessionSnapshot["messages"][number] & {
  /**
   * IG-CF10: client-only shadow of the message ROW's attachment set (the
   * fallthrough behind the server DTO merge — session-runtime-dto.ts IG-18a).
   * The row set itself never reaches the wire (only the merged `attachments`
   * do), so the snapshot store stamps it at ingest whenever the merge
   * provably equals the row set, and preserves it across wholesale message
   * replacements. Never sent by the server, never serialized back — swipe
   * (`selectVariant`) reads it when the target variant carries no
   * attachmentsJson. Absent = the row set was never visible on the wire.
   */
  messageLevelAttachments?: Attachment[];
};

/** PATCH body for `updateInsightsConfig`: toggles + an optional partial tracker config (deep-merged server-side). */
export type InsightsConfigPatch = NonNullable<z.input<typeof updateInsightsConfigSchema>["insightsConfig"]>;

export type {
  ObjectiveLongTermGoal,
  ObjectiveMode,
  ObjectiveShortTermGoal,
  ObjectiveState,
  ObjectiveTask,
  ObjectiveTaskStatus,
} from "@vibe-tavern/domain";

type ChatInsightsApi = Api["chats"][":chatId"]["insights"];

/** Completion-refresh target; `variantId` present = Scene-aware refresh with a scoped message patch. */
export type InsightsCompletionTarget = z.input<typeof insightsCompletionRefreshSchema>["target"];
export type InsightsCompletionPatchResponse = RpcData<ChatInsightsApi["completion-refresh"]["$post"]>;
/** Branch-scoped live context preview; echoes { chatId, branchId } so stale results can be rejected. */
export type ContextPreviewResponse = RpcData<Api["chats"][":chatId"]["branches"][":branchId"]["context-preview"]["$post"]>;
/** Non-persisting Scene preview: the scene state a DRAFT config would produce. */
export type ScenePreviewResponse = RpcData<ChatInsightsApi["scene"]["preview"]["$post"]>;
/** Manual Scene mutation (generate/edit/delete): the target's refreshed message. */
export type SceneTargetResponse = RpcData<ChatInsightsApi["scene"]["generate"]["$post"]>;
/** Server-authoritative Scene status: coordinator `generating` flag + the variant's record. */
export type SceneStatusResponse = RpcData<ChatInsightsApi["scene"]["status"]["$post"]>;

export type { SceneBackfillMode } from "@vibe-tavern/domain";
export type { SceneBackfillStatus as SceneBackfillStatusResponse } from "@vibe-tavern/api-contracts";

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

export type AppCharacter = WireSessionSnapshot["character"];

/**
 * Alias of `PersonaRecord` (defined in the Persona section below) — the
 * canonical persona shape on the frontend. Kept as a named alias for import
 * stability across snapshot/consumer sites (AppSnapshot.persona, selectors,
 * hooks). See `resolveEntityAvatarUrl` for the `updatedAt` cache-bust use.
 */
export type AppPersona = PersonaRecord;

export type AppCharacterEntry = CharacterListEntry;

/** A character version (VTF Phase 3 folder-snapshot branching). Meta only on the wire. */
export type AppCharacterVersion = RpcData<Api["characters"][":characterId"]["versions"]["$get"]>[number];

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
 * ingestSnapshot distinguishes absent (preserve) from present-empty (replace):
 * it guards each field with a presence check ("x" in snapshot / Array.isArray)
 * before writing. API modules hand the RPC body over unchanged.
 *
 * The backend's SessionSnapshot (services/api/src/api/contract/session-types.ts)
 * is the full shape; every per-endpoint response is a subset of it. `unwrapRpc`
 * infers each response body from the Hono route, so a server field that does
 * not fit this type is a compile error at the API module that returns it.
 */
export type AppSnapshot = Partial<WireSessionSnapshot>;

// ─── Settings ──────────────────────────────────────────────────────────

export type UiSettingsRecord = RpcData<Api["settings"]["ui"]["$patch"]>;

// ─── Chat Summary ──────────────────────────────────────────────────────

export type ChatSummaryRecord = RpcData<Api["chats"][":chatId"]["summaries"]["$get"]>[number];

// ─── Provider ──────────────────────────────────────────────────────────

export type ProviderModelOption = RpcData<Api["providers"]["fetch-models"]["$post"]>["models"][number];

export type TestChatResponse = RpcData<Api["providers"]["test-chat"]["$post"]>;

// ─── Lorebook ──────────────────────────────────────────────────────────

export type LoreEntryRecord = RpcData<Api["lorebooks"][":lorebookId"]["entries"]["$get"]>[number];

export type LorebookRecord = RpcData<Api["lorebooks"]["all"]["$get"]>[number];

export type LorebookLinkRecord = RpcData<Api["lorebooks"][":lorebookId"]["links"]["$get"]>[number];

// ─── Scripts ───────────────────────────────────────────────────────────

export type ScriptRecord = RpcData<Api["scripts"]["all"]["$get"]>[number];

export type ScriptLinkRecord = RpcData<Api["scripts"][":scriptId"]["links"]["$get"]>[number];

// ─── Regex presets (REGEX_EXTENSION_PLAN, RX-11) ─────────────────────────────

export type { RegexPreset as RegexPresetRecord, RegexProfile as RegexProfileRecord } from "@vibe-tavern/domain";

export type RegexLinkRecord = RpcData<Api["regex"]["presets"][":id"]["links"]["$get"]>[number];

export type RegexProfileLinkRecord = RpcData<Api["regex"]["profiles"][":id"]["links"]["$get"]>[number];

// ─── Dice ──────────────────────────────────────────────────────────────
//
// Wire types for the chat-scoped Dice API (DICE_SYSTEM_FRONTEND_PLAN, Wave F1).
// The canonical entity shapes (`DiceRollSnapshot`, `DiceAttempt`,
// `DiceCheckDefinition`, the enum types) live in `@vibe-tavern/domain` and are
// re-exported here for import stability; only the response/lane envelopes and
// the thin request shapes are defined locally.

export type { DiceActorType, DiceAttempt, DiceCheckDefinition, DiceMode, DiceRollSnapshot };

/** GET /pending — both lanes keyed by mode (monotonic revision + unbound rolls). */
export type DicePendingState = RpcData<Api["chats"][":chatId"]["dice"]["pending"]["$get"]>;
export type DiceLaneState = DicePendingState["normal"];
/** GET /definitions — enabled Dice scripts with their resolvable checks. */
export type DiceDefinitionsResponse = RpcData<Api["chats"][":chatId"]["dice"]["definitions"]["$get"]>;
export type DiceScriptDefinitions = DiceDefinitionsResponse["scripts"][number];
/** POST /roll body. Server-authoritative: ids, actor, mode, and a `requestId`
 *  idempotency key — never dice faces or totals. */
export type DiceRollRequest = z.input<typeof diceRollRequestSchema>;

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
// Request bodies derive from the api-contracts schemas (`z.input`); responses
// and row shapes are inferred from the Hono routes in
// services/api/src/api/routes/experience.ts.

export type {
  ExperienceActionDescriptor,
  ExperienceContextMode,
  ExperienceEvent,
  ExperienceParticipant,
  ExperiencePublicReport,
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
/** POST /sessions/:id/restart body — both fields optional, omitted falls back
 *  to the source session's frozen snapshots. */
export type ExperienceRestartRequest = ExperienceRestartRequestDto;
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

// ── Responses (route-inferred) ──────────────────────────────────────────────

type ExperienceSessionApi = Api["experience"]["sessions"][":sessionId"];

export type ExperienceChatConfigRow = RpcData<Api["chats"][":chatId"]["experience"]["config"]["$get"]>;
export type ExperienceVisualRow = RpcData<Api["experience"]["visuals"]["$post"]>;
export type ExperienceEffectRow = RpcData<Api["experience"]["effects"][":effectId"]["retry"]["$post"]>;
/** Session metadata + the projected view for the requesting viewer. */
export type ExperienceSessionResponse = RpcData<ExperienceSessionApi["$get"]>;
/** Per-viewer projected view (GET /view, and `view` on every session response). */
export type ExperienceProjection = RpcData<ExperienceSessionApi["view"]["$get"]>;
/** Session after an action round (POST /actions, POST /undo) + emitted events and whose turn is next. */
export type ExperienceActionResponse = RpcData<ExperienceSessionApi["actions"]["$post"]>;
/** Queued attachment without its hidden checkpoint; null when none is queued. */
export type ExperienceQueuedAttachmentResponse = RpcData<ExperienceSessionApi["attachment"]["$get"]>;
export type ExperienceQueuedAttachmentView = RpcData<ExperienceSessionApi["reports"]["queue"]["$post"]>;
export type ExperienceReportStatus = RpcData<ExperienceSessionApi["reports"]["status"]["$get"]>;
/** Recalculation preview (safe, no commit). */
export type ExperienceRecalculationPreview = RpcData<ExperienceSessionApi["recalculate"]["$post"]>;
/** Terminal effect row + whether its result reached the reducer (202 + `hostScheduled` for timer effects). */
export type ExperienceEffectRunResponse = RpcData<Api["experience"]["effects"][":effectId"]["run"]["$post"]>;
/** Context-bundle metadata only (never payload fields); GET /context/status answers null when never captured. */
export type ExperienceContextStatusDto = RpcData<ExperienceSessionApi["context"]["capture"]["$post"]>;
/** Both independent prompt-override layers (global + current character). */
export type ExperiencePromptOverridesResponse = RpcData<ExperienceSessionApi["prompt-overrides"]["$get"]>;

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
/** POST /experience/round-model body — the realtime model-seat seam (RM-7
 *  contract, RM-9 client). The schema has no input-only derivations, so the
 *  request type is the contracts DTO verbatim. */
export type ExperienceRoundModelRequest = ExperienceRoundModelRequestDto;

/** POST /experience/test/run success body. */
export type ExperienceTestRunData = RpcData<Api["experience"]["test"]["run"]["$post"]>;
/** POST /experience/test/simulate success body. */
export type ExperienceTestSimulateData = RpcData<Api["experience"]["test"]["simulate"]["$post"]>;
/** Discovered definition: schema-normalized DTO + the kernel's method-presence flags. */
export type ExperienceTestDefinition = ExperienceTestRunData["definition"];
export type ExperienceTestConsoleEntry = ExperienceTestRunData["console"][number];

// ── Interactive playground session driver (Wave 8 / IR-84A backend, IR-84B client) ─

/** Playground turn envelope; advance/timer responses omit `definition`. */
export type ExperiencePlaygroundData = RpcData<Api["experience"]["playground"]["start"]["$post"]>;

// ─── Import ────────────────────────────────────────────────────────────

/** Import result. The lean mass-import path omits `snapshot` and sets `characterId`. */
export type ImportJsonResponse = RpcData<Api["import"]["json"]["$post"]>;

// ─── AI Assistant ──────────────────────────────────────────────────────

export type { AiAssistantStreamChunk as AiAssistantChunk, AiAssistantTokenCount } from "@vibe-tavern/api-contracts";
export type AiAssistantMode = z.input<typeof aiAssistantModeSchema>;
export type AiAssistantRequestBody = z.input<typeof aiAssistantRequestSchema>;
