import { create } from "zustand";
import { MODEL_FAVORITE_SCOPE, type ModelFavoriteScope } from "@vibe-tavern/domain";
import type { CoauthorConnectionSettingsRecord, FavoriteProviderModelRecord, ProviderModelSettingsRecord, ProviderProfileRecord } from "../api/types.js";

export interface ProviderDataState {
  profiles: ProviderProfileRecord[];
  /** RP-scoped favorites consumed by ProviderModal and RP quick switches. */
  favoritesByProfile: Record<string, FavoriteProviderModelRecord[]>;
  coauthorFavoritesByProfile: Record<string, FavoriteProviderModelRecord[]>;
  copilotFavoritesByProfile: Record<string, FavoriteProviderModelRecord[]>;
  /** Per-model overlay rows by profile (RP per-model binding): loaded when the
   *  active profile binds per model so chat-side displays can resolve the
   *  ACTIVE model's effective settings (RP_QUICK_SWITCH_MODEL_SETTINGS_REPORT
   *  step 2). Absent key = not loaded yet (base passthrough until it lands). */
  modelSettingsByProfile: Record<string, ProviderModelSettingsRecord[]>;
  /** Per-connection Co-Author generation rows (CG-1/CG-2): the model + set the
   *  Co-Author actually generates with. null = the connection has no saved set
   *  (Co-Author defaults apply); absent key = not loaded yet. */
  coauthorSettingsByProfile: Record<string, CoauthorConnectionSettingsRecord | null>;
}

export interface ProviderDataActions {
  setProfiles: (profiles: ProviderProfileRecord[]) => void;
  setFavorites: (profileId: string, scope: ModelFavoriteScope, favorites: FavoriteProviderModelRecord[]) => void;
  setModelSettings: (profileId: string, records: ProviderModelSettingsRecord[]) => void;
  setCoauthorSettings: (profileId: string, record: CoauthorConnectionSettingsRecord | null) => void;
}

export const useProviderDataStore = create<ProviderDataState & ProviderDataActions>((set) => ({
  profiles: [],
  favoritesByProfile: {},
  coauthorFavoritesByProfile: {},
  copilotFavoritesByProfile: {},
  modelSettingsByProfile: {},
  coauthorSettingsByProfile: {},
  setProfiles: (profiles) => set({ profiles }),
  setFavorites: (profileId, scope, favorites) => set((state) => {
    if (scope === MODEL_FAVORITE_SCOPE.rp) return { favoritesByProfile: { ...state.favoritesByProfile, [profileId]: favorites } };
    if (scope === MODEL_FAVORITE_SCOPE.coauthor) return { coauthorFavoritesByProfile: { ...state.coauthorFavoritesByProfile, [profileId]: favorites } };
    return { copilotFavoritesByProfile: { ...state.copilotFavoritesByProfile, [profileId]: favorites } };
  }),
  setModelSettings: (profileId, records) => set((state) => ({
    modelSettingsByProfile: { ...state.modelSettingsByProfile, [profileId]: records },
  })),
  setCoauthorSettings: (profileId, record) => set((state) => ({
    coauthorSettingsByProfile: { ...state.coauthorSettingsByProfile, [profileId]: record },
  })),
}));
