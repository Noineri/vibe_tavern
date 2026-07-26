import type { FavoriteProviderModelRecord, ProviderProfileRecord } from "../api/types.js";
import type { ProviderModel, ToolSupport } from "./provider-model-capabilities.js";

export interface CoauthorBindingInput {
  coauthorProviderId: string | null;
  coauthorModelName: string | null;
  profiles: ProviderProfileRecord[];
  rpActiveProfile: ProviderProfileRecord | null;
}

export interface CoauthorBindingResult {
  profile: ProviderProfileRecord | null;
  model: string | null;
  profileId: string | null;
  isExplicit: boolean;
  isReady: boolean;
  isDangling: boolean;
}

export interface DecoratedCoauthorFavorite extends FavoriteProviderModelRecord {
  toolSupport: ToolSupport;
}

/** Resolve an explicit Co-Author pair, otherwise the non-persisted RP fallback. */
export function resolveCoauthorBinding(input: CoauthorBindingInput): CoauthorBindingResult {
  const { coauthorProviderId, coauthorModelName, profiles, rpActiveProfile } = input;
  if (coauthorProviderId) {
    const profile = profiles.find((candidate) => candidate.id === coauthorProviderId) ?? null;
    if (profile) {
      const model = coauthorModelName ?? profile.defaultModel ?? null;
      return { profile, model, profileId: profile.id, isExplicit: true, isReady: model !== null, isDangling: false };
    }
    return rpFallback(rpActiveProfile, true);
  }
  return rpFallback(rpActiveProfile, false);
}

function rpFallback(profile: ProviderProfileRecord | null, isDangling: boolean): CoauthorBindingResult {
  const model = profile?.defaultModel ?? null;
  return { profile, model, profileId: profile?.id ?? null, isExplicit: false, isReady: profile !== null && model !== null, isDangling };
}

/** Joins Co-Author favorites to neutral model metadata without excluding any row. */
export function decorateCoauthorFavorites(
  favorites: FavoriteProviderModelRecord[],
  models: ProviderModel[],
): DecoratedCoauthorFavorite[] {
  const supportById = new Map(models.map((model) => [model.id, model.toolSupport]));
  return favorites.map((favorite) => ({
    ...favorite,
    toolSupport: supportById.get(favorite.modelId) ?? "unknown",
  }));
}
