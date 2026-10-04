import { GENERATION_MODE, PROVIDER_PROFILE_GENERATION_DEFAULTS, type ModelSettingsOverlay, type StoredProviderProfileRecord } from "./provider-profile.js";

/** Max output tokens a Co-Author connection starts from (owner ruling
 *  2026-10-03 — the one deliberate deviation from the RP default of 2000). */
export const COAUTHOR_DEFAULT_MAX_TOKENS = 8_000;

/** Context budget applied when the selected model's context length is unknown
 *  (owner ruling 2026-10-03: this default is only for models whose context
 *  length we do not know). CG-4's model picker auto-fills the real context
 *  length over this; it is the never-null floor of the resolved set. */
export const COAUTHOR_UNKNOWN_CONTEXT_BUDGET = 128_000;

/**
 * The resolved Co-Author generation set: every {@link ModelSettingsOverlay}
 * field present and concrete. `contextBudget` is narrowed to a plain number —
 * the Co-Author has no "auto" budget (a stored null — e.g. from a legacy row —
 * resolves to {@link COAUTHOR_UNKNOWN_CONTEXT_BUDGET}), so consumers (the
 * generation boundary in CG-2, the modal and the token counter in CG-4) never
 * handle null.
 */
export type CoauthorGenerationSettings = Omit<Required<ModelSettingsOverlay>, "contextBudget"> & {
  contextBudget: number;
};

/**
 * Defaults a Co-Author connection with no saved set starts from (owner ruling
 * 2026-10-03): the same sampler defaults as a brand-new RP connection
 * (`PROVIDER_PROFILE_GENERATION_DEFAULTS`, provider-profile.ts) except max
 * output 8 000 and context budget 128 000.
 */
export const COAUTHOR_GENERATION_DEFAULTS: CoauthorGenerationSettings = {
  ...PROVIDER_PROFILE_GENERATION_DEFAULTS,
  maxTokens: COAUTHOR_DEFAULT_MAX_TOKENS,
  contextBudget: COAUTHOR_UNKNOWN_CONTEXT_BUDGET,
};

/**
 * Resolve a connection's effective Co-Author generation set. Pure (no I/O) —
 * the ONE derivation (COAUTHOR_OWN_GENERATION_SETTINGS_PLAN): the generation
 * boundary (CG-2), the Co-Author modal and the token counter (CG-4) all read
 * this function, never a second hand-written default.
 *
 * `stored` is the row's `settings_json` exactly as persisted — a partial set
 * (the CG-1 seed stores only the values the legacy global overrides carried)
 * is completed with {@link COAUTHOR_GENERATION_DEFAULTS}; absent fields mean
 * "take the default", the same absent-≠-undefined contract as
 * `resolveEffectiveSettings` (JSON serialization strips undefined keys). A
 * null `contextBudget` in a stored set also resolves to the unknown-context
 * budget — the returned `contextBudget` is always a concrete number.
 */
export function resolveCoauthorGenerationSettings(
  stored: ModelSettingsOverlay | null | undefined,
): CoauthorGenerationSettings {
  if (!stored) return COAUTHOR_GENERATION_DEFAULTS;
  const merged = { ...COAUTHOR_GENERATION_DEFAULTS, ...stored };
  return { ...merged, contextBudget: merged.contextBudget ?? COAUTHOR_UNKNOWN_CONTEXT_BUDGET };
}

/**
 * Build the generation-ready Co-Author profile from connection identity and
 * its independent generation set. Per-model RP bindings, token padding, and
 * completion mode are intentionally disabled: none has a Co-Author storage
 * field, and reading any of them from the connection profile would reintroduce
 * RP inheritance.
 */
export function resolveCoauthorGenerationProfile(
  profile: StoredProviderProfileRecord,
  model: string,
  stored: ModelSettingsOverlay | null | undefined,
): StoredProviderProfileRecord & { defaultModel: string } {
  return {
    ...profile,
    ...resolveCoauthorGenerationSettings(stored),
    defaultModel: model,
    generationMode: GENERATION_MODE.chat,
    bindPerModel: false,
    tokenPadding: 0,
  };
}
