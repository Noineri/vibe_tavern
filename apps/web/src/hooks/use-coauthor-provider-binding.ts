import { useCallback, useEffect, useMemo } from "react";
import { MODEL_FAVORITE_SCOPE, resolveCoauthorGenerationSettings } from "@vibe-tavern/domain";
import { decorateCoauthorFavorites, resolveCoauthorBinding, type CoauthorBindingResult } from "../lib/coauthor-provider-binding.js";
import { useBootstrapStore, patchUiSettingsAction } from "../stores/api-actions/bootstrap-actions.js";
import { useProviderDataStore } from "../stores/provider-data-store.js";
import { loadCoauthorConnectionSettingsAction, loadFavoriteModelsAction, upsertCoauthorConnectionSettingsAction } from "../stores/api-actions/provider-actions.js";
import { useProviderModels } from "./use-provider-models.js";

/** The resolved Co-Author binding (profile + effective model) — the ONE
 *  derivation, shared by the input area UI and the chat controller's send
 *  gate. The model comes from the bound connection's own generation row
 *  (CG-2 storage), falling back to the profile default when the row has none
 *  — the same fallback as the backend boundary. Row loading is owned by
 *  useCoauthorProviderBinding (mounted with the co-author UI); until the row
 *  lands, an absent entry falls back like a rowless connection. With no
 *  explicit binding, resolveCoauthorBinding falls back to the RP active
 *  profile. */
export function useCoauthorBindingState(): CoauthorBindingResult {
  const coauthorProviderId = useBootstrapStore((state) => state.data?.uiSettings?.coauthorProviderId ?? null);
  const profiles = useProviderDataStore((state) => state.profiles);
  const coauthorSettings = useProviderDataStore((state) =>
    coauthorProviderId ? state.coauthorSettingsByProfile[coauthorProviderId] : undefined,
  );
  const rpActiveProfile = useMemo(() => profiles.find((profile) => profile.isActive) ?? null, [profiles]);
  return useMemo(
    () => resolveCoauthorBinding({ coauthorProviderId, coauthorSettings, profiles, rpActiveProfile }),
    [coauthorProviderId, coauthorSettings, profiles, rpActiveProfile],
  );
}

/** Effective Co-Author binding plus neutral models and Co-Author-scoped favorites. */
export function useCoauthorProviderBinding() {
  const binding = useCoauthorBindingState();
  const coauthorProviderId = useBootstrapStore((state) => state.data?.uiSettings?.coauthorProviderId ?? null);
  const favoritesByProfile = useProviderDataStore((state) => state.coauthorFavoritesByProfile);
  const { models } = useProviderModels(binding.profileId);
  const favoriteRows = binding.profileId ? favoritesByProfile[binding.profileId] ?? [] : [];
  const favorites = useMemo(() => decorateCoauthorFavorites(favoriteRows, models), [favoriteRows, models]);

  useFavoritesLoader(binding.profileId);
  useCoauthorSettingsLoader(coauthorProviderId);

  /** The connection row re-PUT for a model switch: the PUT replaces the whole
   *  record, so the current settings are re-sent unchanged (read-modify-write)
   *  and a connection with no row yet gets the domain defaults
   *  (`resolveCoauthorGenerationSettings`) plus the chosen model. */
  const putRowModel = useCallback(async (profileId: string, modelName: string): Promise<void> => {
    const row = await loadCoauthorConnectionSettingsAction(profileId);
    await upsertCoauthorConnectionSettingsAction(profileId, {
      modelName,
      settings: resolveCoauthorGenerationSettings(row?.settings),
    });
  }, []);

  // Modal save (the use-for-coauthor footer): the model lives on the
  // connection's own row (CG-2); ui_settings keeps ONLY the binding of WHICH
  // connection. The row is written first so a failed binding patch never
  // re-points the Co-Author at a connection whose row still holds a previous
  // model.
  const saveBinding = useCallback(async (profileId: string, modelName: string): Promise<void> => {
    await putRowModel(profileId, modelName);
    await patchUiSettingsAction({ coauthorProviderId: profileId });
  }, [putRowModel]);

  // Star quick-switch (desktop + mobile input areas): the bound connection's
  // row only — ui_settings is untouched.
  const quickSwitchModel = useCallback(async (modelName: string): Promise<void> => {
    const profileId = binding.profileId;
    if (!profileId) return;
    await putRowModel(profileId, modelName);
  }, [binding.profileId, putRowModel]);

  return { ...binding, models, favorites, saveBinding, quickSwitchModel };
}

export type CoauthorProviderBinding = ReturnType<typeof useCoauthorProviderBinding>;

function useFavoritesLoader(profileId: string | null): void {
  const favoritesByProfile = useProviderDataStore((state) => state.coauthorFavoritesByProfile);
  useEffect(() => {
    if (profileId && !favoritesByProfile[profileId]) void loadFavoriteModelsAction(profileId, MODEL_FAVORITE_SCOPE.coauthor);
  }, [favoritesByProfile, profileId]);
}

function useCoauthorSettingsLoader(profileId: string | null): void {
  const settingsByProfile = useProviderDataStore((state) => state.coauthorSettingsByProfile);
  useEffect(() => {
    if (profileId && !(profileId in settingsByProfile)) void loadCoauthorConnectionSettingsAction(profileId);
  }, [settingsByProfile, profileId]);
}
