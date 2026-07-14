import type {
  CharacterId,
  CharacterVersionId,
  ChatBranchId,
  ChatId,
  ChatSummaryId,
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
} from "./platform-constants.js";

import type {
  SceneAutoMode,
  ScenePromptFormat,
  SceneTrackerDsl,
} from "./scene-tracker-constants.js";

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

/**
 * A chat session bound to a character, persona, and prompt preset.
 *
 * `activeBranchId` points to the currently selected conversation branch.
 */
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
  /** Co-author mode only (CA-13): lorebook ids the user explicitly bound to
   *  this chat as read-only editor context (right-panel picker). NOT RP
   *  keyword activation. Empty for RP chats. */
  coauthorLorebookIds: string[];
  /** Co-author mode only: the active author module ID. */
  coauthorModuleId: string | null;
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
  presetId?: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string | null;
  coauthorModuleId?: string | null;
  coauthorSkillId?: string | null;
  createdAt: Timestamp;
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

/**
 * Full audit record of an assembled prompt, used for debugging only — never
 * consumed at runtime.
 *
 * `assembledLayers` lists every layer that was included.
 * `finalPayload` is the exact JSON sent to the provider.
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

/** The full objective state for a chat (INSIGHTS_PLAN). Stored as JSON in chats.insights_objective_state_json. */
export interface ObjectiveState {
  /** User's high-level goal. */
  objectiveDescription: string;
  /** Flat ordered task list — the route. */
  tasks: ObjectiveTask[];
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
 * is a derived/rebuildable cache only. The freshness metadata (`schemaHash`,
 * `configRevision`, `sourceHash`) lets the service reject stale output after
 * the LLM await: a record whose stamped values no longer match the live
 * config/source is invisible and non-injectable until regenerated.
 */
export interface SceneTrackerRecord {
  /** The immutable variant this record was generated for (ownership identity). */
  variantId: MessageVariantId;
  /** The config `schemaHash` captured at generation time. */
  schemaHash: string;
  /** The config `revision` captured at generation time. */
  configRevision: number;
  /** Hash of the variant source content captured at generation time. */
  sourceHash: string;
  /** The validated scene state, matching the then-current schema. */
  sceneState: Record<string, unknown>;
  /** The model that produced this record (for trace). */
  modelId: string | null;
  generatedAt: Timestamp;
}
