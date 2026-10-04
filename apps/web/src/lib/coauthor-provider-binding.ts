import type { CoauthorConnectionSettingsRecord, FavoriteProviderModelRecord, ProviderProfileRecord } from "../api/types.js";
import type { ProviderModel, ToolSupport } from "./provider-model-capabilities.js";

export interface CoauthorBindingInput {
  coauthorProviderId: string | null;
  /** The bound connection's Co-Author row (CG-2 storage): the model the
   *  Co-Author actually generates with. null = no saved set, undefined = not
   *  loaded yet — both fall back to the profile default, mirroring the
   *  backend boundary (`row.modelName ?? profile.defaultModel`). */
  coauthorSettings: CoauthorConnectionSettingsRecord | null | undefined;
  profiles: ProviderProfileRecord[];
  /** Legacy call-site input retained while callers migrate; never consulted. */
  rpActiveProfile?: ProviderProfileRecord | null;
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

/** Resolve only an explicit, extant Co-Author pair. Missing or deleted bindings
 * fail closed instead of borrowing RP's active connection. */
export function resolveCoauthorBinding(input: CoauthorBindingInput): CoauthorBindingResult {
  const { coauthorProviderId, coauthorSettings, profiles } = input;
  if (!coauthorProviderId) return { profile: null, model: null, profileId: null, isExplicit: false, isReady: false, isDangling: false };
  const profile = profiles.find((candidate) => candidate.id === coauthorProviderId) ?? null;
  if (!profile) return { profile: null, model: null, profileId: null, isExplicit: false, isReady: false, isDangling: true };
  const model = coauthorSettings?.modelName ?? profile.defaultModel ?? null;
  return { profile, model, profileId: profile.id, isExplicit: true, isReady: model !== null, isDangling: false };
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
