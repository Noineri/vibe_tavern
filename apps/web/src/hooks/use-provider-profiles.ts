import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderProbeResponse } from "@rp-platform/domain";
import { PROVIDER_TYPE } from "@rp-platform/domain";
import {
  activateProviderProfile,
  deleteProviderProfile,
  addFavoriteProviderModel,
  fetchModelsByEndpoint as fetchModelsByEndpointClient,
  fetchProviderProfile,
  fetchProviderProfileModels as fetchModelsForProviderProfile,
  listFavoriteProviderModels,
  listProviderProfiles,
  removeFavoriteProviderModel,
  saveProviderProfile,
  testProfileChat as testProfileChatClient,
  testProviderChat as testProviderChatClient,
  testProviderDraft,
  testProviderProfile,
  updateProviderProfile,
  type FavoriteProviderModelRecord,
  type ProviderProfileRecord,
  type TestChatResponse,
} from "../app-client.js";
import type { ConnectionState } from "../components/app-shell-types.js";
import type { FormState } from "../components/ProviderModal.js";
import { normalizeOpenAiCompatibleBaseUrl } from "../openai-compatible.js";

export interface ProviderProfilesDeps {
  connection: ConnectionState;
  patchConnection: (patch: Partial<ConnectionState>) => void;
  setConnection: React.Dispatch<React.SetStateAction<ConnectionState>>;
  setChatNotice: (notice: string) => void;
}

export function useProviderProfiles(deps: ProviderProfilesDeps) {
  const { connection, patchConnection, setConnection, setChatNotice } = deps;

  const [providerProfiles, setProviderProfiles] = useState<ProviderProfileRecord[]>([]);
  const [selectedProviderProfileId, setSelectedProviderProfileId] = useState("");
  const [favoriteModelsByProfile, setFavoriteModelsByProfile] = useState<Record<string, FavoriteProviderModelRecord[]>>({});

  const activeProviderProfile = useMemo(
    () => providerProfiles.find((profile) => profile.isActive) ?? null,
    [providerProfiles],
  );
  const canRefreshModels = Boolean(connection.activeProviderProfileId || selectedProviderProfileId);
  const canConnect = Boolean(connection.providerLabel.trim() && connection.baseUrl.trim());
  const canSendViaActiveProfile = activeProviderProfile !== null && Boolean(activeProviderProfile.defaultModel);

  async function loadProviderProfiles(): Promise<void> {
    try {
      setProviderProfiles(await listProviderProfiles());
    } catch (error) {
      setConnection((current) => ({
        ...current,
        error:
          error instanceof Error ? error.message : "Could not load saved provider profiles.",
      }));
    }
  }

  useEffect(() => {
    void loadProviderProfiles();
  }, []);

  useEffect(() => {
    setSelectedProviderProfileId((current) => {
      if (current && providerProfiles.some((profile) => profile.id === current)) {
        return current;
      }
      return providerProfiles[0]?.id ?? "";
    });
  }, [providerProfiles]);

  useEffect(() => {
    const profileId = connection.activeProviderProfileId || selectedProviderProfileId;
    if (!profileId || favoriteModelsByProfile[profileId]) return;
    void handleLoadFavoriteProviderModels(profileId);
  }, [connection.activeProviderProfileId, selectedProviderProfileId, favoriteModelsByProfile]);

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
      const saved = await saveProviderProfile({
        id: selectedProviderProfileId || connection.activeProviderProfileId || undefined,
        name: connection.providerLabel.trim(),
        type: connection.providerType || PROVIDER_TYPE.openaiCompat,
        endpoint: normalizedBaseUrl,
        apiKey: connection.apiKey.trim() || undefined,
        defaultModel: connection.model.trim() || null,
        contextBudget: connection.maxTokens || 128000,
        temperature: connection.temperature,
        topP: connection.topP,
        minP: connection.minP,
        topK: connection.topK,
        typicalP: connection.typicalP,
        repPen: connection.repPen,
        freqPen: connection.freqPen,
        presPen: connection.presPen,
        maxTokens: connection.maxTokens,
        stopSeq: connection.stopSeq,
        seed: connection.seed,
        reasoningEffort: connection.reasoningEffort,
        streamResponse: connection.streamResponse,
      });

      await loadProviderProfiles();
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
        error: error instanceof Error ? error.message : "Could not save and connect provider profile.",
      });
    }
  }

  async function handleLoadProviderProfile(): Promise<void> {
    if (!selectedProviderProfileId) {
      return;
    }

    try {
      const profile = await fetchProviderProfile(selectedProviderProfileId);
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
        providerType: profile.type || PROVIDER_TYPE.openaiCompat,
        providerPreset: "",
        temperature: profile.temperature ?? 0.9,
        topP: profile.topP ?? 1.0,
        minP: profile.minP ?? 0.05,
        topK: profile.topK ?? 40,
        typicalP: profile.typicalP ?? 1.0,
        repPen: profile.repPen ?? 1.1,
        freqPen: profile.freqPen ?? 0.0,
        presPen: profile.presPen ?? 0.0,
        maxTokens: profile.maxTokens ?? 8192,
        stopSeq: profile.stopSeq ?? "",
        seed: profile.seed ?? null,
        reasoningEffort: profile.reasoningEffort ?? "medium",
        streamResponse: profile.streamResponse ?? true,
      });
    } catch (error) {
      patchConnection({
        status: "error",
        error: error instanceof Error ? error.message : "Could not load saved profile.",
      });
    }
  }

  async function handleSaveProviderProfile(): Promise<void> {
    const name = connection.providerLabel.trim();
    const endpoint = normalizeOpenAiCompatibleBaseUrl(connection.baseUrl);

    if (!name || !endpoint) {
      patchConnection({
        status: "error",
        error: "Provider name and base URL are required to save a profile.",
      });
      return;
    }

    const existingId = selectedProviderProfileId && providerProfiles.some((profile) => profile.id === selectedProviderProfileId)
      ? selectedProviderProfileId
      : "";

    try {
      const apiKeyInput = connection.apiKey.trim();
      const saved = existingId
        ? await updateProviderProfile(existingId, {
            name,
             type: connection.providerType || PROVIDER_TYPE.openaiCompat,
             endpoint,
             apiKey: apiKeyInput.length > 0 ? apiKeyInput : undefined,
             defaultModel: connection.model.trim() || null,
             contextBudget: connection.maxTokens || 128000,
             temperature: connection.temperature,
             topP: connection.topP,
             minP: connection.minP,
             topK: connection.topK,
             typicalP: connection.typicalP,
             repPen: connection.repPen,
             freqPen: connection.freqPen,
             presPen: connection.presPen,
             maxTokens: connection.maxTokens,
             stopSeq: connection.stopSeq,
             seed: connection.seed,
             reasoningEffort: connection.reasoningEffort,
             streamResponse: connection.streamResponse,
           })
         : await saveProviderProfile({
             name,
             type: connection.providerType || PROVIDER_TYPE.openaiCompat,
            endpoint,
            apiKey: apiKeyInput || undefined,
            defaultModel: connection.model.trim() || null,
            contextBudget: connection.maxTokens || 128000,
            temperature: connection.temperature,
            topP: connection.topP,
            minP: connection.minP,
            topK: connection.topK,
            typicalP: connection.typicalP,
            repPen: connection.repPen,
            freqPen: connection.freqPen,
            presPen: connection.presPen,
            maxTokens: connection.maxTokens,
            stopSeq: connection.stopSeq,
            seed: connection.seed,
            reasoningEffort: connection.reasoningEffort,
            streamResponse: connection.streamResponse,
          });

      await loadProviderProfiles();
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
        error: error instanceof Error ? error.message : "Could not save provider profile.",
      });
    }
  }

  async function handleActivateProviderProfile(providerProfileId: string): Promise<void> {
    if (!providerProfileId) {
      return;
    }
    try {
      await activateProviderProfile(providerProfileId);
      await loadProviderProfiles();
      const profile = await fetchProviderProfile(providerProfileId);
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
        error: error instanceof Error ? error.message : "Could not activate provider profile.",
      });
    }
  }

  async function handleDeleteProviderProfile(providerProfileId?: string): Promise<void> {
    const targetId = providerProfileId || selectedProviderProfileId;
    if (!targetId) {
      return;
    }

    try {
      await deleteProviderProfile(targetId);
      await loadProviderProfiles();
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
        error: error instanceof Error ? error.message : "Could not delete provider profile.",
      });
    }
  }

  async function handleCreateProviderProfile(): Promise<ProviderProfileRecord | null> {
    try {
      const saved = await saveProviderProfile({
        name: "Новый профиль",
        type: PROVIDER_TYPE.openaiCompat,
        endpoint: "",
        temperature: 0.9,
        topP: 1.0,
        minP: 0.05,
        topK: 40,
        typicalP: 1.0,
        repPen: 1.1,
        freqPen: 0.0,
        presPen: 0.0,
        maxTokens: 8192,
        stopSeq: "",
        seed: null,
        reasoningEffort: "medium",
        streamResponse: true,
      });
      await loadProviderProfiles();
      return saved;
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to create provider profile.");
      return null;
    }
  }

  async function handleDuplicateProviderProfile(id: string): Promise<ProviderProfileRecord | null> {
    const existing = providerProfiles.find((p) => p.id === id);
    if (!existing) return null;
    try {
      const saved = await saveProviderProfile({
        name: `${existing.name} (copy)`,
        type: existing.type,
        endpoint: existing.endpoint,
        defaultModel: existing.defaultModel,
        temperature: existing.temperature ?? 0.9,
        topP: existing.topP ?? 1.0,
        minP: existing.minP ?? 0.05,
        topK: existing.topK ?? 40,
        typicalP: existing.typicalP ?? 1.0,
        repPen: existing.repPen ?? 1.1,
        freqPen: existing.freqPen ?? 0.0,
        presPen: existing.presPen ?? 0.0,
        maxTokens: existing.maxTokens ?? 8192,
        stopSeq: existing.stopSeq ?? "",
        seed: existing.seed ?? null,
        reasoningEffort: existing.reasoningEffort ?? "medium",
        streamResponse: existing.streamResponse ?? true,
      });
      await loadProviderProfiles();
      return saved;
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to duplicate provider profile.");
      return null;
    }
  }

  async function handleTestDraftConnection(endpoint: string, apiKey: string, providerType?: string): Promise<ProviderProbeResponse> {
    return testProviderDraft({ endpoint, apiKey, providerType });
  }

  async function handleTestProfileConnection(providerProfileId: string): Promise<ProviderProbeResponse> {
    return testProviderProfile(providerProfileId);
  }

  async function handleTestChat(
    profileId: string | null,
    baseUrl: string,
    apiKey: string,
    model: string,
    providerType?: string,
  ): Promise<TestChatResponse> {
    if (profileId) {
      return testProfileChatClient(profileId, model);
    }
    return testProviderChatClient(baseUrl, apiKey, model, providerType);
  }

  async function handleFetchModelsForProfile(providerProfileId: string): Promise<Array<{ id: string; label: string; contextLength?: number }>> {
    const response = await fetchModelsForProviderProfile(providerProfileId);
    return response.models;
  }

  async function handleLoadFavoriteProviderModels(providerProfileId: string): Promise<FavoriteProviderModelRecord[]> {
    const favorites = await listFavoriteProviderModels(providerProfileId);
    setFavoriteModelsByProfile((current) => ({ ...current, [providerProfileId]: favorites }));
    return favorites;
  }

  async function handleToggleFavoriteProviderModel(
    providerProfileId: string,
    model: { id: string; label?: string | null; contextLength?: number | null },
  ): Promise<void> {
    const current = favoriteModelsByProfile[providerProfileId] ?? [];
    const isFavorite = current.some((favorite) => favorite.modelId === model.id);
    if (isFavorite) {
      await removeFavoriteProviderModel(providerProfileId, model.id);
      setFavoriteModelsByProfile((prev) => ({
        ...prev,
        [providerProfileId]: (prev[providerProfileId] ?? []).filter((favorite) => favorite.modelId !== model.id),
      }));
      return;
    }
    const saved = await addFavoriteProviderModel(providerProfileId, {
      modelId: model.id,
      label: model.label ?? model.id,
      contextLength: model.contextLength ?? null,
    });
    setFavoriteModelsByProfile((prev) => ({
      ...prev,
      [providerProfileId]: [...(prev[providerProfileId] ?? []), saved],
    }));
  }

  async function handleSelectFavoriteProviderModel(providerProfileId: string, modelId: string): Promise<void> {
    const saved = await updateProviderProfile(providerProfileId, { defaultModel: modelId });
    await loadProviderProfiles();
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
    const response = await fetchModelsByEndpointClient(baseUrl, apiKey, providerType);
    return response.models;
  }

  async function handleRefreshProfiles(): Promise<void> {
    await loadProviderProfiles();
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
      type: form.type || PROVIDER_TYPE.openaiCompat,
      endpoint,
      apiKey: apiKeyInput.length > 0 ? apiKeyInput : undefined,
      defaultModel: form.model.trim() || null,
      contextBudget: form.contextBudget || 128000,
      temperature: form.temperature,
      topP: form.topP,
      minP: form.minP,
      topK: form.topK,
      typicalP: form.typicalP,
      repPen: form.repPen,
      freqPen: form.freqPen,
      presPen: form.presPen,
      maxTokens: form.maxTokens,
      stopSeq: form.stopSeq,
      seed: form.seed,
      reasoningEffort: form.reasoningEffort,
      streamResponse: form.streamResponse,
    };
    try {
      const saved = await updateProviderProfile(form.id, patch);
      await loadProviderProfiles();
      return saved;
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Could not save provider profile.");
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

    setChatNotice("");

    try {
      const result = await testProviderProfile(providerProfileId);
      if (result.success) {
        const countHint = typeof result.modelCount === "number"
          ? ` Provider advertises ${result.modelCount} models — press Refresh models to load them.`
          : "";
        setChatNotice(`Connection verified.${countHint}`);
      } else {
        setChatNotice(result.error ?? "Connection probe failed.");
      }
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Connection probe failed.");
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
        fetchProviderProfile(providerProfileId),
        fetchModelsForProviderProfile(providerProfileId),
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
        error: error instanceof Error ? error.message : "Could not refresh model list.",
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
