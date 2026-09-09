import type { CoauthorTransport } from "./coauthor-transport-capabilities.js";

/** Generation mode (LOCAL_SUPPORT_PLAN LS-2a): how the server talks to the
 *  provider backend for this profile's generations.
 *  - `chat`       — chat-completions messages (default; every protocol).
 *  - `completion` — raw text completion: one flat prompt string to the
 *    OpenAI-style `/completions` endpoint (llama-server, LM Studio,
 *    ooba/TabbyAPI/Aphrodite via the generic openai_compat protocol).
 *
 *  The flip is SILENT and fully backward-compatible (owner 2026-09-09):
 *  switching modes changes only how FUTURE generations are sent — chat
 *  history, messages, presets, settings are never rewritten or migrated,
 *  and flipping back is instant. KoboldCPP native is always text completion
 *  (its own adapter serializes the flat prompt) and carries no toggle. */
export const GENERATION_MODE = {
  chat: "chat",
  completion: "completion",
} as const;

export type GenerationMode = typeof GENERATION_MODE[keyof typeof GENERATION_MODE];

/**
 * Canonical provider profile type — single source of truth.
 *
 * Matches ProviderStore.ProviderProfile from @vibe-tavern/db exactly.
 * All layers (DB, services, AI executors, client) use this type directly.
 * No adapters or field renames between layers.
 *
 * Client-facing code should derive via:
 *   ClientProviderProfile = Omit<StoredProviderProfileRecord, 'apiKey'> & { hasStoredApiKey: boolean }
 */
/** Per-provider proxy selection policy.
 *  - `inherit` — follow the global default proxy (or direct when no default).
 *  - `direct` — bypass the global default for this provider.
 *  - `proxy`  — use the provider's selected named proxy (`proxyId`). */
export const PROXY_MODE = {
  inherit: "inherit",
  direct: "direct",
  proxy: "proxy",
} as const;

export type ProviderProxyMode = typeof PROXY_MODE[keyof typeof PROXY_MODE];

export const MODEL_FAVORITE_SCOPE = {
  rp: "rp",
  coauthor: "coauthor",
  copilot: "copilot",
} as const;

export type ModelFavoriteScope = typeof MODEL_FAVORITE_SCOPE[keyof typeof MODEL_FAVORITE_SCOPE];

export interface StoredProviderProfileRecord {
  id: string;
  name: string;
  providerPreset: string;
  /** Co-Author-only OpenAI-compatible transport preference; RP ignores this field. */
  coauthorTransport: CoauthorTransport;
  /** Generation mode (LS-2a) — see {@link GENERATION_MODE}. Profile-level
   *  (never a per-model overlay field): the mode is a property of the
   *  connection, not of a bound model. */
  generationMode: GenerationMode;
  endpoint: string;
  apiKey: string | null;
  defaultModel: string | null;
  contextBudget: number | null;
  pinContextBudget: boolean;
  /** Token padding (LOCAL_SUPPORT_PLAN LS-1d): tokens subtracted from the
   *  effective context budget as a safety margin for chat-template overhead
   *  the estimator cannot see. 0 = disabled. Consumed via
   *  {@link effectiveContextBudget}. */
  tokenPadding: number;
  /** When true, the modal routes sampler/context edits to a per-model overlay
   *  (see {@link ModelSettingsSettings}) instead of the profile base. The active
   *  model's overlay merges over the base at generation time via
   *  {@link resolveEffectiveSettings}. */
  bindPerModel: boolean;
  /** Model-list display prefs (MODEL_LIST_FILTERS) — pure UI, no backend logic. */
  modelFreeOnly: boolean;
  modelGroupByOwner: boolean;
  maxTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  topA: number;
  typicalP: number;
  tfsZ: number;
  /** Adaptive-p (llama.cpp/KoboldCPP): target probability; −1 = disabled. */
  adaptiveTarget: number;
  /** Adaptive-p decay rate (0.0–0.99); applies only when adaptiveTarget ≥ 0. */
  adaptiveDecay: number;
  /** DynaTemp range (llama-server); 0 = disabled (upstream default). */
  dynatempRange: number;
  /** DynaTemp exponent (llama-server); applies only when dynatempRange > 0. */
  dynatempExponent: number;
  /** Top n-sigma (llama-server); 0 = disabled (upstream default). */
  topNSigma: number;
  /** Smoothing factor (llama-server); 0 = disabled (upstream default). */
  smoothingFactor: number;
  repeatLastN: number;
  mirostat: number;
  mirostatTau: number;
  mirostatEta: number;
  dryMultiplier: number;
  dryBase: number;
  dryAllowedLength: number;
  drySequenceBreakers: string[];
  /** DRY penalty window (llama-server); −1 = disabled (field omitted from the request — llama-server rejects −1), 0 = zero window (DRY inert), > 0 = real window. */
  dryPenaltyLastN: number;
  /** Antislop phrase banning (KoboldCPP only, native `banned_strings` request field). Exact-match strings; leading/trailing spaces are significant (" purr" ≠ "purr"). Empty = nothing sent. */
  bannedStrings: string[];
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
  /** Per-provider proxy selection policy (see {@link PROXY_MODE}). */
  proxyMode: ProviderProxyMode;
  /** Selected named proxy when `proxyMode === "proxy"`; null otherwise. */
  proxyId: string | null;
  isActive: boolean;
  /** Optional vision model slug from the same provider profile, used for image description fallback. */
  visionModel: string | null;
  /** Last-applied named sampler set (LOCAL_SUPPORT_PLAN LS-5a): the provider
   *  sampler panel's dropdown pre-selection + dirty-dot baseline. Null = no set
   *  applied. Set deletion clears the pointer (copy-on-select — the values live
   *  on the profile, the set is an inert template). */
  samplerSetId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Effective context budget for generation: the profile's `contextBudget` minus
 * its `tokenPadding` (LS-1d), floored at 0. Null budget passes through as null
 * ("auto" — the backend's model context length rules). Padding is a
 * profile-level knob (NOT a per-model overlay field): the chat template
 * overhead it compensates for is a property of the connection, not the model.
 */
export function effectiveContextBudget(
  contextBudget: number | null | undefined,
  tokenPadding: number | null | undefined,
): number | null {
  if (contextBudget == null) return null;
  const padding = tokenPadding ?? 0;
  return Math.max(0, contextBudget - (Number.isFinite(padding) ? padding : 0));
}

// ─── Per-model settings overlay ───────────────────────────────────────────────

/**
 * The sampler/context fields that can be overridden PER MODEL when a profile's
 * `bindPerModel` is ON. Every field is optional — absent (NOT `undefined`)
 * means "inherit the profile base". JSON serialization guarantees this: a
 * freshly built overlay round-trips through `JSON.stringify` with undefined
 * keys stripped, so consumers can spread the overlay over the base directly.
 *
 * Identity / view fields (`name`, `endpoint`, `apiKey`, `defaultModel`,
 * `visionModel`, `providerPreset`, `isActive`, `bindPerModel`, `customSamplers`,
 * timestamps, `id`) are deliberately NOT here — they always live on the base.
 */
export type ModelSettingsOverlay = Partial<
  Pick<
    StoredProviderProfileRecord,
    | 'contextBudget'
    | 'pinContextBudget'
    | 'maxTokens'
    | 'temperature'
    | 'topP'
    | 'topK'
    | 'minP'
    | 'topA'
    | 'typicalP'
    | 'tfsZ'
    | 'adaptiveTarget'
    | 'adaptiveDecay'
    | 'dynatempRange'
    | 'dynatempExponent'
    | 'topNSigma'
    | 'smoothingFactor'
    | 'repeatLastN'
    | 'mirostat'
    | 'mirostatTau'
    | 'mirostatEta'
    | 'dryMultiplier'
    | 'dryBase'
    | 'dryAllowedLength'
    | 'drySequenceBreakers'
    | 'dryPenaltyLastN'
    | 'bannedStrings'
    | 'xtcThreshold'
    | 'xtcProbability'
    | 'frequencyPenalty'
    | 'presencePenalty'
    | 'repetitionPenalty'
    | 'stopSequences'
    | 'logitBias'
    | 'seed'
    | 'reasoningEffort'
    | 'showReasoning'
    | 'streamResponse'
    | 'customSamplers'
  >
>;

/**
 * Merge a per-model overlay over the profile base. Pure (no I/O).
 *
 * Returns `base` unchanged (same reference) when `overlay` is `null`/`undefined`
 * — so callers with no overlay pay nothing. When an overlay is present, returns
 * a NEW profile object with every present overlay field overriding the base;
 * arrays/objects (`stopSequences`, `logitBias`, `drySequenceBreakers`,
 * `bannedStrings`) are replaced wholesale (NOT deep-merged) — the overlay owns
 * them entirely.
 *
 * Contract: an ABSENT field means "inherit base" (NOT an explicit `undefined`
 * field). The settingsJson round-trip via JSON.stringify/parse guarantees this
 * — undefined keys are dropped at serialization, so spreading the parsed
 * overlay over the base overrides only the keys the user actually set.
 *
 * The result keeps the base `id`, `name`, `endpoint`, `defaultModel`, etc.
 * (identity is never overridden — those keys are not in {@link ModelSettingsOverlay}).
 * This is the single place the generation boundary calls to derive effective settings.
 */
export function resolveEffectiveSettings(
  base: StoredProviderProfileRecord,
  overlay: ModelSettingsOverlay | null | undefined,
): StoredProviderProfileRecord {
  if (!overlay) return base;
  return { ...base, ...overlay };
}

// ────────────────────────────────────────────────────────────────────────────
// Lifecycle event
// ────────────────────────────────────────────────────────────────────────────

export const PROVIDER_PROFILE_CHANGE_KIND = {
  upsert: "upsert",
  delete: "delete",
} as const;

export type ProviderProfileChangeKind =
  typeof PROVIDER_PROFILE_CHANGE_KIND[keyof typeof PROVIDER_PROFILE_CHANGE_KIND];

/**
 * A profile was created, edited or deleted.
 *
 * Exists so features that cache per-profile state (currently the quota poller)
 * can invalidate it without the providers module importing them — the
 * dependency arrow points one way, and it points at the bus.
 *
 * The three booleans are what actually invalidate downstream state: a preset or
 * endpoint change may mean a different VENDOR, an API-key change means a
 * different ACCOUNT. All three are false on a create and on a cosmetic edit.
 */
export interface ProviderProfileChangedEvent {
  readonly profileId: string;
  readonly changeKind: ProviderProfileChangeKind;
  readonly presetChanged: boolean;
  readonly endpointChanged: boolean;
  readonly apiKeyChanged: boolean;
}

declare module "./event-bus.js" {
  interface EventMap {
    "provider.profile.changed": ProviderProfileChangedEvent;
  }
}
