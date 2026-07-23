import { useEffect, useState } from "react";
import { fetchProviderProfileModels } from "../api/provider-api.js";
import { normalizeProviderModel, type ProviderModel } from "../lib/provider-model-capabilities.js";
import { useProviderDataStore } from "../stores/provider-data-store.js";

/** Cache-first provider-model loader. It intentionally does not filter by UI policy or favorites. */
export function useProviderModels(providerProfileId: string | null | undefined): {
  models: ProviderModel[];
  loading: boolean;
  error: string | null;
} {
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profiles = useProviderDataStore((state) => state.profiles);

  useEffect(() => {
    if (!providerProfileId) {
      setModels([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const cached = profiles.find((profile) => profile.id === providerProfileId)?.cachedModels?.models;
    if (cached && cached.length > 0) {
      setModels(cached.map(normalizeProviderModel));
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    fetchProviderProfileModels(providerProfileId)
      .then((response) => {
        if (!cancelled) setModels(response.models.map(normalizeProviderModel));
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : "Failed to load models");
        setModels([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [providerProfileId, profiles]);

  return { models, loading, error };
}
