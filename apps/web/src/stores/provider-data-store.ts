import { create } from "zustand";
import { MODEL_FAVORITE_SCOPE, type ModelFavoriteScope } from "@vibe-tavern/domain";
import type { CoauthorConnectionSettingsRecord, FavoriteProviderModelRecord, ProviderProfileRecord } from "../api/types.js";

export interface ProviderDataState {
  profiles: ProviderProfileRecord[];
  /** RP-scoped favorites consumed by ProviderModal and RP quick switches. */
  favoritesByProfile: Record<string, FavoriteProviderModelRecord[]>;
  coauthorFavoritesByProfile: Record<string, FavoriteProviderModelRecord[]>;
  copilotFavoritesByProfile: Record<string, FavoriteProviderModelRecord[]>;
  /** Per-connection Co-Author generation rows (CG-1/CG-2): the model + set the
   *  Co-Author actually generates with. null = the connection has no saved set
   *  (Co-Author defaults apply); absent key = not loaded yet. */
  coauthorSettingsByProfile: Record<string, CoauthorConnectionSettingsRecord | null>;
}

export interface ProviderDataActions {
  setProfiles: (profiles: ProviderProfileRecord[]) => void;
  setFavorites: (profileId: string, scope: ModelFavoriteScope, favorites: FavoriteProviderModelRecord[]) => void;
  setCoauthorSettings: (profileId: string, record: CoauthorConnectionSettingsRecord | null) => void;
}

export const useProviderDataStore = create<ProviderDataState & ProviderDataActions>((set) => ({
  profiles: [],
  favoritesByProfile: {},
  coauthorFavoritesByProfile: {},
  copilotFavoritesByProfile: {},
  coauthorSettingsByProfile: {},
  setProfiles: (profiles) => set({ profiles }),
  setFavorites: (profileId, scope, favorites) => set((state) => {
    if (scope === MODEL_FAVORITE_SCOPE.rp) return { favoritesByProfile: { ...state.favoritesByProfile, [profileId]: favorites } };
    if (scope === MODEL_FAVORITE_SCOPE.coauthor) return { coauthorFavoritesByProfile: { ...state.coauthorFavoritesByProfile, [profileId]: favorites } };
    return { copilotFavoritesByProfile: { ...state.copilotFavoritesByProfile, [profileId]: favorites } };
  }),
  setCoauthorSettings: (profileId, record) => set((state) => ({
    coauthorSettingsByProfile: { ...state.coauthorSettingsByProfile, [profileId]: record },
  })),
}));
