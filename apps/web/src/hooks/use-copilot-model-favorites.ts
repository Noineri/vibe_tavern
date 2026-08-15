import { useCallback, useEffect, useState } from "react";
import { MODEL_FAVORITE_SCOPE } from "@vibe-tavern/domain";
import {
  loadFavoriteModelsAction,
  toggleFavoriteModelAction,
} from "../stores/api-actions/provider-actions.js";
import { useProviderDataStore } from "../stores/provider-data-store.js";
import type { FavoriteProviderModelRecord } from "../app-client.js";

/**
 * Copilot-scoped model favorites for ONE provider profile (variant A: the
 * picker surfaces only the current profile's favorites — switching profiles
 * swaps the favorites section too). Favorites live in the existing
 * `provider_model_favorites` machinery under the dedicated `copilot` scope, so
 * they never mix with RP or co-author stars.
 *
 * Loads on mount/profile change (best-effort; a failure clears the list — the
 * picker still works, just without the favorites section) and exposes an
 * idempotent `toggle`.
 */
export function useCopilotModelFavorites(providerProfileId: string | null | undefined): {
  favorites: FavoriteProviderModelRecord[];
  isFavorite: (modelId: string) => boolean;
  toggleFavorite: (model: { id: string; label?: string | null; contextLength?: number | null }) => void;
  /** Last load/toggle failure, or null. The picker ignores it (favorites are a
   *  non-critical overlay — the model list still works), but it keeps the
   *  failure observable instead of swallowed. */
  error: string | null;
} {
  const favoritesByProfile = useProviderDataStore((state) => state.copilotFavoritesByProfile);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!providerProfileId) return;
    setError(null);
    loadFavoriteModelsAction(providerProfileId, MODEL_FAVORITE_SCOPE.copilot).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Failed to load favorites");
    });
  }, [providerProfileId]);

  const favorites = providerProfileId ? favoritesByProfile[providerProfileId] ?? [] : [];

  const isFavorite = useCallback(
    (modelId: string) => favorites.some((favorite) => favorite.modelId === modelId),
    [favorites],
  );

  const toggleFavorite = useCallback(
    (model: { id: string; label?: string | null; contextLength?: number | null }) => {
      if (!providerProfileId) return;
      const removing = favorites.some((favorite) => favorite.modelId === model.id);
      // Fire-and-forget: toggleFavoriteModelAction refetches the list on
      // settle, so the UI converges through the store either way. A failure is
      // surfaced via the local error state (kept for diagnostics; the picker
      // does not toast on favorite-toggle failures by design).
      void toggleFavoriteModelAction(
        providerProfileId,
        model.id,
        model.label ?? null,
        model.contextLength ?? null,
        removing,
        MODEL_FAVORITE_SCOPE.copilot,
      ).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Failed to toggle favorite");
      });
    },
    [favorites, providerProfileId],
  );

  return { favorites, isFavorite, toggleFavorite, error };
}
