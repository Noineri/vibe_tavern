import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { ProviderProbeResponse } from "@rp-platform/domain";
import { PROVIDER_TYPE } from "@rp-platform/domain";
import { getT } from "../i18n/context.js";
import {
  type FavoriteProviderModelRecord,
  type ProviderProfileRecord,
  type TestChatResponse,
} from "../app-client.js";
import type { ConnectionState } from "../components/app-shell-types.js";
import type { FormState } from "../components/ProviderModal.js";
import { normalizeOpenAiCompatibleBaseUrl } from "../openai-compatible.js";
import {
  providerKeys,
  useProviderProfilesQuery,
  useFavoriteModelsQuery,
  useFetchProviderProfileFromCache,
  useFetchProviderModelsFromCache,
  useSaveProviderProfileMutation,
  useUpdateProviderProfileMutation,
  useDeleteProviderProfileMutation,
  useActivateProviderProfileMutation,
  useTestProviderProfileMutation,
  useTestProviderDraftMutation,
  useTestProfileChatMutation,
  useTestProviderChatMutation,
  useFetchModelsByEndpointMutation,
  useToggleFavoriteModelMutation,
  useRefreshProviderProfilesMutation,
} from "../queries/index.js";
import { useQueryClient } from "@tanstack/react-query";

export interface ProviderProfilesDeps {
  connection: ConnectionState;
  patchConnection: (patch: Partial<ConnectionState>) => void;
  setConnection: React.Dispatch<React.SetStateAction<ConnectionState>>;
}

export function useProviderProfiles(deps: ProviderProfilesDeps) {
  const { connection, patchConnection, setConnection } = deps;
  const qc = useQueryClient();
  const getProviderProfileFromCache = useFetchProviderProfileFromCache();
  const getProviderModelsFromCache = useFetchProviderModelsFromCache();

  // --- TQ Queries (server data — no useState) ---
  const profilesQuery = useProviderProfilesQuery();
  const providerProfiles = profilesQuery.data ?? [];

  // selectedProviderProfileId is local UI state, not server data
  const [selectedProviderProfileId, setSelectedProviderProfileId] = useState("");

  // Favorites: use TQ query keyed by the active/selected profile
  const favoritesProfileId = connection.activeProviderProfileId || selectedProviderProfileId || null;
  const favoritesQuery = useFavoriteModelsQuery(favoritesProfileId);
  const favoriteModelsByProfile = useMemo<Record<string, FavoriteProviderModelRecord[]>>(() => {
    if (!favoritesProfileId || !favoritesQuery.data) return {};
    return { [favoritesProfileId]: favoritesQuery.data };
  }, [favoritesQuery.data, favoritesProfileId]);

  // --- Derived values ---
  const activeProviderProfile = useMemo(
    () => providerProfiles.find((profile) => profile.isActive) ?? null,
    [providerProfiles],
  );

  const startupProbeProfileIdsRef = useRef(new Set<string>());
  const canRefreshModels = Boolean(connection.activeProviderProfileId || selectedProviderProfileId);
  const canConnect = Boolean(connection.providerLabel.trim() && connection.baseUrl.trim());
  const canSendViaActiveProfile = activeProviderProfile !== null && Boolean(activeProviderProfile.defaultModel);

  // --- TQ Mutations ---
  const saveProfileMut = useSaveProviderProfileMutation();
  const updateProfileMut = useUpdateProviderProfileMutation();
  const deleteProfileMut = useDeleteProviderProfileMutation();
  const activateProfileMut = useActivateProviderProfileMutation();
  const testProfileMut = useTestProviderProfileMutation();
  const testDraftMut = useTestProviderDraftMutation();
  const testProfileChatMut = useTestProfileChatMutation();
  const testProviderChatMut = useTestProviderChatMutation();
  const fetchModelsMut = useFetchModelsByEndpointMutation();
  const toggleFavoriteMut = useToggleFavoriteModelMutation();
  const refreshProfilesMut = useRefreshProviderProfilesMutation();

  // --- Hydration: sync active profile into connection state ---
  function hydrateActiveProviderProfile(profiles: ProviderProfileRecord[]): void {
    const activeProfile = profiles.find((profile) => profile.isActive);
    if (!activeProfile) return;

    patchConnection({
      providerLabel: activeProfile.name,
      baseUrl: normalizeOpenAiCompatibleBaseUrl(activeProfile.endpoint),
      apiKey: "",
      model: activeProfile.defaultModel ?? "",
      activeProviderProfileId: activeProfile.id,
      hasStoredApiKey: activeProfile.hasStoredApiKey,
      models: [],
      status: activeProfile.defaultModel ? "connected" : "idle",
      error: "",
      providerType: activeProfile.providerPreset || PROVIDER_TYPE.openaiCompat,
      providerPreset: "",
      temperature: activeProfile.temperature,
      topP: activeProfile.topP,
      minP: activeProfile.minP,
      topK: activeProfile.topK,
      topA: activeProfile.topA,
      frequencyPenalty: activeProfile.frequencyPenalty,
      presencePenalty: activeProfile.presencePenalty,
      repetitionPenalty: activeProfile.repetitionPenalty,
      maxTokens: activeProfile.maxTokens,
      stopSequences: activeProfile.stopSequences,
      seed: activeProfile.seed ?? null,
      reasoningEffort: activeProfile.reasoningEffort,
      streamResponse: activeProfile.streamResponse,
    });

    // Load cached models async so TopBar can show human-readable labels
    void getProviderModelsFromCache(activeProfile.id).then((response) => {
      if (response.models.length > 0) {
        patchConnection({ models: response.models });
      }
    });

    if (!activeProfile.defaultModel || startupProbeProfileIdsRef.current.has(activeProfile.id)) return;
    startupProbeProfileIdsRef.current.add(activeProfile.id);
    void probeHydratedProviderProfile(activeProfile.id);
  }

  async function probeHydratedProviderProfile(providerProfileId: string): Promise<void> {
    try {
      const result = await testProfileMut.mutateAsync(providerProfileId);
      setConnection((current) => {
        if (current.activeProviderProfileId !== providerProfileId) return current;
        if (result.success) {
          return { ...current, status: "connected", error: "" };
        }
        return {
          ...current,
          status: "error",
          error: result.error ?? getT()("connection_probe_failed"),
        };
      });
    } catch (error) {
      setConnection((current) => {
        if (current.activeProviderProfileId !== providerProfileId) return current;
        return {
          ...current,
          status: "error",
          error: error instanceof Error ? error.message : getT()("connection_probe_failed"),
        };
      });
    }
  }

  // --- Effects ---

  // Auto-hydrate when profiles load/refresh
  useEffect(() => {
    if (providerProfiles.length > 0) {
      hydrateActiveProviderProfile(providerProfiles);
    }
  }, [providerProfiles]);

  // Keep selectedProviderProfileId valid
  useEffect(() => {
    setSelectedProviderProfileId((current) => {
      if (current && providerProfiles.some((profile) => profile.id === current)) {
        return current;
      }
      return providerProfiles[0]?.id ?? "";
    });
  }, [providerProfiles]);

  // --- Handlers ---

  async function handleConnect(): Promise<void> {
    if (!canConnect) {
      return;
    }

    const normalizedBaseUrl = normalizeOpenAiCompatibleBaseUrl(connection.baseUrl);
    setConnection((current) => ({
      ...current,
      baseUrl: normalizedBaseUrl,
      status: "connecting",
      error: "",
    }));

    try {
      const saved = await saveProfileMut.mutateAsync({
        id: selectedProviderProfileId || connection.activeProviderProfileId || undefined,
        name: connection.providerLabel.trim(),
        providerPreset: connection.providerType || PROVIDER_TYPE.openaiCompat,
        endpoint: normalizedBaseUrl,
        apiKey: connection.apiKey.trim() || undefined,
        defaultModel: connection.model.trim() || null,
        contextBudget: connection.maxTokens || 16000,
        temperature: connection.temperature,
        topP: connection.topP,
        minP: connection.minP,
        topK: connection.topK,
        topA: connection.topA,
        repetitionPenalty: connection.repetitionPenalty,
        frequencyPenalty: connection.frequencyPenalty,
        presencePenalty: connection.presencePenalty,
        maxTokens: connection.maxTokens,
        stopSequences: connection.stopSequences,
        seed: connection.seed,
        reasoningEffort: connection.reasoningEffort,
        streamResponse: connection.streamResponse,
      });

      // Profiles query will auto-refetch via mutation's onSuccess invalidation
      // but we need the latest data immediately, so refetch + wait
      await qc.invalidateQueries({ queryKey: providerKeys.list() });
      setSelectedProviderProfileId(saved.id);
      patchConnection({
        providerLabel: saved.name,
        baseUrl: normalizeOpenAiCompatibleBaseUrl(saved.endpoint),
        apiKey: "",
        model: saved.defaultModel ?? connection.model,
        activeProviderProfileId: saved.id,
        hasStoredApiKey: saved.hasStoredApiKey,
        error: "",
      });

      await handleTestSavedProviderProfile(saved.id);
    } catch (error) {
      patchConnection({
        status: "error",
        error: error instanceof Error ? error.message : getT()("provider_save_connect_failed"),
      });
    }
  }

  async function handleLoadProviderProfile(): Promise<void> {
    if (!selectedProviderProfileId) {
      return;
    }

    try {
      const profile = await getProviderProfileFromCache(selectedProviderProfileId);
      patchConnection({
        providerLabel: profile.name,
        baseUrl: normalizeOpenAiCompatibleBaseUrl(profile.endpoint),
        apiKey: "",
        model: profile.defaultModel ?? "",
        activeProviderProfileId: profile.id,
        hasStoredApiKey: profile.hasStoredApiKey,
        models: [],
        status: "idle",
        error: "",
        providerType: profile.providerPreset || PROVIDER_TYPE.openaiCompat,
        providerPreset: "",
        temperature: profile.temperature,
        topP: profile.topP,
        minP: profile.minP,
        topK: profile.topK,
        
        repetitionPenalty: profile.repetitionPenalty ?? 1.1,
        frequencyPenalty: profile.frequencyPenalty ?? 0.0,
        presencePenalty: profile.presencePenalty ?? 0.0,
        maxTokens: profile.maxTokens,
        stopSequences: profile.stopSequences,
        seed: profile.seed ?? null,
        reasoningEffort: profile.reasoningEffort,
        streamResponse: profile.streamResponse,
      });
    } catch (error) {
      patchConnection({
        status: "error",
        error: error instanceof Error ? error.message : getT()("provider_load_profile_failed"),
      });
    }
  }

  async function handleSaveProviderProfile(): Promise<void> {
    const name = connection.providerLabel.trim();
    const endpoint = normalizeOpenAiCompatibleBaseUrl(connection.baseUrl);

    if (!name || !endpoint) {
      patchConnection({
        status: "error",
        error: getT()("provider_name_url_required"),
      });
      return;
    }

    const existingId = selectedProviderProfileId && providerProfiles.some((profile) => profile.id === selectedProviderProfileId)
      ? selectedProviderProfileId
      : "";

    try {
      const apiKeyInput = connection.apiKey.trim();
      const saved = existingId
        ? await updateProfileMut.mutateAsync({
            id: existingId,
            patch: {
              name,
              providerPreset: connection.providerType || PROVIDER_TYPE.openaiCompat,
              endpoint,
              apiKey: apiKeyInput.length > 0 ? apiKeyInput : undefined,
              defaultModel: connection.model.trim() || null,
              contextBudget: connection.maxTokens || 16000,
              temperature: connection.temperature,
              topP: connection.topP,
              minP: connection.minP,
              topK: connection.topK,
              
              repetitionPenalty: connection.repetitionPenalty,
              frequencyPenalty: connection.frequencyPenalty,
              presencePenalty: connection.presencePenalty,
              maxTokens: connection.maxTokens,
              stopSequences: connection.stopSequences,
              seed: connection.seed,
              reasoningEffort: connection.reasoningEffort,
              streamResponse: connection.streamResponse,
            },
          })
        : await saveProfileMut.mutateAsync({
            name,
            providerPreset: connection.providerType || PROVIDER_TYPE.openaiCompat,
            endpoint,
            apiKey: apiKeyInput || undefined,
            defaultModel: connection.model.trim() || null,
            contextBudget: connection.maxTokens || 16000,
            temperature: connection.temperature,
            topP: connection.topP,
            minP: connection.minP,
            topK: connection.topK,
            
            repetitionPenalty: connection.repetitionPenalty,
            frequencyPenalty: connection.frequencyPenalty,
            presencePenalty: connection.presencePenalty,
            maxTokens: connection.maxTokens,
            stopSequences: connection.stopSequences,
            seed: connection.seed,
            reasoningEffort: connection.reasoningEffort,
            streamResponse: connection.streamResponse,
          });

      await qc.invalidateQueries({ queryKey: providerKeys.list() });
      setSelectedProviderProfileId(saved.id);
      patchConnection({
        providerLabel: saved.name,
        baseUrl: normalizeOpenAiCompatibleBaseUrl(saved.endpoint),
        apiKey: "",
        model: saved.defaultModel ?? connection.model,
        activeProviderProfileId: saved.id,
        hasStoredApiKey: saved.hasStoredApiKey,
        error: "",
      });
    } catch (error) {
      patchConnection({
        status: "error",
        error: error instanceof Error ? error.message : getT()("provider_save_failed"),
      });
    }
  }

  async function handleActivateProviderProfile(providerProfileId: string): Promise<void> {
    if (!providerProfileId) {
      return;
    }
    try {
      await activateProfileMut.mutateAsync(providerProfileId);
      await qc.invalidateQueries({ queryKey: providerKeys.list() });
      const profile = await getProviderProfileFromCache(providerProfileId);
      patchConnection({
        providerLabel: profile.name,
        baseUrl: normalizeOpenAiCompatibleBaseUrl(profile.endpoint),
        apiKey: "",
        model: profile.defaultModel ?? "",
        activeProviderProfileId: profile.id,
        hasStoredApiKey: profile.hasStoredApiKey,
        status: "connected",
        error: "",
      });
    } catch (error) {
      patchConnection({
        status: "error",
        error: error instanceof Error ? error.message : getT()("provider_activate_failed"),
      });
    }
  }

  async function handleDeleteProviderProfile(providerProfileId?: string): Promise<void> {
    const targetId = providerProfileId || selectedProviderProfileId;
    if (!targetId) {
      return;
    }

    try {
      await deleteProfileMut.mutateAsync(targetId);
      await qc.invalidateQueries({ queryKey: providerKeys.list() });
      if (connection.activeProviderProfileId === targetId) {
        patchConnection({
          activeProviderProfileId: null,
          hasStoredApiKey: false,
          status: "idle",
          models: [],
        });
      }
      setSelectedProviderProfileId("");
    } catch (error) {
      patchConnection({
        status: "error",
        error: error instanceof Error ? error.message : getT()("provider_delete_failed"),
      });
    }
  }

  async function handleCreateProviderProfile(): Promise<ProviderProfileRecord | null> {
    try {
      const saved = await saveProfileMut.mutateAsync({
        name: getT()("new_profile"),
        providerPreset: PROVIDER_TYPE.openaiCompat,
        endpoint: "",
        temperature: 1.0,
        topP: 1.0,
        minP: 0,
        topK: 0,
        topA: 0,
        frequencyPenalty: 0.0,
        presencePenalty: 0.0,
        repetitionPenalty: 1.0,
        maxTokens: 2000,
        contextBudget: 16000,
        stopSequences: [],
        seed: null,
        reasoningEffort: "auto",
        streamResponse: true,
        customSamplers: false,
      });
      await qc.invalidateQueries({ queryKey: providerKeys.list() });
      return saved;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("provider_create_failed"));
      return null;
    }
  }

  async function handleDuplicateProviderProfile(id: string): Promise<ProviderProfileRecord | null> {
    const existing = providerProfiles.find((p) => p.id === id);
    if (!existing) return null;
    try {
      const saved = await saveProfileMut.mutateAsync({
        name: `${existing.name} (copy)`,
        providerPreset: existing.providerPreset,
        endpoint: existing.endpoint,
        defaultModel: existing.defaultModel,
        temperature: existing.temperature,
        topP: existing.topP,
        minP: existing.minP,
        topK: existing.topK,
        topA: existing.topA,
        frequencyPenalty: existing.frequencyPenalty,
        presencePenalty: existing.presencePenalty,
        repetitionPenalty: existing.repetitionPenalty,
        maxTokens: existing.maxTokens,
        stopSequences: existing.stopSequences,
        seed: existing.seed,
        reasoningEffort: existing.reasoningEffort,
        streamResponse: existing.streamResponse,
        customSamplers: existing.customSamplers,
      });
      await qc.invalidateQueries({ queryKey: providerKeys.list() });
      return saved;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("provider_duplicate_failed"));
      return null;
    }
  }

  async function handleTestDraftConnection(endpoint: string, apiKey: string, providerType?: string): Promise<ProviderProbeResponse> {
    return testDraftMut.mutateAsync({ endpoint, apiKey, providerType });
  }

  async function handleTestProfileConnection(providerProfileId: string): Promise<ProviderProbeResponse> {
    return testProfileMut.mutateAsync(providerProfileId);
  }

  async function handleTestChat(
    profileId: string | null,
    baseUrl: string,
    apiKey: string,
    model: string,
    providerType?: string,
  ): Promise<TestChatResponse> {
    if (profileId) {
      return testProfileChatMut.mutateAsync({ profileId, model });
    }
    return testProviderChatMut.mutateAsync({ baseUrl, apiKey, model, providerType });
  }

  const handleFetchModelsForProfile = useCallback(async (providerProfileId: string): Promise<Array<{ id: string; label: string; contextLength?: number }>> => {
    // Invalidate cache so refresh always hits the backend
    await qc.invalidateQueries({ queryKey: providerKeys.models(providerProfileId) });
    const response = await getProviderModelsFromCache(providerProfileId);
    return response.models;
  }, [qc, getProviderModelsFromCache]);

  async function handleLoadFavoriteProviderModels(providerProfileId: string): Promise<FavoriteProviderModelRecord[]> {
    await qc.invalidateQueries({ queryKey: providerKeys.favorites(providerProfileId) });
    const data = await qc.fetchQuery({
      queryKey: providerKeys.favorites(providerProfileId),
      queryFn: () => {
        // Import needed inline to avoid circular ref; use app-client directly
        return import("../app-client.js").then((m) => m.listFavoriteProviderModels(providerProfileId));
      },
    });
    return data;
  }

  async function handleToggleFavoriteProviderModel(
    providerProfileId: string,
    model: { id: string; label?: string | null; contextLength?: number | null },
  ): Promise<void> {
    const current = favoriteModelsByProfile[providerProfileId] ?? [];
    const isFavorite = current.some((favorite) => favorite.modelId === model.id);
    await toggleFavoriteMut.mutateAsync({
      profileId: providerProfileId,
      modelId: model.id,
      label: model.label,
      contextLength: model.contextLength,
      removing: isFavorite,
    });
  }

  async function handleSelectFavoriteProviderModel(providerProfileId: string, modelId: string): Promise<void> {
    const saved = await updateProfileMut.mutateAsync({
      id: providerProfileId,
      patch: { defaultModel: modelId },
    });
    await qc.invalidateQueries({ queryKey: providerKeys.list() });
    patchConnection({
      providerLabel: saved.name,
      baseUrl: normalizeOpenAiCompatibleBaseUrl(saved.endpoint),
      apiKey: "",
      model: saved.defaultModel ?? modelId,
      activeProviderProfileId: saved.id,
      hasStoredApiKey: saved.hasStoredApiKey,
      status: "connected",
      error: "",
    });
  }

  async function handleFetchModelsByEndpoint(
    baseUrl: string,
    apiKey?: string,
    _useCache?: boolean,
    providerType?: string,
  ): Promise<Array<{ id: string; label: string; contextLength?: number }>> {
    const response = await fetchModelsMut.mutateAsync({ baseUrl, apiKey, providerType });
    return response.models;
  }

  async function handleRefreshProfiles(): Promise<void> {
    await refreshProfilesMut.mutateAsync();
  }

  async function handleSaveProviderProfileFromForm(
    form: FormState,
  ): Promise<ProviderProfileRecord | null> {
    const name = form.name.trim();
    const endpoint = form.baseUrl.trim();
    if (!name || !endpoint) return null;
    const apiKeyInput = form.apiKey.trim();
    const patch = {
      name,
      providerPreset: form.providerPreset || PROVIDER_TYPE.openaiCompat,
      endpoint,
      apiKey: apiKeyInput.length > 0 ? apiKeyInput : undefined,
      defaultModel: form.model.trim() || null,
      contextBudget: form.contextBudget || 16000,
      temperature: form.temperature,
      topP: form.topP,
      minP: form.minP,
      topK: form.topK,
      topA: form.topA,
      frequencyPenalty: form.frequencyPenalty,
      presencePenalty: form.presencePenalty,
      repetitionPenalty: form.repetitionPenalty,
      maxTokens: form.maxTokens,
      stopSequences: form.stopSequences,
      seed: form.seed,
      reasoningEffort: form.reasoningEffort,
      streamResponse: form.streamResponse,
    };
    try {
      const saved = await updateProfileMut.mutateAsync({ id: form.id, patch });
      await qc.invalidateQueries({ queryKey: providerKeys.list() });
      return saved;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("provider_save_failed"));
      return null;
    }
  }

  async function handleConnectSavedProfile(): Promise<void> {
    if (!selectedProviderProfileId) {
      return;
    }

    await handleTestSavedProviderProfile(selectedProviderProfileId);
  }

  async function handleTestSavedProviderProfile(providerProfileId: string): Promise<void> {
    if (!providerProfileId) {
      return;
    }

    

    try {
      const result = await testProfileMut.mutateAsync(providerProfileId);
      if (result.success) {
        const countHint = typeof result.modelCount === "number"
          ? ` Provider advertises ${result.modelCount} models — press Refresh models to load them.`
          : "";
        toast.success(`Connection verified.${countHint}`);
      } else {
        toast.error(result.error ?? getT()("connection_probe_failed"));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("connection_probe_failed"));
    }
  }

  async function handleRefreshProviderModels(): Promise<void> {
    const providerProfileId = connection.activeProviderProfileId || selectedProviderProfileId;
    if (!providerProfileId) {
      return;
    }

    setConnection((current) => ({
      ...current,
      status: "connecting",
      error: "",
    }));

    try {
      const [profile, response] = await Promise.all([
        getProviderProfileFromCache(providerProfileId),
        getProviderModelsFromCache(providerProfileId),
      ]);
      const models = response.models;
      setConnection((current) => ({
        ...current,
        providerLabel: profile.name,
        baseUrl: normalizeOpenAiCompatibleBaseUrl(profile.endpoint),
        apiKey: "",
        activeProviderProfileId: profile.id,
        hasStoredApiKey: profile.hasStoredApiKey,
        status: "connected",
        error: "",
        models,
        model:
          current.model && models.some((entry) => entry.id === current.model)
            ? current.model
            : profile.defaultModel && models.some((entry) => entry.id === profile.defaultModel)
            ? profile.defaultModel
            : models[0]?.id ?? current.model,
      }));
    } catch (error) {
      patchConnection({
        status: connection.activeProviderProfileId ? "connected" : "error",
        error: error instanceof Error ? error.message : getT()("provider_refresh_models_failed"),
      });
    }
  }

  return {
    providerProfiles,
    selectedProviderProfileId,
    setSelectedProviderProfileId,
    favoriteModelsByProfile,
    activeProviderProfile,
    canRefreshModels,
    canConnect,
    canSendViaActiveProfile,
    handleConnect,
    handleLoadProviderProfile,
    handleSaveProviderProfile,
    handleActivateProviderProfile,
    handleDeleteProviderProfile,
    handleCreateProviderProfile,
    handleDuplicateProviderProfile,
    handleTestDraftConnection,
    handleTestProfileConnection,
    handleTestChat,
    handleFetchModelsForProfile,
    handleLoadFavoriteProviderModels,
    handleToggleFavoriteProviderModel,
    handleSelectFavoriteProviderModel,
    handleFetchModelsByEndpoint,
    handleRefreshProfiles,
    handleSaveProviderProfileFromForm,
    handleConnectSavedProfile,
    handleTestSavedProviderProfile,
    handleRefreshProviderModels,
  };
}
