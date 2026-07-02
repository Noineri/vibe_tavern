import { useEffect, useState } from "react";
import { fetchProviderProfileModels } from "../../api/provider-api.js";
import { useProviderDataStore } from "../../stores/provider-data-store.js";

/**
 * A model stripped to the fields a tool-filtered picker needs. The two source
 * shapes (live-fetched {@link ProviderModelOption} and cached
 * CachedProviderModelsRecord entries) carry different rich fields, but every
 * co-author model picker only needs identity + label + context window. This
 * minimal projection decouples consumers from whichever source the hook served.
 */
export interface ToolCapableModel {
  id: string;
  label: string;
  contextLength?: number;
}

/**
 * Structural input for the filter — accepts BOTH model shapes the frontend
 * encounters: live-fetched `ProviderModelOption` (top-level `supportsTools`,
 * set by the backend from `capabilities.tools` at provider-gateway.ts) and
 * cached CachedProviderModelsRecord entries (capability lives under
 * `capabilities.tools` only). Making this a structural union (rather than
 * importing one concrete type) is what lets the hook serve cached and live
 * models through one predicate without `as any` casts at the boundary.
 */
interface ModelWithToolCapability {
  id: string;
  label: string;
  contextLength?: number;
  supportsTools?: boolean;
  capabilities?: { tools?: boolean };
}

/**
 * Pure filter — keep only tool-capable models. A model qualifies when it
 * advertises tools via EITHER the explicit `supportsTools` flag (the
 * live-fetched shape) OR `capabilities.tools` (the cached shape). The backend
 * derives `supportsTools` from `capabilities.tools` (see provider-gateway), so
 * the two are the same fact expressed at different layers; checking both keeps
 * the filter correct against whichever source it receives.
 *
 * Extracted from the hook so the capability predicate is unit-testable without
 * a DOM / render harness — same rationale as `useCoauthorMobileTab`'s extracted
 * state machine. The hook is thin cache-then-fetch glue around this.
 */
export function filterToolCapableModels<T extends ModelWithToolCapability>(models: T[]): T[] {
  return models.filter((m) => m.supportsTools === true || m.capabilities?.tools === true);
}

function toToolCapableModel(m: ModelWithToolCapability): ToolCapableModel {
  return { id: m.id, label: m.label, contextLength: m.contextLength };
}

/**
 * Returns the tool-capable models for a provider profile — the model list a
 * co-author chat may select from, since co-author turns require function-calling
 * (the author-module tools). Non-tool models are hidden so the user cannot pick
 * a model that would silently break the tool loop.
 *
 * Resolution order mirrors {@link ProviderModal}'s `loadCached`:
 *   1. cached models on the profile (`profile.cachedModels.models`) — instant,
 *      no network;
 *   2. live `fetchProviderProfileModels` fetch — only when the cache is empty.
 * Either way the result passes through {@link filterToolCapableModels}.
 *
 * `providerProfileId` null/undefined yields an empty list (no fetch) — used
 * when no profile is active yet. The effect is cancellable across id changes so
 * a slow fetch for a previous profile cannot overwrite a newer one (stale-write
 * guard).
 */
export function useToolCapableModels(providerProfileId: string | null | undefined): {
  models: ToolCapableModel[];
  loading: boolean;
  error: string | null;
} {
  const [models, setModels] = useState<ToolCapableModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const profiles = useProviderDataStore((s) => s.profiles);

  useEffect(() => {
    if (!providerProfileId) {
      setModels([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    // 1. Prefer cached models on the profile (instant, no network).
    const profile = profiles.find((p) => p.id === providerProfileId);
    const cached = profile?.cachedModels?.models;
    if (cached && cached.length > 0) {
      setModels(filterToolCapableModels(cached).map(toToolCapableModel));
      setLoading(false);
      setError(null);
      return;
    }

    // 2. Cache empty → live fetch.
    setLoading(true);
    setError(null);
    fetchProviderProfileModels(providerProfileId)
      .then((res) => {
        if (cancelled) return;
        setModels(filterToolCapableModels(res.models).map(toToolCapableModel));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load models");
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
