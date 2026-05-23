import { create } from "zustand";
import type { FavoriteProviderModelRecord, ProviderProfileRecord } from "../app-client.js";

export interface ProviderDataState {
  profiles: ProviderProfileRecord[];
  favoritesByProfile: Record<string, FavoriteProviderModelRecord[]>;
}

export interface ProviderDataActions {
  setProfiles: (profiles: ProviderProfileRecord[]) => void;
  setFavorites: (profileId: string, favorites: FavoriteProviderModelRecord[]) => void;
}

export const useProviderDataStore = create<ProviderDataState & ProviderDataActions>((set) => ({
  profiles: [],
  favoritesByProfile: {},
  setProfiles: (profiles) => set({ profiles }),
  setFavorites: (profileId, favorites) => set((state) => ({
    favoritesByProfile: { ...state.favoritesByProfile, [profileId]: favorites },
  })),
}));
