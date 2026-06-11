import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { ProviderProbeResponse } from "@vibe-tavern/domain";
import { PROVIDER_TYPE } from "@vibe-tavern/domain";
import { getT } from "../i18n/locale-helpers.js";
import { useProviderStore } from "../stores/provider-store.js";
import { useProviderDataStore } from "../stores/provider-data-store.js";
import {
  type FavoriteProviderModelRecord,
  type ProviderProfileRecord,
  type TestChatResponse,
} from "../app-client.js";
import type { FormState } from "../components/modals/ProviderModal.js";
import { normalizeOpenAiCompatibleBaseUrl } from "../openai-compatible.js";
import {
  loadProviderProfilesAction,
  loadFavoriteModelsAction,
  fetchProviderProfileAction,
  fetchProviderModelsAction,
  saveProviderProfileAction,
  updateProviderProfileAction,
  deleteProviderProfileAction,
  activateProviderProfileAction,
  testProviderProfileAction,
  testProviderDraftAction,
  testProfileChatAction,
  testProviderChatAction,
  fetchModelsByEndpointAction,
  toggleFavoriteModelAction,
} from "../stores/api-actions/provider-actions.js";

export function useProviderProfiles() {
  const connection = useProviderStore((s) => s.connection);
  const patchConnection = useProviderStore((s) => s.patchConnection);
  const setConnection = useProviderStore((s) => s.setConnection);
  
  const providerProfiles = useProviderDataStore((s) => s.profiles);
  const favoritesByProfile = useProviderDataStore((s) => s.favoritesByProfile);

  // selectedProviderProfileId is local UI state, not server data
  const [selectedProviderProfileId, setSelectedProviderProfileId] = useState("");

  // Favorites
  const favoritesProfileId = connection.activeProviderProfileId || selectedProviderProfileId || null;
  
  useEffect(() => {
    if (favoritesProfileId) {
      void loadFavoriteModelsAction(favoritesProfileId);
    }
  }, [favoritesProfileId]);

  const favoriteModelsByProfile = useMemo<Record<string, FavoriteProviderModelRecord[]>>(() => {
    if (!favoritesProfileId) return {};
    return { [favoritesProfileId]: favoritesByProfile[favoritesProfileId] ?? [] };
  }, [favoritesByProfile, favoritesProfileId]);

  // --- Derived values ---
  const activeProviderProfile = useMemo(
    () => providerProfiles.find((profile) => profile.isActive) ?? null,
    [providerProfiles],
  );

  const startupProbeProfileIdsRef = useRef(new Set<string>());
  const canRefreshModels = Boolean(connection.activeProviderProfileId || selectedProviderProfileId);
  const canConnect = Boolean(connection.providerLabel.trim() && connection.baseUrl.trim());
  const canSendViaActiveProfile = activeProviderProfile !== null && Boolean(activeProviderProfile.defaultModel);

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
      showReasoning: activeProfile.showReasoning,
      streamResponse: activeProfile.streamResponse,
    });

    // Load cached models async so TopBar can show human-readable labels
    void fetchProviderModelsAction(activeProfile.id).then((response) => {
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
      const result = await testProviderProfileAction(providerProfileId);
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

  useEffect(() => {
    // Initial load
    void loadProviderProfilesAction();
  }, []);

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
      const savedId = selectedProviderProfileId || connection.activeProviderProfileId || undefined;
      const patch = {
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
        showReasoning: connection.showReasoning,
        streamResponse: connection.streamResponse,
      };

      const saved = savedId 
        ? await updateProviderProfileAction(savedId, patch)
        : await saveProviderProfileAction(patch);

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
      const profile = await fetchProviderProfileAction(selectedProviderProfileId);
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
        showReasoning: profile.showReasoning,
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
      const patch = {
        name,
        providerPreset: connection.providerType || PROVIDER_TYPE.openaiCompat,
        endpoint,
        apiKey: apiKeyInput.length > 0 ? apiKeyInput : undefined,
        defaultModel: connection.model.trim() || null,
        visionModel: connection.visionModel.trim() || null,
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
        showReasoning: connection.showReasoning,
        streamResponse: connection.streamResponse,
      };

      const saved = existingId
        ? await updateProviderProfileAction(existingId, patch)
        : await saveProviderProfileAction(patch);

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
      await activateProviderProfileAction(providerProfileId);
      const profile = await fetchProviderProfileAction(providerProfileId);
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
      await deleteProviderProfileAction(targetId);
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
      const saved = await saveProviderProfileAction({
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
        showReasoning: false,
        streamResponse: true,
        customSamplers: false,
      });
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
      const saved = await saveProviderProfileAction({
        name: `${existing.name} (copy)`,
        providerPreset: existing.providerPreset,
        endpoint: existing.endpoint,
        defaultModel: existing.defaultModel,
        visionModel: existing.visionModel,
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
        showReasoning: existing.showReasoning,
        streamResponse: existing.streamResponse,
        customSamplers: existing.customSamplers,
      });
      return saved;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("provider_duplicate_failed"));
      return null;
    }
  }

  async function handleTestDraftConnection(endpoint: string, apiKey: string, providerType?: string): Promise<ProviderProbeResponse> {
    return testProviderDraftAction({ endpoint, apiKey, providerType });
  }

  async function handleTestProfileConnection(providerProfileId: string): Promise<ProviderProbeResponse> {
    return testProviderProfileAction(providerProfileId);
  }

  async function handleTestChat(
    profileId: string | null,
    baseUrl: string,
    apiKey: string,
    model: string,
    providerType?: string,
  ): Promise<TestChatResponse> {
    if (profileId) {
      return testProfileChatAction(profileId, model);
    }
    return testProviderChatAction(baseUrl, apiKey, model, providerType);
  }

  const handleFetchModelsForProfile = useCallback(async (providerProfileId: string): Promise<Array<{ id: string; label: string; contextLength?: number }>> => {
    const response = await fetchProviderModelsAction(providerProfileId);
    return response.models;
  }, []);

  async function handleLoadFavoriteProviderModels(providerProfileId: string): Promise<FavoriteProviderModelRecord[]> {
    await loadFavoriteModelsAction(providerProfileId);
    return useProviderDataStore.getState().favoritesByProfile[providerProfileId] ?? [];
  }

  async function handleToggleFavoriteProviderModel(
    providerProfileId: string,
    model: { id: string; label?: string | null; contextLength?: number | null },
  ): Promise<void> {
    const current = favoriteModelsByProfile[providerProfileId] ?? [];
    const isFavorite = current.some((favorite) => favorite.modelId === model.id);
    await toggleFavoriteModelAction(
      providerProfileId,
      model.id,
      model.label,
      model.contextLength,
      isFavorite
    );
  }

  async function handleSelectFavoriteProviderModel(providerProfileId: string, modelId: string): Promise<void> {
    // Find the favorite model's contextLength to auto-update contextBudget
    const favList = useProviderDataStore.getState().favoritesByProfile[providerProfileId] ?? [];
    const fav = favList.find((f) => f.modelId === modelId);
    const patch: Record<string, unknown> = { defaultModel: modelId };
    if (fav?.contextLength != null && fav.contextLength > 0) {
      patch.contextBudget = fav.contextLength;
    }
    const saved = await updateProviderProfileAction(providerProfileId, patch);
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
    const response = await fetchModelsByEndpointAction(baseUrl, apiKey, providerType);
    return response.models;
  }

  async function handleRefreshProfiles(): Promise<void> {
    await loadProviderProfilesAction();
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
      visionModel: form.visionModel.trim() || null,
      contextBudget: form.contextBudget || null,
      pinContextBudget: form.pinContextBudget,
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
      logitBias: form.logitBias,
      seed: form.seed,
      reasoningEffort: form.reasoningEffort,
      showReasoning: form.showReasoning,
      streamResponse: form.streamResponse,
      customSamplers: form.customSamplers,
    };
    try {
      const saved = form.id
        ? await updateProviderProfileAction(form.id, patch)
        : await saveProviderProfileAction({ ...patch, providerPreset: patch.providerPreset });
      if (saved && !form.id) {
        await activateProviderProfileAction(saved.id);
      }
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
      const result = await testProviderProfileAction(providerProfileId);
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
        fetchProviderProfileAction(providerProfileId),
        fetchProviderModelsAction(providerProfileId),
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
