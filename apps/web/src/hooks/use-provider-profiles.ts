import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { ProviderProbeResponse } from "@vibe-tavern/domain";
import { PROVIDER_TYPE } from "@vibe-tavern/domain";
import { getT } from "../i18n/locale-helpers.js";
import { computeHydration } from "./hydrate-provider.js";
import { computeSavePatch, computeOverlayPatch, connectionToSavePatch, validateSavePatch, buildFavoriteModelSwitchPatch } from "./save-provider-patch.js";
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
  upsertProviderModelSettingsAction,
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
    const plan = computeHydration(profiles, startupProbeProfileIdsRef.current);
    if (!plan.profileId || !plan.connectionPatch) return;

    // 1. Patch connection state (base fields)
    patchConnection(plan.connectionPatch);

    // 2. Patch cached models (separate for clarity)
    if (plan.cachedModels) {
      patchConnection({ models: plan.cachedModels });
    }

    // 3. Auto-write detected vision model
    if (plan.autoWriteVision) {
      patchConnection({ visionModel: plan.autoWriteVision.modelId });
      console.log('[Hydrate] AUTO-WRITING visionModel to DB:', plan.autoWriteVision.modelId, '(profile.visionModel was empty)');
      void updateProviderProfileAction(plan.autoWriteVision.profileId, { visionModel: plan.autoWriteVision.modelId }).catch(() => {});
    }

    // 4. Network probe (first hydration only)
    if (plan.shouldProbe) {
      startupProbeProfileIdsRef.current.add(plan.profileId);
      void probeHydratedProviderProfile(plan.profileId);
    }
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

    setConnection((current) => ({
      ...current,
      baseUrl: normalizeOpenAiCompatibleBaseUrl(current.baseUrl),
      status: "connecting",
      error: "",
    }));

    try {
      const savedId = selectedProviderProfileId || connection.activeProviderProfileId || undefined;
      const patch = connectionToSavePatch(connection);

      const saved = savedId
        ? await updateProviderProfileAction(savedId, patch)
        : await saveProviderProfileAction(patch);

      setSelectedProviderProfileId(saved.id);
      patchConnection({
        providerLabel: saved.name,
        baseUrl: normalizeOpenAiCompatibleBaseUrl(saved.endpoint),
        apiKey: "",
        model: saved.defaultModel ?? connection.model,
        visionModel: saved.visionModel ?? connection.visionModel,
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
        visionModel: profile.visionModel ?? "",
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
    const patch = connectionToSavePatch(connection);
    const validationError = validateSavePatch(patch);
    if (validationError) {
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
      const patch = connectionToSavePatch(connection);

      const saved = existingId
        ? await updateProviderProfileAction(existingId, patch)
        : await saveProviderProfileAction(patch);

      setSelectedProviderProfileId(saved.id);
      patchConnection({
        providerLabel: saved.name,
        baseUrl: normalizeOpenAiCompatibleBaseUrl(saved.endpoint),
        apiKey: "",
        model: saved.defaultModel ?? connection.model,
        visionModel: saved.visionModel ?? connection.visionModel,
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
        visionModel: profile.visionModel ?? "",
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
    // Respect pinContextBudget: when the user has pinned a budget, switching
    // the active model from the chat-input starred-models dropdown must NOT
    // overwrite it (the three ProviderModelSelector sites gate on the pin;
    // this fourth path — the chat dropdown — historically did not, which was
    // the reported "pinned context size resets on model switch" bug).
    // The patch logic is extracted into a pure helper so the invariant is
    // unit-tested without rendering the React hook.
    const profile = providerProfiles.find((p) => p.id === providerProfileId);
    const favList = useProviderDataStore.getState().favoritesByProfile[providerProfileId] ?? [];
    const fav = favList.find((f) => f.modelId === modelId);
    const patch = buildFavoriteModelSwitchPatch({
      modelId,
      favorite: fav,
      pinContextBudget: profile?.pinContextBudget ?? false,
    });
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
    const basePatch = computeSavePatch(form);
    const validationError = validateSavePatch(basePatch);
    if (validationError) return null;

    // Binding routing (plan §Wave 4):
    //  - Overlay mode (bindPerModel && editingModelId): identity fields → base
    //    (partial PATCH), sampler/context → the model's overlay. The base's own
    //    sampler columns stay put (the overlay is the bound model's override).
    //  - Base mode (binding OFF, or no model picked): full PATCH — byte-identical
    //    to today's behavior (identity + sampler + bindPerModel all on base).
    //  - bindPerModel toggle is an identity-level field → always on the base.
    const isInOverlayMode = form.bindPerModel && form.editingModelId != null;

    try {
      let saved: ProviderProfileRecord | null;
      if (isInOverlayMode) {
        // Identity-only base write (partial PATCH — updateProviderProfileSchema
        // is providerCoreSchema.partial(), so omitted sampler fields are not
        // touched on the base).
        const identityPatch = {
          name: basePatch.name,
          providerPreset: basePatch.providerPreset,
          endpoint: basePatch.endpoint,
          apiKey: basePatch.apiKey,
          defaultModel: basePatch.defaultModel,
          visionModel: basePatch.visionModel,
          bindPerModel: basePatch.bindPerModel,
        };
        saved = form.id
          ? await updateProviderProfileAction(form.id, identityPatch)
          : await saveProviderProfileAction(basePatch);
        // For a brand-new profile in overlay mode there's nothing sensible to
        // overlay yet (no base to merge over + no favorites to pick from), so
        // we fall back to the full base save and skip the overlay write.
        if (form.id) {
          await upsertProviderModelSettingsAction(
            form.id,
            form.editingModelId!,
            computeOverlayPatch(form),
          );
        }
      } else {
        saved = form.id
          ? await updateProviderProfileAction(form.id, basePatch)
          : await saveProviderProfileAction(basePatch);
      }
      console.log('[handleSave] saved result:', { id: saved?.id, defaultModel: saved?.defaultModel, visionModel: saved?.visionModel, overlayMode: isInOverlayMode });
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
