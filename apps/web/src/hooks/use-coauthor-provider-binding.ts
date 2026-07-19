/**
 * React hook that composes the Co-Author provider binding from bootstrap
 * settings, the shared provider profile pool, favorites, and tool-capability
 * data. Exposes an atomic `saveBinding(profileId, modelName)` and a model-only
 * `quickSwitchModel(modelName)` that preserves the bound profile.
 *
 * This hook is the single UI-side consumer of {@link resolveCoauthorBinding}.
 * The topbar, modal, and input area all read from here — they never touch RP
 * activation or `defaultModel` writes.
 */

import { useCallback, useEffect, useMemo } from "react";
import { resolveCoauthorBinding, filterToolCapableFavorites } from "../lib/coauthor-provider-binding.js";
import { useBootstrapStore, patchUiSettingsAction } from "../stores/api-actions/bootstrap-actions.js";
import { useProviderDataStore } from "../stores/provider-data-store.js";
import { loadFavoriteModelsAction } from "../stores/api-actions/provider-actions.js";
import { useToolCapableModels } from "../components/coauthor/useToolCapableModels.js";
import type { FavoriteProviderModelRecord } from "../api/types.js";

export function useCoauthorProviderBinding() {
  const uiSettings = useBootstrapStore((s) => s.data?.uiSettings);
  const coauthorProviderId = uiSettings?.coauthorProviderId ?? null;
  const coauthorModelName = uiSettings?.coauthorModelName ?? null;

  const profiles = useProviderDataStore((s) => s.profiles);
  const favoritesByProfile = useProviderDataStore((s) => s.favoritesByProfile);

  const rpActiveProfile = useMemo(
    () => profiles.find((p) => p.isActive) ?? null,
    [profiles],
  );

  const binding = useMemo(
    () => resolveCoauthorBinding({ coauthorProviderId, coauthorModelName, profiles, rpActiveProfile }),
    [coauthorProviderId, coauthorModelName, profiles, rpActiveProfile],
  );

  // Load favorites for the resolved profile (bound or RP fallback).
  const favoritesProfileId = binding.profileId;
  // useToolCapableModels already subscribes to the model cache; calling it
  // unconditionally keeps the hook's rules-of-hooks count stable.
  const { models: toolCapableModels } = useToolCapableModels(favoritesProfileId);

  const toolCapableIds = useMemo(
    () => new Set(toolCapableModels.map((m) => m.id)),
    [toolCapableModels],
  );

  const favorites: FavoriteProviderModelRecord[] = favoritesProfileId
    ? (favoritesByProfile[favoritesProfileId] ?? [])
    : [];

  const toolFilteredFavorites = useMemo(
    () => filterToolCapableFavorites(favorites, toolCapableIds, binding.model),
    [favorites, toolCapableIds, binding.model],
  );

  // Eagerly load favorites for the resolved profile if not already cached.
  // Mirrors the pattern in use-provider-profiles (effect-driven load).
  useFavoritesLoader(favoritesProfileId);

  /** Atomically save a profile + model pair to the Co-Author binding. */
  const saveBinding = useCallback(
    async (profileId: string, modelName: string): Promise<void> => {
      await patchUiSettingsAction({ coauthorProviderId: profileId, coauthorModelName: modelName });
    },
    [],
  );

  /** Quick model switch — updates only coauthorModelName, preserves the bound profile. */
  const quickSwitchModel = useCallback(
    async (modelName: string): Promise<void> => {
      // Only update the model when a binding exists (explicit or fallback profile).
      // If no profile is bound at all, a model-only switch is meaningless.
      if (binding.profileId) {
        await patchUiSettingsAction({ coauthorModelName: modelName });
      }
    },
    [binding.profileId],
  );

  return {
    ...binding,
    favorites: toolFilteredFavorites,
    saveBinding,
    quickSwitchModel,
  };
}

export type CoauthorProviderBinding = ReturnType<typeof useCoauthorProviderBinding>;

/**
 * Load favorites for a profile id if not already cached. Extracted as a tiny
 * sub-hook so the main hook body stays linear and the effect is colocated
 * with the data it fetches.
 */
function useFavoritesLoader(profileId: string | null): void {
  const favoritesByProfile = useProviderDataStore((s) => s.favoritesByProfile);
  useEffect(() => {
    if (profileId && !favoritesByProfile[profileId]) {
      void loadFavoriteModelsAction(profileId);
    }
  }, [profileId, favoritesByProfile]);
}
