import {
  activateProviderProfile,
  addFavoriteProviderModel,
  deleteProviderProfile,
  fetchModelsByEndpoint,
  fetchProviderProfile,
  fetchProviderProfileModels,
  getProviderModelSettings,
  listFavoriteProviderModels,
  listProviderModelSettings,
  listProviderProfiles,
  removeFavoriteProviderModel,
  saveProviderProfile,
  testProfileChat,
  testProviderChat,
  testProviderDraft,
  testProviderProfile,
  updateProviderProfile,
  upsertProviderModelSettings,
  type FavoriteProviderModelRecord,
  type ProviderModelSettingsRecord,
  type ProviderProfileRecord,
  type TestChatResponse,
} from "../../app-client.js";
import type { ModelSettingsOverlay, ProviderProbeResponse } from "@vibe-tavern/domain";
import { useProviderDataStore } from "../provider-data-store.js";

// ---------------------------------------------------------------------------
// Provider Actions
// ---------------------------------------------------------------------------

export async function loadProviderProfilesAction(): Promise<void> {
  const profiles = await listProviderProfiles();
  useProviderDataStore.getState().setProfiles(profiles);
}

export async function loadFavoriteModelsAction(profileId: string): Promise<void> {
  const favorites = await listFavoriteProviderModels(profileId);
  useProviderDataStore.getState().setFavorites(profileId, favorites);
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

export async function activateProviderProfileAction(id: string): Promise<void> {
  await activateProviderProfile(id);
  void loadProviderProfilesAction();
}

export async function toggleFavoriteModelAction(
  profileId: string,
  modelId: string,
  label: string | null | undefined,
  contextLength: number | null | undefined,
  removing: boolean
): Promise<void> {
  if (removing) {
    await removeFavoriteProviderModel(profileId, modelId);
  } else {
    await addFavoriteProviderModel(profileId, { modelId, label, contextLength });
  }
  void loadFavoriteModelsAction(profileId);
}

// ---------------------------------------------------------------------------
// Per-model settings overlay (binding) Actions
// ---------------------------------------------------------------------------

/** Fetch every overlay row for a profile (for the binding dropdown's badges).
 *  Thin wrapper around {@link listProviderModelSettings}; no store side-effect
 *  yet (Wave 5 may cache into provider-data-store). */
export async function listProviderModelSettingsAction(profileId: string): Promise<ProviderModelSettingsRecord[]> {
  return await listProviderModelSettings(profileId);
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
  return await upsertProviderModelSettings(profileId, modelId, settings);
}

// ---------------------------------------------------------------------------
// Test/Probe Actions (no state side effects)
// ---------------------------------------------------------------------------

export async function testProviderProfileAction(id: string): Promise<ProviderProbeResponse> {
  return await testProviderProfile(id);
}

export async function testProviderDraftAction(
  input: { endpoint: string; apiKey: string; providerType?: string }
): Promise<ProviderProbeResponse> {
  return await testProviderDraft(input);
}

export async function testProfileChatAction(
  profileId: string,
  model: string
): Promise<TestChatResponse> {
  return await testProfileChat(profileId, model);
}

export async function testProviderChatAction(
  baseUrl: string,
  apiKey: string,
  model: string,
  providerType?: string
): Promise<TestChatResponse> {
  return await testProviderChat(baseUrl, apiKey, model, providerType);
}

export async function fetchModelsByEndpointAction(
  baseUrl: string,
  apiKey?: string,
  providerType?: string
) {
  return await fetchModelsByEndpoint(baseUrl, apiKey, providerType);
}
