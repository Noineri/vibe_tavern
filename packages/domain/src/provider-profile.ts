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
export interface StoredProviderProfileRecord {
  id: string;
  name: string;
  providerPreset: string;
  endpoint: string;
  apiKey: string | null;
  defaultModel: string | null;
  contextBudget: number | null;
  pinContextBudget: boolean;
  /** When true, the modal routes sampler/context edits to a per-model overlay
   *  (see {@link ModelSettingsSettings}) instead of the profile base. The active
   *  model's overlay merges over the base at generation time via
   *  {@link resolveEffectiveSettings}. */
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
  /** Optional vision model slug from the same provider profile, used for image description fallback. */
  visionModel: string | null;
  createdAt: string;
  updatedAt: string;
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
    | 'repeatLastN'
    | 'mirostat'
    | 'mirostatTau'
    | 'mirostatEta'
    | 'dryMultiplier'
    | 'dryBase'
    | 'dryAllowedLength'
    | 'drySequenceBreakers'
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
  >
>;

/**
 * Merge a per-model overlay over the profile base. Pure (no I/O).
 *
 * Returns `base` unchanged (same reference) when `overlay` is `null`/`undefined`
 * — so callers with no overlay pay nothing. When an overlay is present, returns
 * a NEW profile object with every present overlay field overriding the base;
 * arrays/objects (`stopSequences`, `logitBias`, `drySequenceBreakers`) are
 * replaced wholesale (NOT deep-merged) — the overlay owns them entirely.
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
