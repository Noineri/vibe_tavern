import { PROVIDER_PROFILE_GENERATION_DEFAULTS, resolveEffectiveSettings, type ModelSettingsOverlay, type StoredProviderProfileRecord } from "@vibe-tavern/domain";
import type { ProviderProfileRecord } from "../api/types.js";

/** Overlay row subset the effective-settings resolution needs (the DTO rows
 *  carry identity/timestamps on top of this). */
export interface ModelSettingsOverlayRow {
  modelId: string;
  settings: ModelSettingsOverlay;
}

/**
 * The profile the ACTIVE model generates with — the chat-side READ for RP
 * (token-counter budget + max output, the context-memory window meter).
 *
 * Mirrors the backend's overlay policy (services/api chat-adapter
 * `resolveEffectiveProfileOrThrow`): when the profile binds settings per
 * model, the active model's saved overlay merges over the base THROUGH the
 * same domain derivation the generation boundary calls
 * (`resolveEffectiveSettings`) — no second local merge. Binding OFF, no
 * active model, or no overlay row for the model → the base record itself
 * (same reference), which is exactly what generation uses in those cases.
 */
export function resolveActiveModelEffectiveProfile(
  base: ProviderProfileRecord,
  activeModelId: string | null | undefined,
  overlays: ReadonlyArray<ModelSettingsOverlayRow> | undefined,
): ProviderProfileRecord {
  if (!base.bindPerModel || activeModelId == null) return base;
  const overlay = overlays?.find((row) => row.modelId === activeModelId)?.settings ?? null;
  if (!overlay) return base;
  // The wire record omits the secret (ProviderProfileRecord has no apiKey), so
  // adorn it with a redacted null for the domain signature; apiKey is not an
  // overlay field, so the merge can never write a real one, and the result is
  // stripped back to the wire shape below.
  // NAI-1b: the wire record now carries the six NovelAI sampler fields, so a
  // present value passes through; records without them (older clients) still
  // fall back to the domain defaults. The domain constant stays the single
  // derivation point — no second value source.
  const storedBase: StoredProviderProfileRecord = {
    ...base,
    apiKey: null,
    unifiedLinear: base.unifiedLinear ?? PROVIDER_PROFILE_GENERATION_DEFAULTS.unifiedLinear,
    unifiedQuad: base.unifiedQuad ?? PROVIDER_PROFILE_GENERATION_DEFAULTS.unifiedQuad,
    unifiedConf: base.unifiedConf ?? PROVIDER_PROFILE_GENERATION_DEFAULTS.unifiedConf,
    repetitionPenaltySlope: base.repetitionPenaltySlope ?? PROVIDER_PROFILE_GENERATION_DEFAULTS.repetitionPenaltySlope,
    phraseRepPen: base.phraseRepPen ?? PROVIDER_PROFILE_GENERATION_DEFAULTS.phraseRepPen,
    thinkingMode: base.thinkingMode ?? PROVIDER_PROFILE_GENERATION_DEFAULTS.thinkingMode,
  };
  const { apiKey: _redacted, ...effective } = resolveEffectiveSettings(storedBase, overlay);
  // Spread base first so the wire-only fields (hasStoredApiKey, cachedModels)
  // keep their static type; `effective` overrides everything else at runtime.
  // The six NovelAI fields are now typed members of the wire record and ride
  // along on `effective`.
  return { ...base, ...effective } as ProviderProfileRecord;
}
