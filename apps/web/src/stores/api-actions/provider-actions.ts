import { activateProviderProfile, addFavoriteProviderModel, deleteProviderProfile, fetchModelsByEndpoint, fetchProviderProfile, fetchProviderProfileModels, getCoauthorConnectionSettings, getProviderModelSettings, listFavoriteProviderModels, listProviderModelSettings, listProviderProfiles, removeFavoriteProviderModel, saveProviderProfile, testProfileChat, testProviderChat, testProviderDraft, testProviderProfile, updateProviderProfile, upsertCoauthorConnectionSettings, upsertProviderModelSettings, reorderProviderProfiles, reorderCoauthorProviderProfiles } from "../../api/provider-api.js";
import type { CoauthorConnectionSettingsRecord, FavoriteProviderModelRecord, ProviderModelSettingsRecord, ProviderProfileRecord, TestChatResponse } from "../../api/types.js";
import type { CoauthorTransport, ModelFavoriteScope, ModelSettingsOverlay, ProviderProbeResponse, ProviderProxyMode } from "@vibe-tavern/domain";
import type { UpsertCoauthorConnectionSettingsValue } from "@vibe-tavern/api-contracts";
import { useProviderDataStore } from "../provider-data-store.js";

// ---------------------------------------------------------------------------
// Provider Actions
// ---------------------------------------------------------------------------

export async function loadProviderProfilesAction(): Promise<void> {
  const profiles = await listProviderProfiles();
  useProviderDataStore.getState().setProfiles(profiles);
}

export async function loadFavoriteModelsAction(profileId: string, scope: ModelFavoriteScope): Promise<void> {
  const favorites = await listFavoriteProviderModels(profileId, scope);
  useProviderDataStore.getState().setFavorites(profileId, scope, favorites);
}

export async function fetchProviderProfileAction(profileId: string): Promise<ProviderProfileRecord> {
  return await fetchProviderProfile(profileId);
}

export async function fetchProviderModelsAction(profileId: string) {
  return await fetchProviderProfileModels(profileId);
}

export async function saveProviderProfileAction(
  input: Parameters<typeof saveProviderProfile>[0]
): Promise<ProviderProfileRecord> {
  const result = await saveProviderProfile(input);
  void loadProviderProfilesAction();
  return result;
}

export async function updateProviderProfileAction(
  id: string,
  patch: Parameters<typeof updateProviderProfile>[1]
): Promise<ProviderProfileRecord> {
  const result = await updateProviderProfile(id, patch);
  void loadProviderProfilesAction();
  return result;
}

export async function deleteProviderProfileAction(id: string): Promise<void> {
  await deleteProviderProfile(id);
  void loadProviderProfilesAction();
}

export async function reorderProviderProfilesAction(updates: Array<{ id: string; sortOrder: number }>): Promise<void> {
  await reorderProviderProfiles(updates);
  void loadProviderProfilesAction();
}

export async function reorderCoauthorProviderProfilesAction(updates: Array<{ id: string; sortOrder: number }>): Promise<void> {
  await reorderCoauthorProviderProfiles(updates);
  useProviderDataStore.setState((state) => ({
    coauthorSettingsByProfile: Object.fromEntries(Object.entries(state.coauthorSettingsByProfile).map(([id, record]) => [
      id,
      (() => {
        const update = updates.find((candidate) => candidate.id === id);
        if (!update) return record;
        return record ? { ...record, sortOrder: update.sortOrder } : {
          providerProfileId: id, modelName: null, settings: {}, sortOrder: update.sortOrder, createdAt: "", updatedAt: "",
        };
      })(),
    ])),
  }));
}

export async function activateProviderProfileAction(id: string): Promise<void> {
  await activateProviderProfile(id);
  void loadProviderProfilesAction();
}

export async function toggleFavoriteModelAction(
  profileId: string,
  modelId: string,
  label: string | null | undefined,
  contextLength: number | null | undefined,
  removing: boolean,
  scope: ModelFavoriteScope,
): Promise<void> {
  if (removing) {
    await removeFavoriteProviderModel(profileId, modelId, scope);
  } else {
    await addFavoriteProviderModel(profileId, { modelId, label, contextLength, scope });
  }
  await loadFavoriteModelsAction(profileId, scope);
}

// ---------------------------------------------------------------------------
// Per-model settings overlay (binding) Actions
// ---------------------------------------------------------------------------

/** Fetch every overlay row for a profile and cache it in the data store —
 *  the chat-side effective-settings display resolves the ACTIVE model's
 *  values through this cache (RP_QUICK_SWITCH_MODEL_SETTINGS_REPORT step 2;
 *  the Wave 5 cache this wrapper used to defer). */
export async function loadProviderModelSettingsAction(profileId: string): Promise<ProviderModelSettingsRecord[]> {
  const records = await listProviderModelSettings(profileId);
  useProviderDataStore.getState().setModelSettings(profileId, records);
  return records;
}

/** Fetch a single model's overlay, or `null` when no overlay exists (base
 *  passthrough). Used by Wave 5 to re-hydrate the form when the user picks a
 *  binding target. */
export async function getProviderModelSettingsAction(profileId: string, modelId: string): Promise<ProviderModelSettingsRecord | null> {
  return await getProviderModelSettings(profileId, modelId);
}

/** Upsert (create-or-replace) a model's overlay. Called from the modal save
 *  handler when the form is in overlay-edit mode
 *  (`form.bindPerModel && form.editingModelId`). Returns the persisted record. */
export async function upsertProviderModelSettingsAction(
  profileId: string,
  modelId: string,
  settings: ModelSettingsOverlay,
): Promise<ProviderModelSettingsRecord> {
  const record = await upsertProviderModelSettings(profileId, modelId, settings);
  // Keep a LOADED display cache fresh (absent key = never loaded — the loader
  // fetches on demand, so there is nothing to patch).
  useProviderDataStore.setState((state) => {
    const cached = state.modelSettingsByProfile[profileId];
    if (!cached) return {};
    return {
      modelSettingsByProfile: {
        ...state.modelSettingsByProfile,
        [profileId]: [...cached.filter((row) => row.modelId !== modelId), record],
      },
    };
  });
  return record;
}

// ---------------------------------------------------------------------------
// Co-Author per-connection generation set (CG-1) Actions
// ---------------------------------------------------------------------------

/** Load the connection's Co-Author row into the store (once per profile — the
 *  cache makes the binding hook's repeat mounts free). null = the connection
 *  has no saved set (Co-Author defaults apply); callers that need to re-write
 *  the row use the returned record as the read side of a read-modify-write. */
export async function loadCoauthorConnectionSettingsAction(profileId: string): Promise<CoauthorConnectionSettingsRecord | null> {
  const cached = useProviderDataStore.getState().coauthorSettingsByProfile[profileId];
  if (cached !== undefined) return cached;
  const record = await getCoauthorConnectionSettings(profileId);
  useProviderDataStore.getState().setCoauthorSettings(profileId, record);
  return record;
}

/** PUT the connection's whole Co-Author set (the route replaces the record)
 *  and cache the result so binding subscribers see the new model immediately. */
export async function upsertCoauthorConnectionSettingsAction(
  profileId: string,
  body: UpsertCoauthorConnectionSettingsValue,
): Promise<CoauthorConnectionSettingsRecord> {
  const record = await upsertCoauthorConnectionSettings(profileId, body);
  useProviderDataStore.getState().setCoauthorSettings(profileId, record);
  return record;
}

// ---------------------------------------------------------------------------
// Test/Probe Actions (no state side effects)
// ---------------------------------------------------------------------------

export async function testProviderProfileAction(id: string): Promise<ProviderProbeResponse> {
  return await testProviderProfile(id);
}

export async function testProviderDraftAction(
  input: { endpoint: string; apiKey: string; providerType?: string; proxyMode?: ProviderProxyMode; proxyId?: string | null; providerProfileId?: string }
): Promise<ProviderProbeResponse> {
  return await testProviderDraft(input);
}

export async function testProfileChatAction(
  profileId: string,
  model: string,
  transport?: CoauthorTransport,
): Promise<TestChatResponse> {
  return await testProfileChat(profileId, model, transport);
}

export async function testProviderChatAction(
  baseUrl: string,
  apiKey: string,
  model: string,
  providerType?: string,
  proxyMode?: ProviderProxyMode,
  proxyId?: string | null,
): Promise<TestChatResponse> {
  return await testProviderChat(baseUrl, apiKey, model, providerType, proxyMode, proxyId);
}

export async function fetchModelsByEndpointAction(
  baseUrl: string,
  apiKey?: string,
  providerType?: string,
  proxyMode?: ProviderProxyMode,
  proxyId?: string | null,
) {
  return await fetchModelsByEndpoint(baseUrl, apiKey, providerType, proxyMode, proxyId);
}
