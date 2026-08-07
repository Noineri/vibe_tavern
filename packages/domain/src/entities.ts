import type {
  CharacterId,
  CharacterVersionId,
  ChatBranchId,
  ChatId,
  ChatSummaryId,
  DiceRollId,
  ExperienceAttachmentId,
  ExperienceContextBundleId,
  ExperienceEffectId,
  ExperienceSessionId,
  ExperienceStepId,
  ExperienceVisualId,
  LoreEntryId,
  LorebookId,
  MessageId,
  MessageVariantId,
  PersonaId,
  PromptPresetId,
  PromptTraceId,
  RetrievedMemoryHitId,
  ScriptId,
  SummaryMemorySnapshotId,
  ToolProfileId,
} from "./ids.js";

import type {
  CardFormat,
  LoreScopeType,
  ChatStatus,
  ChatMode,
  MessageRole,
  AuthorType,
  MessageState,
  SummaryKind,
  ChatSummarySource,
  ToolProfileMode,
  LoreLogic,
  LoreEntryRole,
  LoreMatchSource,
  LoreEntryPosition,
  PromptLayerPosition,
  ObjectiveTaskStatus,
  ObjectiveMode,
  OBJECTIVE_MODE,
} from "./platform-constants.js";

import type {
  SceneAutoMode,
  ScenePromptFormat,
  SceneTrackerDsl,
} from "./scene-tracker-constants.js";
import type {
  ScriptKind,
  DiceMode,
  DiceActorType,
  DiceResolution,
  DiceFinalizationPolicy,
  DiceFaceShape,
} from "./platform-constants.js";
import type {
  ExperienceCapability,
  ExperienceContextMode,
  ExperienceController,
  ExperienceEffectKind,
  ExperienceEffectStatus,
  ExperienceEventVisibility,
  ExperienceSessionStatus,
  ExperienceViewerKind,
} from "./platform-constants.js";

export type Timestamp = string;

export {
  CardFormat,
  LoreScopeType,
  ChatStatus,
  MessageRole,
  AuthorType,
  MessageState,
  SummaryKind,
  ChatSummarySource,
  ToolProfileMode,
  LoreLogic,
  LoreEntryRole,
  LoreMatchSource,
  LoreEntryPosition,
  PromptLayerPosition,
};

/**
 * Core character entity.
 *
 * `characterBook` is a `Record` because its internal structure depends on the
 * card format (ST v2, ST v3, etc.).
 * `status` tracks the lifecycle: `active`, `draft`, or `archived`.
 */
export interface Character {
  id: CharacterId;
  slug: string;
  name: string;
  description: string;
  personalitySummary: string | null;
  defaultScenario: string | null;
  firstMessage: string | null;
  mesExample: string | null;
  mesExampleMode: string;
  mesExampleDepth: number;
  alternateGreetings: string[];
  postHistoryInstructions: string | null;
  creatorNotes: string | null;
  characterBook: Record<string, unknown> | null;
  depthPrompt: string | null;
  depthPromptDepth: number | null;
  depthPromptRole: string | null;
  extensions: Record<string, unknown>;
  systemPrompt: string | null;
  tags: string[];
  avatarAssetId: string | null;
  avatarFullAssetId: string | null;
  avatarCropJson: string | null;
  /** Extension of the folder-resident *thumbnail* (crop) avatar at data/characters/{id}/avatar.{avatarExt}. Null = legacy flat avatar (avatarAssetId) or none. Backed by the CFS migration (C1+). */
  avatarExt: string | null;
  /** Extension of the folder-resident *full* (uncropped) avatar at data/characters/{id}/avatar-full.{avatarFullExt}. Null = no separate full (the thumbnail avatar is itself uncropped, or none). Backed by the avatar-full folder migration. */
  avatarFullExt: string | null;
  /** Gallery row id the avatar was last set from (setAvatarFromGallery). Null when the avatar came from a direct upload or was never set from a gallery image. Used by the next avatar switch to skip salvage when the prior avatar's bytes already live in the gallery under this id (prevents gallery duplication). */
  avatarSourceAssetId: string | null;
  /** When true, the character's described gallery images are injected as a text prompt layer. */
  includeGalleryInPrompt: boolean;
  /** When true, the avatar appearance description is injected as a text prompt layer. */
  includeAvatarInPrompt: boolean;
  /** Vision-generated or user-edited avatar appearance description. Null = not described. */
  avatarDescription: string | null;
  status: "active" | "draft" | "archived";
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * A branchable character version (VTF Phase 3 folder-snapshot model).
 *
 * Content lives in FILES under data/characters/{id}/versions/{versionId}/ — this
 * row is META ONLY (no content columns, no definition blob). The active
 * version's content is swapped into the character folder root and read via
 * CharacterStore.getById(). See plans/VIBE_TAVERN_FORMAT.md (Phase 3).
 */
export interface CharacterVersion {
  id: CharacterVersionId;
  characterId: CharacterId;
  title: string;
  isActive: boolean;
  createdAt: Timestamp;
}

/** Structured pronoun declensions. Populated only for the custom pronoun case;
 * preset pronouns resolve via a lookup table at prompt time (see pronoun-forms.ts in the pipeline package). */
export interface PronounForms {
  subjective: string;
  objective: string;
  /** Possessive determiner (his/her/their/its) — {{poss}}. */
  possessive: string;
  /** Possessive pronoun (his/hers/theirs/its) — {{poss_p}}. */
  possessivePronoun: string;
  reflexive: string;
}

export interface Persona {
  id: PersonaId;
  name: string;
  description: string;
  pronouns: string | null;
  /** Structured pronoun declensions (custom case only); null for presets and unset. */
  pronounForms: PronounForms | null;
  avatarAssetId: string | null;
  avatarFullAssetId: string | null;
  avatarCropJson: string | null;
  /** Extension of the folder-resident *thumbnail* (crop) avatar at data/personas/{id}/avatar.{avatarExt}. Null = legacy flat avatar (avatarAssetId) or none. Backed by the CFS migration (C1+). */
  avatarExt: string | null;
  /** Extension of the folder-resident *full* (uncropped) avatar at data/personas/{id}/avatar-full.{avatarFullExt}. Null = no separate full (the thumbnail avatar is itself uncropped, or none). Backed by the avatar-full folder migration. */
  avatarFullExt: string | null;
  /** When true, the persona avatar appearance description is injected as a text prompt layer. */
  includeAvatarInPrompt: boolean;
  /** Vision-generated or user-edited avatar appearance description. Null = not described. */
  avatarDescription: string | null;
  defaultForNewChats: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * SillyTavern-parity defaults for a newly authored lorebook (scan depth, token
 * budget, recursive scanning off). Single source of truth consumed by BOTH the
 * co-author draft engine (services/api) and the Apply transaction (db) — import
 * from `@vibe-tavern/domain` rather than re-literalizing 10 / 1000 / false.
 */
export const LOREBOOK_DEFAULTS = {
  scanDepth: 10,
  tokenBudget: 1000,
  recursiveScanning: false,
} as const;

export interface Lorebook {
  id: LorebookId;
  name: string;
  description: string;
  scopeType: LoreScopeType;
  scanDepth: number;
  tokenBudget: number;
  /** Null = fixed token-budget mode (use tokenBudget). 0-100 = percent of model context. See lorebook-st-parity-audit.md §1.4. */
  tokenBudgetPercent: number | null;
  recursiveScanning: boolean;
  maxRecursionSteps: number;
  includeNames: boolean;
  minActivations: number;
  minActivationsDepthMax: number;
  overflowAlert: boolean;
  characterStrategy: number;
  sortOrder: number;
  enabled: boolean;
  characterId: string | null;
  personaId: string | null;
  chatId: string | null;
  extensions: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * One element of a lorebook entry's `characterFilter`.
 *
 * `id` is a stable `CharacterId` when the filter is bound to a known character
 * (survives renames), or `null` for a *ghost* — a name-only reference (legacy
 * `string[]` data, or a name imported from a SillyTavern card whose character
 * isn't in this database). Ghosts match the activation engine by name only
 * (see `lore-activation-engine.ts`); binding a ghost to a real character in
 * the UI upgrades it to an id-bound entry.
 */
export interface CharacterFilterEntry {
	id: string | null;
	name: string;
}

/**
 * A single lorebook entry.
 *
 * `keys` are activation triggers; `secondaryKeys` provide additional conditions
 * combined via `logic`.
 * `stickyWindow`, `cooldownWindow`, and `delayWindow` control time-based
 * activation behaviour (Phase 2).
 */
export interface LoreEntry {
  id: LoreEntryId;
  lorebookId: LorebookId;
  title: string;
  content: string;
  keys: string[];
  secondaryKeys: string[];
  logic: LoreLogic;
  position: LoreEntryPosition;
  depth: number;
  priority: number;
  // Time windows
  stickyWindow: number;
  cooldownWindow: number;
  delayWindow: number;
  // Extended ST fields
  constant: boolean;
  probability: number;
  ignoreBudget: boolean;
  role: LoreEntryRole;
  // Inclusion group
  groupName: string;
  groupWeight: number;
  prioritizeInclusion: boolean;
  useGroupScoring: boolean;
  // Recursion
  excludeRecursion: boolean;
  preventRecursion: boolean;
  delayUntilRecursion: boolean;
  recursionLevel: number;
  scanDepthOverride: number | null;
  // Matching
  caseSensitive: boolean;
  matchWholeWords: boolean;
  characterFilter: CharacterFilterEntry[];
  characterFilterExclude: boolean;
  matchSources: LoreMatchSource[];
  // Meta
  enabled: boolean;
  sortOrder: number;
  automationId: string;
  metadata: Record<string, unknown>;
}

/**
 * Why a lorebook entry activated on a given turn. Discriminated union so the
 * trace UI can render each case distinctly. Surfaced in the prompt trace via
 * `ActivatedLoreDetail` (reports/lorebook-trace-conditions.md).
 *
 * Scope is ACTIVATED entries only (per noineri 2026-06-21). Skip reasons
 * (cooldown / no-key-match / character-filter / probability-failed / ...) are
 * computed inside the engine for `console.debug` but deliberately NOT
 * surfaced here — they would bloat every trace row.
 */
export type LoreActivationReason =
  /** `constant: true` entry — always active (step 4 in the engine). */
  | { kind: "constant" }
  /** Previously activated, still inside its `stickyWindow` (step 5). */
  | { kind: "sticky"; turnsSinceActivation: number; window: number }
  /** `delayWindow` elapsed — first-match pending now fulfilled (step 7). */
  | { kind: "delay_fulfilled" }
  /** `@@activate` decorator forced activation without a key match (step 8/12). */
  | { kind: "decorator" }
  /** A primary key matched the scan text (step 12). */
  | { kind: "key_match"; matchedKeys: string[]; matchCount: number; scanState: "normal" | "recursion" };

/**
 * Per-entry activation detail persisted on the prompt trace and rendered in
 * the trace UI. `id` matches the LoreEntryId in `activatedLoreEntries`.
 */
export interface ActivatedLoreDetail {
  id: string;
  title: string;
  reason: LoreActivationReason;
}

/**
 * A `LoreEntry` annotated with the live activation result — what
 * `listActiveLoreEntries` returns up the assembly pipeline. The extra fields
 * carry the structured activation reason (for the prompt trace) alongside the
 * already-computed key-match details. Consumers that only need the base
 * `LoreEntry` shape (pipeline layers, script sandbox) ignore the extras.
 */
export type ActiveLoreEntry = LoreEntry & {
  activationReason: LoreActivationReason;
  matchedKeys: string[];
  matchCount: number;
};

export interface Script {
  id: ScriptId;
  name: string;
  description: string;
  code: string;
  /** Runtime contract of this script (`prompt` or `dice`). Defaults to `prompt`
   *  for every legacy row/import/request so existing prompt scripts are
   *  unchanged. Prompt assembly loads only prompt scripts; Dice actions load
   *  only dice scripts — the two runtimes are isolated by kind (Wave B1). */
  scriptKind: ScriptKind;
  enabled: boolean;
  scopeType: LoreScopeType;
  sortOrder: number;
  characterId: string | null;
  personaId: string | null;
  chatId: string | null;
  extensions: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ─── Dice system entities (DICE_SYSTEM_BACKEND_PLAN, Wave B1) ──────────────────
//
// The pure notation/rolling/arith-validators live in `dice.ts`; these are the
// immutable, message-bindable entity shapes the API/DB layers use. A completed
// pending roll is an immutable rules snapshot: script/check/actor rename,
// edit, disable, unlink, or delete after the roll never rewrites it — the
// captured labels + revision + rules stay on the result. (The authoritative
// roll/service paths arrive in Wave B3; B1 only defines the shapes.)

/**
 * Frozen actor identity+label captured on a roll. Stored verbatim on the
 * result so it survives actor rename/edit/delete — historical labels remain.
 * (The richer frozen actor *state* the Dice VM reads at roll time is a Wave
 * B2 concern and reuses this identity triple.)
 */
export interface DiceActorSnapshot {
  actorType: DiceActorType;
  actorId: string;
  actorLabel: string;
}

/**
 * One authorized roll of a check. A Normal check has exactly one attempt;
 * Immersive may accumulate several inside one result envelope. `faces.length`
 * matches the dice count in the notation; each value is a validated face in
 * `[1..sides]`. The server validates `subtotal === sum(faces)` and
 * `total === subtotal + modifier` before persisting (per-face arithmetic).
 */
export interface DiceAttempt {
  attemptId: string;
  faces: number[];
  modifier: number;
  subtotal: number;
  total: number;
  /** Script-provided reason this extra attempt was granted (Immersive only). */
  grantReason?: string;
  /** True on the attempt the user/script finalized as the result (choose policy). */
  chosenFinal?: boolean;
}

/**
 * The adjudicated final of a strict check. `outcome` (success/failure/...) is
 * binding adjudication the model must honor; `degree` and `constraint` qualify
 * it. Narrative checks never carry a `final` — they persist mechanical facts
 * (faces/total) without authoritative success/failure.
 */
export interface DiceRollFinal {
  total: number;
  outcome?: string;
  degree?: string;
  constraint?: string;
}

/**
 * A resolvable check published by a Dice script for one chat (Wave B2 VM
 * discovery). `actors` restricts who can roll it; `notation` is the bounded
 * `[N]dS[+/-M]` / `d%` the script declared; `faceShape` drives per-die
 * visualization. B1 defines the canonical type; the VM + resolver arrive later.
 */
export interface DiceCheckDefinition {
  id: string;
  label: string;
  notation: string;
  actors: readonly DiceActorType[];
  resolution: DiceResolution;
  faceShape: DiceFaceShape;
  /** Optional short rule-help string shown in the composer tray (F8). Absent
   *  when the script did not register help; never recomputed from the
   *  (possibly edited) script source after registration. */
  help?: string;
}

/**
 * The immutable, message-bindable Dice result snapshot. One per actor+check
 * per draft turn. `mode` and `resolution` are orthogonal: mode governs attempt
 * persistence, resolution governs adjudication. `boundMessageId` is set when
 * the result binds to a committed user message; null/absent while pending.
 */
export interface DiceRollSnapshot {
  rollId: DiceRollId;
  /** DB-unique idempotency key: rapid clicks, retries, process recovery, and
   *  two tabs cannot produce a duplicate authoritative roll. */
  requestId: string;
  actor: DiceActorSnapshot;
  scriptId: string;
  scriptLabel: string;
  /** Script revision captured at roll time — a later edit does not invalidate
   *  this snapshot; new attempts resolve current eligibility/rules. */
  scriptRevision: number;
  checkId: string;
  checkLabel: string;
  notation: string;
  faceShape: DiceFaceShape;
  resolution: DiceResolution;
  mode: DiceMode;
  /** Immersive include/exclude-from-binding (server-persisted, with undo). */
  included: boolean;
  /** The attempt id chosen as the final result, or null while unchosen. */
  finalAttemptId: string | null;
  attempts: DiceAttempt[];
  /** Present on strict checks; always absent on narrative checks. */
  final?: DiceRollFinal;
  /** Script-provided retry reason/policy channel (e.g. "Second chance: Lucky"). */
  retryReason?: string;
  policy?: DiceFinalizationPolicy;
  boundMessageId?: MessageId | null;
  createdAt: Timestamp;
}

// ─── Interactive Runtime entities (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 1)
//
// Canonical envelopes for the Interactive Runtime. The pure synchronous VM and
// kernel arrive in IR-12; the durable persistence in Wave 2. These shapes are
// the authoritative semantic contract every later layer mirrors — the bounded
// WIRE schemas live in api-contracts/interactive-schema.ts. A registered
// experience owns JSON-safe state and the meaning of its actions; the host owns
// identity, branch/session linkage, monotonic revisions, request idempotency,
// atomic persistence, deterministic effect delivery, snapshots, trust, and the
// visual/RP bridges.

/**
 * Identity + name a registered experience publishes. `apiVersion` is the host
 * protocol version the script targets; it lives on the registration/definition
 * and session, not on the manifest itself (mirrors the design's
 * `register({ apiVersion, manifest, … })` shape).
 */
export interface ExperienceManifest {
  id: string;
  name: string;
}

/**
 * A capability a package declares it may use, with an optional bounded reason
 * shown in the per-session grant UI. Only declared AND user-granted
 * capabilities reach the VM `context`.
 */
export interface ExperienceDeclaredCapability {
  capability: ExperienceCapability;
  reason?: string;
}

/** A participant seat declared by an experience's settings. */
export interface ExperienceParticipant {
  id: string;
  label: string;
  controller: ExperienceController;
}

/**
 * The viewer a `project`/`actions` call is computed for. Hidden information is
 * enforced by projecting per-viewer: a seat (human/script/model) carries its
 * `participantId`; an observer view carries none and sees no private data.
 */
export interface ExperienceViewer {
  kind: ExperienceViewerKind;
  participantId?: string;
}

/**
 * An immutable snapshot of a rules or visual resource captured at session
 * start. Edits and deletes of the source row never corrupt an active or
 * historical session because the exact source + hash + revision are frozen
 * here (the snapshot-isolation invariant).
 */
export interface ExperienceSourceSnapshot {
  id: string;
  label: string;
  revision: number;
  source: string;
  sourceHash: string;
}

/**
 * One typed intention a viewer may submit. Returned by `actions()` as a
 * descriptor and submitted to `reduce()` (carrying `requestId` +
 * `expectedRevision`) as an action. `payloadSchema` is a bounded JSON-schema-ish
 * description the kernel validates submitted payloads against; `allowsText` is
 * true only when the package permits free text (model controllers).
 */
export interface ExperienceActionDescriptor {
  type: string;
  participantId?: string;
  label?: string;
  payloadSchema?: unknown;
  allowsText?: boolean;
}

/** A submitted action intention. Carries idempotency + revision for CAS. */
export interface ExperienceAction {
  type: string;
  requestId: string;
  expectedRevision: number;
  participantId?: string;
  payload?: unknown;
}

/**
 * An event emitted by a transition. `public` events reach the visual, the
 * queued report, and the Writer; `private` events never leave the
 * authoritative runtime — the literal that makes hidden-state absence provable.
 */
export interface ExperienceEvent {
  visibility: ExperienceEventVisibility;
  type: string;
  detail?: unknown;
}

/**
 * A durable effect a reducer requests as data. The host persists the request
 * `pending` before running the capability work, then feeds success, failure,
 * cancellation, or retry back through the same state-machine boundary. V1's
 * only effect kind is `model` (atomic model generation).
 */
export interface ExperienceEffectRequest {
  kind: ExperienceEffectKind;
  request: unknown;
}

/**
 * The output of `reduce`: the next authoritative state, post-move session
 * status (`active` or `completed` — `interrupted` is host-only), emitted
 * events, and optional durable effect requests. The host never trusts this
 * blindly: state must round-trip as bounded JSON, status is schema-narrowed,
 * and persistence applies it via compare-and-swap on the revision.
 */
export interface ExperienceTransition {
  state: unknown;
  status: ExperienceSessionStatus;
  events: ExperienceEvent[];
  effects?: ExperienceEffectRequest[];
  message?: string;
}

/**
 * The per-viewer projection `project` returns and the visual/bridge receive:
 * projected state, legal actions at this revision, the revision, and status.
 * Never carries hidden state for the viewer it was computed for.
 */
export interface ExperienceProjectedView {
  state: unknown;
  actions: ExperienceActionDescriptor[];
  revision: number;
  status: ExperienceSessionStatus;
}

/**
 * The canonical persisted experience session. Scoped by chatId + branchId with
 * at most one active session per branch (`activeSlot`, unique per branch). Pins
 * the exact rules/visual source snapshots so edits/deletes do not corrupt it;
 * holds current state, monotonic revision, participants, granted capabilities,
 * RP-context mode, report frontier, and the deterministic-random seed/cursor.
 * The DB table + store arrive in Wave 2; this is the canonical shape.
 */
export interface ExperienceSession {
  sessionId: ExperienceSessionId;
  chatId: ChatId;
  branchId: ChatBranchId;
  /** Pinned rules source snapshot (exact hash/revision). */
  rules: ExperienceSourceSnapshot;
  /** Pinned visual source snapshot, or null when no visual is bound. */
  visual: ExperienceSourceSnapshot | null;
  /** Host protocol version the rules registered. */
  apiVersion: number;
  /** Discovered manifest (id/name) frozen at start. */
  manifest: ExperienceManifest;
  /** Initial authoritative settings — a replay input (deterministic rebuild). */
  initialSettings: unknown;
  /** Current authoritative state (bounded JSON, round-trips). */
  currentState: unknown;
  /** Post-last-transition session status. */
  status: ExperienceSessionStatus;
  /** Monotonic revision; increments on every applied transition. */
  revision: number;
  /** Participant roster. */
  participants: ExperienceParticipant[];
  /** User-approved capabilities (subset of declared). */
  capabilityGrants: ExperienceCapability[];
  /** RP-context mode for model-controlled seats. */
  contextMode: ExperienceContextMode;
  /** Highest revision frozen into a queued/bound report. */
  reportFrontier: number;
  /** Deterministic-random seed + cursor (for deterministic_random capability). */
  randomSeed: string;
  randomCursor: number;
  /** Active slot within the branch (nullable; {branchId, activeSlot} is unique). */
  activeSlot: number | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * A durable effect record persisted before execution. Process interruption
 * after `running` reconciles to `unknown`; only an explicit user retry creates a
 * new attempt (incrementing `attemptCount`), preserving the original effect id
 * and audit history.
 */
export interface ExperienceEffect {
  effectId: ExperienceEffectId;
  sessionId: ExperienceSessionId;
  kind: ExperienceEffectKind;
  status: ExperienceEffectStatus;
  /** The revision at which the reducer requested this effect. */
  originatingRevision: number;
  /** Bounded JSON request payload. */
  request: unknown;
  /** Bounded JSON result payload (present when succeeded). */
  result?: unknown;
  /** Stable error string (present when failed/unknown). */
  error?: string;
  /** Number of attempts; only explicit user retry increments. */
  attemptCount: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * A visual resource: an editable, user-owned HTML/CSS/JS bundle that runs
 * sandboxed in an iframe and communicates only through the versioned
 * `VibeExperience` bridge. Scope metadata mirrors Script so a visual can be
 * global or owned by a character/persona/chat.
 */
export interface ExperienceVisual {
  visualId: ExperienceVisualId;
  name: string;
  /** The visual source bundle (editable; Wave 6 ships starters). */
  source: string;
  sourceHash: string;
  /** Bridge API version this visual targets. */
  apiVersion: number;
  /** Manifest ids this visual is compatible with (loose coupling). */
  compatibleManifestIds: string[];
  scopeType: LoreScopeType;
  characterId: string | null;
  personaId: string | null;
  chatId: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * A chat session bound to a character, persona, and prompt preset.
 *
 * `activeBranchId` points to the currently selected conversation branch.
 */

/** CE-C1: the kinds of entities a co-author chat can pin as Level-1 context.
 *  Mirrors the shared `LinkBindingTargetType` (apps/web) so the picker and the
 *  persisted shape use one vocabulary. The co-author prompt renders each
 *  pinned entity's full content as a read-only reference block. */
export const COAUTHOR_CONTEXT_TARGET_TYPES = [
  "character",
  "persona",
  "lorebook",
  "script",
] as const;
export type CoauthorContextTargetType =
  (typeof COAUTHOR_CONTEXT_TARGET_TYPES)[number];

/** CE-C1: a single pinned Level-1 context entity (type + id). Generalizes the
 *  CA-13 lorebook-id-only list so any of the four referenceable kinds can be
 *  pinned. Persisted as `coauthor_context_links_json` (SQL column retains its
 *  legacy `coauthor_lorebook_ids_json` name — no migration; legacy rows storing
 *  a bare `string[]` are lifted to `[{targetType:"lorebook",targetId}]` on read). */
export interface CoauthorContextLink {
  targetType: CoauthorContextTargetType;
  targetId: string;
}

export interface Chat {
  id: ChatId;
  characterId: CharacterId;
  personaId: PersonaId | null;
  title: string;
  status: ChatStatus;
  mode: ChatMode;
  activeBranchId: ChatBranchId;
  promptPresetId: PromptPresetId;
  toolProfileId: ToolProfileId;
  /** @deprecated Greeting selection is now stored as the selected variant on the first assistant message. */
  selectedGreetingIndex: number;
  /** Co-author mode only (CE-C1): entities the user explicitly pinned to
   *  this chat as read-only Level-1 editor context (right-panel picker). Any
   *  of character/persona/lorebook/script; the prompt renders each entity's
   *  full content as a reference block. NOT RP keyword activation. Empty for
   *  RP chats. */
  coauthorContextLinks: CoauthorContextLink[];
  /** Co-author mode only: the active author module ID. */
  coauthorModuleId: string | null;
  /** Per-chat dynamic prompt — content editable via the advanced prompt canvas
   *  `chatDynamicPrompt` slot. Position/role/depth are controlled by the preset's
   *  `PromptOrderEntry`. Persisted as a chat-row column. */
  dynamicPrompt: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ChatBranch {
  id: ChatBranchId;
  chatId: ChatId;
  parentBranchId: ChatBranchId | null;
  forkedFromMessageId: MessageId | null;
  label: string;
  createdAt: Timestamp;
  messageCount?: number;
}

export interface ChatSummary {
  id: ChatSummaryId;
  chatId: ChatId;
  branchId: ChatBranchId;
  label: string;
  summarizedFrom: number;
  summarizedTo: number;
  includeInContext: boolean;
  excludeSummarized: boolean;
  source: ChatSummarySource;
  sortOrder: number;
  contentHash: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ChatAutoSummaryConfig {
  enabled: boolean;
  everyN: number;
  useChatModel: boolean;
  excludeSummarized: boolean;
  providerProfileId?: string;
  model?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
  /** Opaque AI SDK replay metadata (for example Gemini 3 thoughtSignature). */
  providerOptions?: unknown;
}

export interface Message {
  id: MessageId;
  chatId: ChatId;
  branchId: ChatBranchId;
  role: MessageRole;
  authorType: AuthorType;
  position: number;
  content: string;
  state: MessageState;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  toolCalls?: ToolCall[];
  toolCallId?: string | null;
}

/**
 * An alternative response ("swipe") for a message.
 *
 * `isSelected` marks which variant is currently displayed.
 * `reasoning` and `reasoningDurationMs` capture chain-of-thought output
 * from thinking/reasoning models.
 */
export interface MessageVariant {
  id: MessageVariantId;
  messageId: MessageId;
  variantIndex: number;
  content: string;
  isSelected: boolean;
  finishReason: string | null;
  reasoning?: string;
  reasoningDurationMs?: number;
  modelId?: string | null;
  presetName?: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string | null;
  coauthorModuleId?: string | null;
  coauthorSkillId?: string | null;
  createdAt: Timestamp;
  /** Canonical per-variant Scene record (SCENE_TRACKER_PLAN); null/undefined
   *  when the variant has none. Owned by this variant's immutable id. */
  sceneTracker?: SceneTrackerRecord | null;
}

export interface SummaryMemorySnapshot {
  id: SummaryMemorySnapshotId;
  chatId: ChatId;
  branchId: ChatBranchId;
  kind: SummaryKind;
  summary: string;
  coversThroughMessageId: MessageId;
  createdAt: Timestamp;
}

/**
 * A single hit from a RAG retrieval pass (Phase 3).
 *
 * `score` indicates relevance; `matchedKeys` lists the keys that triggered
 * the match.
 */
export interface RetrievedMemoryHit {
  id: RetrievedMemoryHitId;
  chatId: ChatId;
  sourceType: "lore_entry" | "character_section" | "message" | "summary";
  sourceId: string;
  score: number;
  matchedKeys: string[];
  content: string;
  createdAt: Timestamp;
}

/** JSON-safe value persisted in prompt traces and downloadable without custom serializers. */
export type TraceJsonValue = string | number | boolean | null | TraceJsonValue[] | { [key: string]: TraceJsonValue };

/** One provider call inside a traced turn. Tool loops can produce multiple steps. */
export interface ProviderResponseStep {
  response?: {
    id?: string;
    timestamp?: string;
    modelId?: string;
    /** Response headers with credential-bearing fields removed. */
    headers?: Record<string, string>;
    /** Raw HTTP response body when the provider exposes one. */
    body?: TraceJsonValue;
  };
  providerMetadata?: TraceJsonValue;
  finishReason?: string;
  rawFinishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  /** Raw provider SSE payloads for this streaming step. */
  rawChunks?: TraceJsonValue[];
}

/** Provider response captured alongside the outbound prompt payload. */
export interface ProviderResponseTrace {
  mode: "nonstream" | "stream";
  steps: ProviderResponseStep[];
}

/**
 * Full audit record of an assembled prompt, used for debugging only — never
 * consumed at runtime.
 *
 * `assembledLayers` lists every layer that was included.
 * `finalPayload` is the exact JSON sent to the provider.
 * `providerResponse` records what the provider returned for each model step.
 */
export interface PromptTrace {
  id: PromptTraceId;
  chatId: ChatId;
  branchId: ChatBranchId;
  messageId: MessageId;
  model: string;
  presetName: string;
  assembledLayers: Array<{
    id: string;
    sourceType: string;
    sourceId: string;
    sourceName: string;
    position: "before_prompt" | "in_prompt" | "in_chat" | "hidden_system";
    priority: number;
    enabled: boolean;
    reason: string;
    tokenCount: number;
    text: string;
    injectionDepth?: number;
    modes?: string[];
  }>;
  tokenAccounting: Record<string, number>;
  activatedLoreEntries: LoreEntryId[];
  /** Per-entry activation reasons parallel to `activatedLoreEntries`. */
  activatedLoreDetail: ActivatedLoreDetail[];
  scriptInjections: Array<{
    scriptId: string;
    scriptName: string;
    personalityMutation: string;
    scenarioMutation: string;
    error?: string;
  }>;
  retrievedMemories: Array<Record<string, unknown>>;
  finalPayload: Record<string, unknown>;
  /** Absent on previews and traces persisted before response capture existed. */
  providerResponse?: ProviderResponseTrace | null;
  latencyMs: number;
  prefill?: string | null;
  compactionSummary?: string | null;
  sentConfig?: {
    systemRole: string | undefined;
    samplerConfig: Record<string, unknown>;
    messageCount: number;
    visionDescriptions?: Array<{
      attachmentId: string;
      name: string;
      type: "image" | "video";
      description: string;
    }>;
  } | null;
  createdAt: Timestamp;
}

export interface ToolProfile {
  id: ToolProfileId;
  name: string;
  mode: ToolProfileMode;
  instructions: string | null;
  metadata: Record<string, unknown>;
}

export interface PromptPreset {
  id: PromptPresetId;
  name: string;
  system: string;
  jailbreak: string;
  summary: string;
  tools: string;
  scriptAiSystemPrompt: string;
  aiAssistantPrompts: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** A single task in the objective route tree (INSIGHTS_PLAN). Flat array — order is the route order. */
export interface ObjectiveTask {
  id: string;
  description: string;
  status: ObjectiveTaskStatus;
}

/**
 * Goals mode (OGM): the enduring long-term goal. Always injected into the RP
 * prompt while its status is `pending`/`active`; skipped once `completed`/`abandoned`.
 * Singular — there is at most one long-term goal per chat.
 */
export interface ObjectiveLongTermGoal {
  description: string;
  status: ObjectiveTaskStatus;
}

/**
 * Goals mode (OGM): a short-term goal. Flat list — independent and unordered
 * relative to each other. Exactly one is `active` (the selected/injected one) at
 * a time; the rest are `pending`/`completed`/`abandoned`. Reuses the task status
 * set + the selectActiveTask invariant (first `active`, else first `pending`).
 */
export interface ObjectiveShortTermGoal {
  id: string;
  description: string;
  status: ObjectiveTaskStatus;
}

/** The full objective state for a chat (INSIGHTS_PLAN). Stored as JSON in chats.insights_objective_state_json. */
export interface ObjectiveState {
  /** Tracker mode — `route` (original ordered task route) or `goals` (long-term + short-term goals, OGM). Absent on legacy data → `route`. */
  mode?: ObjectiveMode;
  /** User's high-level goal. */
  objectiveDescription: string;
  /** Flat ordered task list — the route (route mode). */
  tasks: ObjectiveTask[];
  /** Goals mode: the enduring long-term goal, or null when unset. */
  longTermGoal: ObjectiveLongTermGoal | null;
  /** Goals mode: flat list of independent short-term goals (one active at a time). */
  shortTermGoals: ObjectiveShortTermGoal[];
  /** How often to auto-check completion (in qualifying assistant events). 0 = manual only. */
  autoCheckFrequency: number;
  /** Persisted qualifying assistant events accumulated since the last completed auto-check. */
  autoCheckEventCount: number;
  /** Number of recent branch messages supplied to the Objective model. */
  contextWindow: number;
  /** in_chat injectionDepth for the active-task layer; default 1 (just before the latest user message). */
  injectionDepth: number;
  /** Custom LLM prompts for generate / check / inject. */
  generatePrompt: string;
  checkPrompt: string;
  injectPrompt: string;
  /**
   * Secondary model selection (mirrors AutoSummaryConfig). When `useChatModel`
   * is true the objective generate/check runs on the chat's active provider +
   * its default model; when false, the pinned `providerProfileId` + `model`
   * are used. The insight call runs in parallel with the streaming chat (own
   * profile/signal), never blocking it.
   */
  useChatModel: boolean;
  providerProfileId: string | null;
  model: string | null;
}

/**
 * The full Scene Tracker config for a chat (SCENE_TRACKER_PLAN). Stored as JSON
 * under `chats.insights_config_json.tracker`, isolated from the Objective
 * config: a Scene config PATCH deep-merges only this sub-object and never
 * touches the Objective toggles or Objective state.
 *
 * `schema` is the user-authored shape grammar; `revision` is a monotonic
 * counter incremented on edit; `schemaHash` is the canonical hash of `schema`,
 * recomputed whenever the DSL changes, so records generated under an old schema
 * become invisible until regenerated. Defaults are fixed — see
 * `createDefaultSceneTrackerConfig`.
 */
export interface SceneTrackerConfig {
  /** The bounded shape grammar describing the scene state the model must fill. */
  schema: SceneTrackerDsl;
  /** When to auto-generate (after each assistant response, or manual only). */
  autoMode: SceneAutoMode;
  /** Number of recent branch messages supplied to the Scene generation model. */
  contextWindow: number;
  /** How many previous valid selected-variant records feed continuity input. */
  continuityLastN: number;
  /** in_chat injectionDepth for the sceneState prompt layer; default 1. */
  injectionDepth: number;
  /** How many of the latest valid selected-variant scenes to inject. */
  injectLastN: number;
  /** Serialization of the validated sceneState block for main-model injection. */
  promptFormat: ScenePromptFormat;
  /** Run Scene generation on the chat's active provider+model when true. */
  useChatModel: boolean;
  /** Custom generate prompt override (empty → the scene-generate.md asset default). */
  generatePrompt: string;
  /** Custom inject prompt override (empty → default). */
  injectPrompt: string;
  /** Per-chat scene tracker rules appended to the generate prompt base (empty → none). */
  rulesPrompt: string;
  /** Pinned provider for Scene generation when `useChatModel` is false. */
  providerProfileId: string | null;
  /** Pinned model for Scene generation when `useChatModel` is false. */
  model: string | null;
  /** Internal monotonic config revision; stamped on generated records for freshness. */
  revision: number;
  /** Canonical hash of `schema`; stamped on generated records so old-schema output is detectable. */
  schemaHash: string;
}

/**
 * One generated Scene record, canonical per immutable message variant. Stored
 * on `message_variants.scene_tracker_json` (SCN-3); `chats.insights_current_scene_json`
 * is a derived/rebuildable cache only.
 *
 * A record is a PERSISTED FACT, not a cache entry of the current generation
 * recipe: changing the tracker config (schema/model/provider/prompt/render/injection)
 * NEVER hides, invalidates, or deletes an already-saved record. Each record
 * carries its own `schema` + `promptFormat` snapshot so it stays self-describing
 * and renderable/injectable even after the live config moves on. Different-schema
 * records coexist in the same branch; their mass replacement happens only via an
 * explicit rebuild/backfill, never automatically.
 *
 * The stamped metadata serves two distinct roles:
 *  - `sourceHash` is a CORRECTNESS GUARD: a record whose source content drifted
 *    (the variant was edited while the LLM was working) is discarded at commit.
 *  - `schemaHash`/`configRevision` are IDENTITY + TRACE, never a visibility gate:
 *    `schemaHash` is reused only as a coherence check (whether a record may act
 *    as a continuity baseline or be injected into the current-schema prompt),
 *    and `configRevision` is pure trace. Neither makes a record invisible.
 *
 * `schema`/`promptFormat` are optional only because records persisted before this
 * contract carried no snapshot; they are ALWAYS set on newly generated/edited
 * records, and legacy readers fall back to the live config when absent.
 */
export interface SceneTrackerRecord {
  /** The immutable variant this record was generated for (ownership identity). */
  variantId: MessageVariantId;
  /** The config `schemaHash` captured at generation time (identity + coherence check; NOT a visibility gate). */
  schemaHash: string;
  /** The config `revision` captured at generation time (pure trace; NOT a visibility gate). */
  configRevision: number;
  /** Hash of the variant source content captured at generation time (correctness guard against content drift). */
  sourceHash: string;
  /** The schema DSL (with labels) this record was generated/edited under — its self-describing snapshot for rendering/injection. Absent only on legacy records (fall back to live config). */
  schema?: SceneTrackerDsl;
  /** The prompt format captured at generation time. Absent only on legacy records (fall back to live config). */
  promptFormat?: ScenePromptFormat;
  /** The validated scene state, matching the record's own `schema` snapshot. */
  sceneState: Record<string, unknown>;
  /** The model that produced this record (for trace). */
  modelId: string | null;
  generatedAt: Timestamp;
}

/** Outcome of one frozen manifest item in a Scene history-backfill run
 *  (SCENE_TRACKER_PLAN SCN-14). `skipped` = bypassed without an LLM call (the
 *  variant vanished, or its frozen source/schema/config fingerprint drifted
 *  since the run started); `failed` = an LLM/parse/persistence error. Succeeded
 *  items are NOT listed — they are implied by `processed - errors.length`. */
export interface SceneBackfillErrorEntry {
  /** Manifest index of the item. */
  index: number;
  variantId: string;
  messageId: string;
  kind: "failed" | "skipped";
  message: string;
}

/** Partial-success summary written when a backfill run reaches a terminal
 *  status (SCN-14). `succeeded` + `skipped` + `failed` is the count of items
 *  processed so far (the manifest total minus any unprocessed tail after a
 *  cancel). */
export interface SceneBackfillSummary {
  total: number;
  succeeded: number;
  skipped: number;
  failed: number;
}
