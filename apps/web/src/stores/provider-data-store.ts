import { create } from "zustand";
import { MODEL_FAVORITE_SCOPE, type ModelFavoriteScope } from "@vibe-tavern/domain";
import type { FavoriteProviderModelRecord, ProviderProfileRecord } from "../app-client.js";

export interface ProviderDataState {
  profiles: ProviderProfileRecord[];
  /** RP-scoped favorites consumed by ProviderModal and RP quick switches. */
  favoritesByProfile: Record<string, FavoriteProviderModelRecord[]>;
  coauthorFavoritesByProfile: Record<string, FavoriteProviderModelRecord[]>;
}

export interface ProviderDataActions {
  setProfiles: (profiles: ProviderProfileRecord[]) => void;
  setFavorites: (profileId: string, scope: ModelFavoriteScope, favorites: FavoriteProviderModelRecord[]) => void;
}

export const useProviderDataStore = create<ProviderDataState & ProviderDataActions>((set) => ({
  profiles: [],
  favoritesByProfile: {},
  coauthorFavoritesByProfile: {},
  setProfiles: (profiles) => set({ profiles }),
  setFavorites: (profileId, scope, favorites) => set((state) => (
    scope === MODEL_FAVORITE_SCOPE.rp
      ? { favoritesByProfile: { ...state.favoritesByProfile, [profileId]: favorites } }
      : { coauthorFavoritesByProfile: { ...state.coauthorFavoritesByProfile, [profileId]: favorites } }
  )),
}));
