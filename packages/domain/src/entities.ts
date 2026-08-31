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
  RegexPresetId,
  RegexProfileId,
  RetrievedMemoryHitId,
  ScriptId,
  SummaryMemorySnapshotId,
  ToolProfileId,
  TtsProfileId,
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
  /** Book-level default for entry.useGroupScoring (ST's global switch, scoped to the book). Effective flag: entry.useGroupScoring ?? book.useGroupScoring. See LOREBOOK_GROUP_SCORING_PARITY_REPORT. */
  useGroupScoring: boolean;
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
  /** Tri-state (ST parity): null = inherit the book-level useGroupScoring default, true/false = explicit per-entry override. See LOREBOOK_GROUP_SCORING_PARITY_REPORT. */
  useGroupScoring: boolean | null;
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

// ─── Regex presets (REGEX_EXTENSION_PLAN, RX-1) ────────────────────────
//
// Named SillyTavern-parity find/replace scripts (ST `RegexScriptData`). The
// engine that runs them lives in `packages/prompt-pipeline` (pure); the store
// and the chat-context resolver live in `packages/db`. Binding targets are
// characters and prompt presets only (persona excluded by design) via the
// `regexLinks` junction — the third instance of the lorebook/script link
// pattern.

/** ST regex placement codes, preserved numerically for card/preset import
 *  parity. `SlashCommand` is reserved: VT has no slash-command surface today
 *  (REGEX_EXTENSION_PLAN constraint). */
export const REGEX_PLACEMENT = {
  UserInput: 1,
  AiOutput: 2,
  SlashCommand: 3,
  WorldInfo: 5,
  Reasoning: 6,
} as const;
export type RegexPlacement = (typeof REGEX_PLACEMENT)[keyof typeof REGEX_PLACEMENT];

/** How macros are substituted into the find pattern (ST `substituteRegex`). */
export const REGEX_SUBSTITUTE = {
  None: 0,
  Raw: 1,
  Escaped: 2,
} as const;
export type RegexSubstituteMode = (typeof REGEX_SUBSTITUTE)[keyof typeof REGEX_SUBSTITUTE];

/** Binding targets for a regex preset — character and prompt preset only
 *  (same vocabulary the `lorebookLinks`/`scriptLinks` junctions use). */
export const REGEX_TARGET_TYPE = {
  Character: "character",
  Preset: "preset",
} as const;
export type RegexTargetType = (typeof REGEX_TARGET_TYPE)[keyof typeof REGEX_TARGET_TYPE];

/**
 * One named SillyTavern-parity regex script (ST `RegexScriptData`).
 *
 * `markdownOnly` / `promptOnly` are ST's ephemerality flags; their four
 * combinations are the apply-target modes (see {@link RegexApplyTarget}):
 * default = persist into the message, `markdownOnly` = display-only,
 * `promptOnly` = prompt-only, both = display+prompt without ever writing the
 * stored message.
 *
 * `placement` lists the hooks the preset runs at (see {@link REGEX_PLACEMENT}).
 * Depth targeting follows ST: depth 0 is the last message, counting backward;
 * `null` min/max means unlimited.
 */
export interface RegexPreset {
  id: RegexPresetId;
  name: string;
  /** Find pattern in ST's `/pattern/flags` notation. */
  findRegex: string;
  /** Replacement; supports `{{match}}`, `$1`.. capture groups and `$<name>`. */
  replaceString: string;
  /** Substrings stripped from each match before replacement (ST "Trim Out"). */
  trimStrings: string[];
  substituteRegex: RegexSubstituteMode;
  disabled: boolean;
  markdownOnly: boolean;
  promptOnly: boolean;
  runOnEdit: boolean;
  minDepth: number | null;
  maxDepth: number | null;
  placement: RegexPlacement[];
  /** Applies to every chat regardless of bindings (like global lorebooks). */
  isGlobal: boolean;
  sortOrder: number;
  /** The profile this rule belongs to (R-13), or null for a standalone rule. */
  profileId: RegexProfileId | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * A regex profile (R-13) — an ordered bundle of regex rules with a single
 * binding + master enable switch (the lorebook analogy). A member rule fires
 * only if the profile is enabled AND bound (or global); the rule's own
 * `isGlobal`/`regexLinks` are inert while it is a member (preserved in the DB
 * and reactivated on detach). Persona is excluded as a binding target by
 * design — same vocabulary as `RegexPreset`.
 */
export interface RegexProfile {
  id: RegexProfileId;
  name: string;
  /** Master switch — when disabled, NO member rule fires. */
  disabled: boolean;
  /** Applies to every chat regardless of bindings (like global lorebooks). */
  isGlobal: boolean;
  /** Application order within the flat list (shared sort space with presets). */
  sortOrder: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Many-to-many binding for a regex profile — the fourth instance of the
 *  lorebook/script junction pattern ({entityId, targetType, targetId}). */
export interface RegexProfileLink {
  regexProfileId: RegexProfileId;
  targetType: RegexTargetType;
  targetId: string;
}

/** Many-to-many binding mirroring `lorebookLinks`/`scriptLinks` — the third
 *  instance of that junction pattern ({entityId, targetType, targetId}). */
export interface RegexLink {
  regexPresetId: RegexPresetId;
  targetType: RegexTargetType;
  targetId: string;
}

/** UI-facing union of the four markdownOnly/promptOnly combinations. */
export type RegexApplyTarget = "persist" | "display" | "prompt" | "display_prompt";

/** Maps the ST ephemerality flags to the apply-target mode. */
export function regexApplyTargetOf(
  preset: Pick<RegexPreset, "markdownOnly" | "promptOnly">,
): RegexApplyTarget {
  if (preset.markdownOnly && preset.promptOnly) return "display_prompt";
  if (preset.markdownOnly) return "display";
  if (preset.promptOnly) return "prompt";
  return "persist";
}

/** Inverse of {@link regexApplyTargetOf}: maps an apply-target mode back to
 *  the ST ephemerality flags. */
export function applyTargetFlags(target: RegexApplyTarget): { markdownOnly: boolean; promptOnly: boolean } {
  switch (target) {
    case "persist":
      return { markdownOnly: false, promptOnly: false };
    case "display":
      return { markdownOnly: true, promptOnly: false };
    case "prompt":
      return { markdownOnly: false, promptOnly: true };
    case "display_prompt":
      return { markdownOnly: true, promptOnly: true };
  }
}

// ─── TTS profiles (TTS_PLAN TS-1) ──────────────────────────────────────────
//
// Named text-to-speech voices ("Kokoro — Sarah", "Gemini — Kore"), each pairing
// a backend with its config + selected voice. TTS config deliberately lives
// here, NOT on provider profiles — `providerProfiles` is LLM-generation-
// specific (TTS_DESIGN Resolution, locked). `config` is a loose record on
// purpose: per-backend shapes are owned by the backend registry's contracts
// (TS-2+); the domain entity only guarantees JSON round-tripping.

/** Backend discriminators for the v1 roster (TTS_DESIGN tier ladder). */
export const TTS_BACKEND = {
  /** Tier 0 — in-browser Kokoro via kokoro-js (Web Worker, no server). */
  Kokoro: "kokoro",
  /** Tier 3/1 — any OpenAI-compatible `/v1/audio/speech` endpoint (cloud or local server). */
  OpenAiCompatible: "openai-compatible",
  /** Tier 1 — native Gemini TTS (Interactions API). */
  Gemini: "gemini",
  /** Tier 2 — native ElevenLabs. */
  ElevenLabs: "elevenlabs",
  /** TPE-4 — native Cartesia (Sonic; first Wave A clone-capable provider). */
  Cartesia: "cartesia",
  /** TPE-5 — native Inworld (Realtime TTS; IVC cloning, steering tags). */
  Inworld: "inworld",
  /** TPE-6 — native LMNT (Blizzard; instant cloning, top_p/temperature tuning). */
  Lmnt: "lmnt",
  /** TPE-7 — native MiniMax (speech-2.8; two-step clone, interjection tags). */
  MiniMax: "minimax",
} as const;
export type TtsBackendSlug = (typeof TTS_BACKEND)[keyof typeof TTS_BACKEND];

/** Voice-map binding targets for a TTS profile — character and persona. The
 *  voice map answers "who speaks with which voice", so unlike the regex /
 *  lorebook junctions (character + prompt preset) it carries persona (the
 *  user's own voice) and has no preset target. */
export const TTS_TARGET_TYPE = {
  Character: "character",
  Persona: "persona",
} as const;
export type TtsTargetType = (typeof TTS_TARGET_TYPE)[keyof typeof TTS_TARGET_TYPE];

/** Voice-map binding mode (TTS_PLAN TS-9a-foundation). `voice` = the target
 *  speaks with the linked profile; `disabled` = the target is explicitly
 *  excluded from narration (the design's disable-per-character marker —
 *  expressed as a link row against the DEFAULT profile so the junction keeps
 *  its FK shape; the resolver treats any disabled-link-on-target as a skip
 *  regardless of profile). Additive to the TS-1 junction: rows written
 *  before this column default to `voice`. */
export const TTS_LINK_MODE = {
  Voice: "voice",
  Disabled: "disabled",
} as const;
export type TtsLinkMode = (typeof TTS_LINK_MODE)[keyof typeof TTS_LINK_MODE];

/** Backend-specific config bag (model, endpoint, sliders, ...). `unknown`
 *  values are correct at this type-erased boundary: the real shapes live in
 *  the per-backend zod contracts + backend registry (TS-2+). The SECRET
 *  apiKey lives in the typed `TtsProfile.apiKey` column (TE2-16) — it never
 *  travels inside this bag; store writes strip it defensively. */
export type TtsProfileConfig = Record<string, unknown>;

/** One named TTS voice profile. */
export interface TtsProfile {
  id: TtsProfileId;
  /** Human-readable profile name ("Kokoro — Sarah"). */
  name: string;
  /** Backend discriminator (see {@link TTS_BACKEND}). */
  backend: TtsBackendSlug;
  /** Backend-specific config bag, persisted as JSON — carries NO secret (the
   *  key lives in the typed {@link TtsProfile.apiKey} column; TE2-16). */
  config: TtsProfileConfig;
  /** Write-only API key for the backend — typed column (TE2-16), never
   *  serialized to the client; the wire record reports `hasStoredApiKey`
   *  instead. Empty string or null = no own key (local servers, or profiles
   *  that resolve their key from {@link TtsProfile.providerRef}). */
  apiKey: string | null;
  /** Optional `providerProfiles.id` link (TE2-16): when set and the profile
   *  has no own key, synthesis/test requests resolve key + baseUrl from the
   *  provider store SERVER-SIDE — the provider key never crosses the API
   *  boundary either. */
  providerRef: string | null;
  /** Selected voice id — backend-specific ("af_heart", "Kore", ElevenLabs
   *  voice_id, ...); empty until the user picks one (the editor gates
   *  "ready" / preview on it). */
  voiceId: string;
  /** Optional narrator voice id for dual-voice profiles — when non-null, quoted
   *  spans use `voiceId` and the rest uses this id; null = single-voice mode. */
  narratorVoiceId: string | null;
  /** Language hint (BCP-47-ish); English-first per owner decision. */
  lang: string;
  /** Deterministic order in the profile list. */
  sortOrder: number;
  /** The voice map's [Default Voice] — at most one profile at a time
   *  (store-maintained pointer; the fallback voice when no override binds). */
  isDefault: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Many-to-many voice-map binding — which characters/personas speak with
 *  which profile. Junction-pattern instance with a persona-aware target
 *  vocabulary (see {@link TTS_TARGET_TYPE}). `mode` distinguishes a voice
 *  binding from an explicit narration-disable for the target. */
export interface TtsProfileLink {
  ttsProfileId: TtsProfileId;
  targetType: TtsTargetType;
  targetId: string;
  mode: TtsLinkMode;
}

// ─── TTS backend capabilities (TTS_PLAN TS-2) ───────────────────────────────
//
// Static capability flags per backend slug. The exhaustive Record means adding
// a TTS_BACKEND slug without flags fails typecheck — the same lock-step
// prevention property as the providers protocol registry.

export const TTS_TRANSPORT = {
  Inbrowser: "inbrowser",
  Local: "local",
  Cloud: "cloud",
} as const;
export type TtsTransport = (typeof TTS_TRANSPORT)[keyof typeof TTS_TRANSPORT];

export interface TtsBackendCapabilities {
  transport: TtsTransport;
  openaiCompatible: boolean;
  supportsStreaming: boolean;
  supportsCloning: boolean;
  supportsVoiceList: boolean;
  supportsSpeed: boolean;
  requiresApiKey: boolean;
}

export const TTS_BACKEND_CAPABILITIES: Record<TtsBackendSlug, TtsBackendCapabilities> = {
  [TTS_BACKEND.Kokoro]: {
    transport: TTS_TRANSPORT.Inbrowser,
    openaiCompatible: false,
    supportsStreaming: true,
    supportsCloning: false,
    supportsVoiceList: true,
    supportsSpeed: true,
    requiresApiKey: false,
  },
  [TTS_BACKEND.OpenAiCompatible]: {
    transport: TTS_TRANSPORT.Local,
    openaiCompatible: true,
    supportsStreaming: true,
    supportsCloning: false,
    supportsVoiceList: true,
    supportsSpeed: true,
    requiresApiKey: false,
  },
  [TTS_BACKEND.Gemini]: {
    transport: TTS_TRANSPORT.Cloud,
    openaiCompatible: false,
    supportsStreaming: false,
    supportsCloning: false,
    supportsVoiceList: true,
    supportsSpeed: false,
    requiresApiKey: true,
  },
  [TTS_BACKEND.ElevenLabs]: {
    transport: TTS_TRANSPORT.Cloud,
    openaiCompatible: false,
    supportsStreaming: false,
    supportsCloning: false,
    supportsVoiceList: true,
    supportsSpeed: true,
    requiresApiKey: true,
  },
  [TTS_BACKEND.Cartesia]: {
    transport: TTS_TRANSPORT.Cloud,
    openaiCompatible: false,
    // Bytes endpoint streams the HTTP body, but our generate() buffers —
    // the capability flag describes OUR transport, not Cartesia's.
    supportsStreaming: false,
    supportsCloning: true,
    supportsVoiceList: true,
    supportsSpeed: true,
    requiresApiKey: true,
  },
  [TTS_BACKEND.Inworld]: {
    transport: TTS_TRANSPORT.Cloud,
    openaiCompatible: false,
    // generate() buffers the JSON/base64 response — no streaming on our
    // side (the streaming endpoint exists, but the buffered path is what
    // the profile editor's preview/synthesis use).
    supportsStreaming: false,
    supportsCloning: true,
    supportsVoiceList: true,
    supportsSpeed: true,
    requiresApiKey: true,
  },
  [TTS_BACKEND.Lmnt]: {
    transport: TTS_TRANSPORT.Cloud,
    openaiCompatible: false,
    // The bytes endpoint streams, but generate() buffers it whole.
    supportsStreaming: false,
    supportsCloning: true,
    supportsVoiceList: true,
    // LMNT has NO speed parameter — its tuning surface is top_p
    // (stability) + temperature (expressiveness) instead.
    supportsSpeed: false,
    requiresApiKey: true,
  },
  [TTS_BACKEND.MiniMax]: {
    transport: TTS_TRANSPORT.Cloud,
    openaiCompatible: false,
    // stream:false on the t2a endpoint; generate() buffers the hex audio.
    supportsStreaming: false,
    supportsCloning: true,
    supportsVoiceList: true,
    supportsSpeed: true,
    requiresApiKey: true,
  },
};

/**
 * Classify the transport of an OpenAI-compatible TTS endpoint by URL host.
 *
 * Local loopback hosts (localhost / 127.0.0.1 / [::1], any port) are
 * classified as "local"; everything else and unparseable input as "cloud".
 * Failing toward the stricter tier is intentional: an ambiguous endpoint
 * should surface cloud-key expectations rather than silently assuming a local
 * server that is not running.
 */
export function classifyOpenAiCompatTransport(endpoint: string): TtsTransport {
  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
      return TTS_TRANSPORT.Local;
    }
    return TTS_TRANSPORT.Cloud;
  } catch {
    return TTS_TRANSPORT.Cloud;
  }
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
/** The interaction mode a manifest declares (RM-1): turn-based (the default,
 *  host-mediated advance calls) or realtime (fixed-timestep ticks, frame-side
 *  loop). Mirrors `experienceManifestSchema`'s enum in api-contracts. */
export type ExperienceManifestMode = "turn" | "realtime";

export interface ExperienceManifest {
  id: string;
  name: string;
  /** Interaction mode. Absent on stored turn-based sessions (pre-RM-1 data);
  *  discovery output always carries it (the schema defaults it to "turn"). */
  mode?: ExperienceManifestMode;
  /** The realtime fixed timestep in ms — present IFF mode is "realtime"
  *  (16..1000, enforced by the contracts schema's iff rule). */
  tickMs?: number;
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

// ─── Setup descriptor (IR-70F) ───────────────────────────────────────────────
//
// A package may declare an OPTIONAL bounded setup-field list (IR-70F). The host
// renders these as validated settings before launch (IR-73A); the rules `create`
// method receives the submitted values as `settings`. This is discovery metadata
// only — it does not add a lifecycle method and does not affect runtime
// create/project/actions/reduce/choose/flavor behavior. A package with no setup
// descriptor registers nothing here and remains byte-for-byte valid. These
// canonical shapes are readonly-compatible (frozen at the kernel boundary after
// schema normalization).

/** One option of a select setup field. Value is a bounded nonblank id; label is
 *  human-facing. */
export interface ExperienceSetupFieldOption {
  value: string;
  label: string;
}

/** Base fields every setup field carries (id/label/description). */
interface ExperienceSetupFieldBase {
  id: string;
  label: string;
  description?: string;
}

/** A free-text setup field. Length bounds are integers in 0..2000; min<=max; a
 *  declared default must satisfy the declared bounds. */
export interface ExperienceSetupFieldText extends ExperienceSetupFieldBase {
  kind: "text";
  placeholder?: string;
  required?: boolean;
  default?: string;
  minLength?: number;
  maxLength?: number;
}

/** A numeric setup field. All numbers finite; step > 0; min<=max; a declared
 *  default must lie within the declared min/max. */
export interface ExperienceSetupFieldNumber extends ExperienceSetupFieldBase {
  kind: "number";
  required?: boolean;
  default?: number;
  min?: number;
  max?: number;
  step?: number;
}

/** A boolean toggle setup field. */
export interface ExperienceSetupFieldBoolean extends ExperienceSetupFieldBase {
  kind: "boolean";
  default?: boolean;
}

/** A single-choice setup field. Options are 1..64; option values are bounded
 *  nonblank unique ids; a declared default must equal one of the option values. */
export interface ExperienceSetupFieldSelect extends ExperienceSetupFieldBase {
  kind: "select";
  required?: boolean;
  default?: string;
  options: ExperienceSetupFieldOption[];
}

/** A single declared setup field — discriminated by `kind`. */
export type ExperienceSetupField =
  | ExperienceSetupFieldText
  | ExperienceSetupFieldNumber
  | ExperienceSetupFieldBoolean
  | ExperienceSetupFieldSelect;

/** The optional setup descriptor a package registers: a bounded list of fields
 *  (at most 32) with unique ids. Omitted by packages with no setup surface. */
export interface ExperienceSetupDefinition {
  fields: ExperienceSetupField[];
}

/** A participant seat declared by an experience's settings. */
export interface ExperienceParticipant {
  id: string;
  label: string;
  controller: ExperienceController;
  /**
   * Pinned provider profile for a model-controlled seat (IR-70E). Present only
   * when `controller === "model"`, alongside {@link modelId}. A new start
   * request must pin BOTH for every model seat; a legacy persisted participant
   * with neither field falls back to the active provider/default model at
   * effect time. Always absent for human/script seats.
   */
  providerProfileId?: string;
  /**
   * Pinned model id for a model-controlled seat (IR-70E). Present only when
   * `controller === "model"`, alongside {@link providerProfileId}. See that
   * field for the legacy-fallback + malformed-rejection semantics.
   */
  modelId?: string;
  /**
   * User-pulled library character behind this seat (report item 6b). Present
   * only on model-controlled seats (the start schema enforces that). The live
   * id rides along for per-character prompt-override lookup at effect time;
   * the frozen card snapshot lives in {@link character}.
   */
  characterId?: string;
  /**
   * Frozen character-card snapshot captured at session start (report item
   * 6b). The session keeps answering with this identity even after the source
   * character is deleted from the library. Server-authoritative: built by the
   * lifecycle at start, never accepted from a client start request.
   */
  character?: ExperienceSeatCharacter;
}

/** A frozen character-card snapshot for a model seat (report item 6b).
 * Structurally compatible with the prompt-pipeline's context character
 * snapshot (defined there because prompt-pipeline imports DOWN into domain —
 * the domain copy is the authority for the persisted participant shape). */
export interface ExperienceSeatCharacter {
  id: string;
  name: string;
  description: string;
  scenario?: string | null;
  personality?: string | null;
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

// ─── RP report binding (IR-52, Wave 5) ───────────────────────────────────────

/**
 * One public event inside a frozen RP report. This is the Writer-visible half
 * of an {@link ExperienceEvent}: the `visibility` discriminator is stripped at
 * freeze time because a bound report is ALL public by construction (hidden
 * events never leave the reducer). The ordinary RP Writer reads these as
 * resolved facts and narrates them; it never chooses moves or receives tools.
 */
export interface ExperienceReportEvent {
  /** Bounded event type id from the reducer (e.g. "round", "move", "score"). */
  type: string;
  /** Optional bounded detail payload — the script's prompt-efficient prose or
   *  structured facts for this event. Rendered verbatim by the formatter. */
  detail?: unknown;
}

/**
 * The self-describing public report stored as `publicEventsJson` on a bound
 * experience attachment. A bound attachment has NO foreign key to its session
 * (it survives session deletion — see `experience_attachments.sessionId`), so
 * the report MUST carry its own title and public events rather than joining a
 * session row that may no longer exist. It NEVER carries hidden state — the
 * hidden checkpoint lives in the separate `hiddenStateCheckpointJson` column
 * and is read only on branch-fork restore, never on prompt assembly.
 */
export interface ExperiencePublicReport {
  /** Identifies the experience (manifest/game name) for the Writer. */
  title: string;
  /** Optional one-line setup/context line (e.g. "Round 3 — X to move"). */
  summary?: string;
  /** Ordered public events the Writer narrates as authoritative facts. */
  events: ReadonlyArray<ExperienceReportEvent>;
}

/**
 * The message-scoped projection of a bound experience attachment that the
 * prompt-pipeline formatter consumes. Produced by mapping a stored
 * `ExperienceAttachmentRow` (parsing its `publicEventsJson` defensively);
 * the formatter is pure and read-only over this. Mirrors {@link DiceRollSnapshot}
 * in role: an already-bound immutable snapshot that assembly never re-executes.
 */
export interface ExperienceReportSnapshot {
  /** Attachment kind: "report" (public events) | "transcript" (future Messenger
   *  alternating dialogue). Selects the formatter wrapper. */
  kind: string;
  /** Session revision at the freeze point (for reference; the snapshot is
   *  immutable regardless of later session advances). */
  sessionRevision: number;
  /** The parsed self-describing public report. */
  title: string;
  /** Optional one-line summary, lifted from the report envelope. */
  summary?: string;
  /** Public events the Writer narrates. */
  events: ReadonlyArray<ExperienceReportEvent>;
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
  /** TTS narration annotation (TPE-1, AN-1): the annotated copy of this
   *  variant's content — expressive tags inserted, text otherwise identical.
   *  Null/undefined = not annotated; narration then reads the content itself.
   *  A persisted fact: content edits do NOT clear it. */
  ttsAnnotation?: string | null;
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
