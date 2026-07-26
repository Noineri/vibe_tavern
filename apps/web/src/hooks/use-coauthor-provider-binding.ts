import { useCallback, useEffect, useMemo } from "react";
import { MODEL_FAVORITE_SCOPE } from "@vibe-tavern/domain";
import { decorateCoauthorFavorites, resolveCoauthorBinding } from "../lib/coauthor-provider-binding.js";
import { useBootstrapStore, patchUiSettingsAction } from "../stores/api-actions/bootstrap-actions.js";
import { useProviderDataStore } from "../stores/provider-data-store.js";
import { loadFavoriteModelsAction } from "../stores/api-actions/provider-actions.js";
import { useProviderModels } from "./use-provider-models.js";

/** Effective Co-Author binding plus neutral models and Co-Author-scoped favorites. */
export function useCoauthorProviderBinding() {
  const uiSettings = useBootstrapStore((state) => state.data?.uiSettings);
  const profiles = useProviderDataStore((state) => state.profiles);
  const favoritesByProfile = useProviderDataStore((state) => state.coauthorFavoritesByProfile);
  const rpActiveProfile = useMemo(() => profiles.find((profile) => profile.isActive) ?? null, [profiles]);
  const binding = useMemo(() => resolveCoauthorBinding({
    coauthorProviderId: uiSettings?.coauthorProviderId ?? null,
    coauthorModelName: uiSettings?.coauthorModelName ?? null,
    profiles,
    rpActiveProfile,
  }), [profiles, rpActiveProfile, uiSettings?.coauthorModelName, uiSettings?.coauthorProviderId]);
  const { models } = useProviderModels(binding.profileId);
  const favoriteRows = binding.profileId ? favoritesByProfile[binding.profileId] ?? [] : [];
  const favorites = useMemo(() => decorateCoauthorFavorites(favoriteRows, models), [favoriteRows, models]);

  useFavoritesLoader(binding.profileId);

  const saveBinding = useCallback(async (profileId: string, modelName: string): Promise<void> => {
    await patchUiSettingsAction({ coauthorProviderId: profileId, coauthorModelName: modelName });
  }, []);
  const quickSwitchModel = useCallback(async (modelName: string): Promise<void> => {
    if (binding.profileId) await patchUiSettingsAction({ coauthorModelName: modelName });
  }, [binding.profileId]);

  return { ...binding, models, favorites, saveBinding, quickSwitchModel };
}

export type CoauthorProviderBinding = ReturnType<typeof useCoauthorProviderBinding>;

function useFavoritesLoader(profileId: string | null): void {
  const favoritesByProfile = useProviderDataStore((state) => state.coauthorFavoritesByProfile);
  useEffect(() => {
    if (profileId && !favoritesByProfile[profileId]) void loadFavoriteModelsAction(profileId, MODEL_FAVORITE_SCOPE.coauthor);
  }, [favoritesByProfile, profileId]);
}
