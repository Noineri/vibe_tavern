/**
 * Pure resolver for the Co-Author provider/model binding.
 *
 * The Co-Author binding is an app-wide pair stored in `ui_settings`
 * (`coauthorProviderId` + `coauthorModelName`), independent of the RP active
 * profile. This module centralizes the resolution logic shared by:
 * - `useCoauthorProviderBinding` (React hook for the modal + topbar + input)
 * - `use-chat-controller` (imperative send gate)
 *
 * Resolution order:
 * 1. If a valid Co-Author binding exists (provider id present + profile found +
 *    model resolves), use it.
 * 2. Otherwise, fall back to the RP active profile + its default model.
 *
 * The fallback is NEVER persisted — it is a transient view until the user saves
 * an explicit Co-Author choice.
 */

import type { ProviderProfileRecord, FavoriteProviderModelRecord } from "../api/types.js";

export interface CoauthorBindingInput {
  /** Persisted Co-Author provider id (null when never saved or cleared). */
  coauthorProviderId: string | null;
  /** Persisted Co-Author model name (null when never saved or cleared). */
  coauthorModelName: string | null;
  /** The full shared profile pool — the bound profile is resolved from here. */
  profiles: ProviderProfileRecord[];
  /** The RP active profile, used as fallback. */
  rpActiveProfile: ProviderProfileRecord | null;
}

export interface CoauthorBindingResult {
  /** The profile Co-Author should use (bound or RP fallback). Null when neither resolves. */
  profile: ProviderProfileRecord | null;
  /** The model Co-Author should use. Null when no model is available. */
  model: string | null;
  /** The provider profile id for favorites/model-list loading. */
  profileId: string | null;
  /** True when an explicit Co-Author binding is active (not a fallback). */
  isExplicit: boolean;
  /** True when the binding is ready for generation (profile + model both resolve). */
  isReady: boolean;
  /** True when the stored coauthorProviderId points to a deleted/nonexistent profile. */
  isDangling: boolean;
}

/**
 * Resolve the effective Co-Author binding from persisted settings + the shared
 * profile pool. Never throws — dangling/null bindings produce a fallback result.
 */
export function resolveCoauthorBinding(input: CoauthorBindingInput): CoauthorBindingResult {
  const { coauthorProviderId, coauthorModelName, profiles, rpActiveProfile } = input;

  // Step 1: try the persisted Co-Author binding.
  if (coauthorProviderId) {
    const bound = profiles.find((p) => p.id === coauthorProviderId) ?? null;
    if (bound) {
      // Model precedence: stored modelName > profile defaultModel.
      const model = coauthorModelName ?? bound.defaultModel ?? null;
      if (model) {
        return {
          profile: bound,
          model,
          profileId: bound.id,
          isExplicit: true,
          isReady: true,
          isDangling: false,
        };
      }
      // Profile exists but no model — still explicit (the user chose this
      // profile) but not ready. The modal will prompt to pick a model.
      return {
        profile: bound,
        model: null,
        profileId: bound.id,
        isExplicit: true,
        isReady: false,
        isDangling: false,
      };
    }
    // Provider id set but profile not found — dangling.
    // Fall through to RP fallback, but flag as dangling so the UI can
    // explain the situation and prompt for a new binding.
    return rpFallback(rpActiveProfile, true);
  }

  // Step 2: no Co-Author binding — RP fallback (not dangling, just unset).
  return rpFallback(rpActiveProfile, false);
}

function rpFallback(
  rpActiveProfile: ProviderProfileRecord | null,
  isDangling: boolean,
): CoauthorBindingResult {
  const rpModel = rpActiveProfile?.defaultModel ?? null;
  return {
    profile: rpActiveProfile,
    model: rpModel,
    profileId: rpActiveProfile?.id ?? null,
    isExplicit: false,
    isReady: rpActiveProfile !== null && rpModel !== null,
    isDangling,
  };
}

/**
 * Filter favorites to only tool-capable models (Co-Author turns require
 * function-calling). Keeps a stored custom model id visible even when
 * model-cache capability metadata is absent or stale — the backend is
 * advisory-only for stored models, so we never hide a bound model just
 * because the cache doesn't know about it.
 */
export function filterToolCapableFavorites(
  favorites: FavoriteProviderModelRecord[],
  toolCapableModelIds: Set<string>,
  boundModelId: string | null,
): FavoriteProviderModelRecord[] {
  return favorites.filter(
    (f) => toolCapableModelIds.has(f.modelId) || f.modelId === boundModelId,
  );
}
