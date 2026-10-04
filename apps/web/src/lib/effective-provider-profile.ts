import { resolveEffectiveSettings, type ModelSettingsOverlay, type StoredProviderProfileRecord } from "@vibe-tavern/domain";
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
  const storedBase: StoredProviderProfileRecord = { ...base, apiKey: null };
  const { apiKey: _redacted, ...effective } = resolveEffectiveSettings(storedBase, overlay);
  return effective as ProviderProfileRecord;
}
