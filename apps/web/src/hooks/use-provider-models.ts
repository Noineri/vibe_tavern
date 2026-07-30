import { useCallback, useEffect, useRef, useState } from "react";
import { fetchProviderProfileModels } from "../api/provider-api.js";
import { normalizeProviderModel, type ProviderModel } from "../lib/provider-model-capabilities.js";
import { useProviderDataStore } from "../stores/provider-data-store.js";

/** Cache-first provider-model loader. It intentionally does not filter by UI policy or favorites. */
export function useProviderModels(providerProfileId: string | null | undefined): {
  models: ProviderModel[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const profiles = useProviderDataStore((state) => state.profiles);

  const loadLive = useCallback(async () => {
    const profileId = providerProfileId;
    if (!profileId) return;
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const response = await fetchProviderProfileModels(profileId);
      if (sequence === requestSequence.current) setModels(response.models.map(normalizeProviderModel));
    } catch (reason: unknown) {
      if (sequence !== requestSequence.current) return;
      setError(reason instanceof Error ? reason.message : "Failed to load models");
      setModels([]);
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [providerProfileId]);

  useEffect(() => {
    ++requestSequence.current;
    if (!providerProfileId) {
      setModels([]);
      setLoading(false);
      setError(null);
      return;
    }

    const cached = profiles.find((profile) => profile.id === providerProfileId)?.cachedModels?.models;
    if (cached && cached.length > 0) {
      setModels(cached.map(normalizeProviderModel));
      setLoading(false);
      setError(null);
      return;
    }

    void loadLive();
  }, [loadLive, profiles, providerProfileId]);

  return { models, loading, error, refresh: loadLive };
}
