import { ENTITY_ID_NAMESPACE } from "@rp-platform/domain";
import {
  toClientProviderProfile,
  resolveStoredApiKey,
  type StoredProviderProfileRecord,
  type ClientProviderProfileRecord,
  type CachedProviderModelsRecord,
} from "./session-runtime-dto.js";
import type { ChatSessionStore } from "@rp-platform/db";

export interface ProviderModuleDeps {
  store: ChatSessionStore;
  providerModelsCache: Map<string, CachedProviderModelsRecord>;
}

export function listProviderProfiles(deps: ProviderModuleDeps): ClientProviderProfileRecord[] {
  return deps.store
    .listProviderProfiles()
    .map((profile) => toClientProviderProfile(profile as StoredProviderProfileRecord));
}

export async function saveProviderProfile(deps: ProviderModuleDeps, profile: any): Promise<ClientProviderProfileRecord> {
  const existing = profile.id
    ? (deps.store.getProviderProfile(profile.id) as StoredProviderProfileRecord | null)
    : null;
  const resolvedId =
    profile.id ||
    existing?.id ||
    `${ENTITY_ID_NAMESPACE.providerProfile}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const hasApiKeyInput = Object.prototype.hasOwnProperty.call(profile, "apiKey");
  const apiKey = hasApiKeyInput
    ? resolveStoredApiKey(profile.apiKey, existing?.apiKey ?? null)
    : (existing?.apiKey ?? null);

  const toSave = {
    ...existing,
    ...profile,
    id: resolvedId,
    apiKey,
  };

  deps.store.upsertProviderProfile(toSave);
  return toClientProviderProfile(toSave as StoredProviderProfileRecord);
}

export function deleteProviderProfile(deps: ProviderModuleDeps, id: string): void {
  deps.store.deleteProviderProfile(id);
}

export function activateProviderProfile(deps: ProviderModuleDeps, id: string): ClientProviderProfileRecord {
  deps.store.setActiveProviderProfile(id);
  const profile = deps.store.getProviderProfile(id) as StoredProviderProfileRecord | null;
  if (!profile) {
    throw new Error(`Provider profile '${id}' was not found after activation.`);
  }
  return toClientProviderProfile(profile);
}

export function resolveActiveProviderProfile(deps: ProviderModuleDeps): StoredProviderProfileRecord | null {
  return deps.store.getActiveProviderProfile() as StoredProviderProfileRecord | null;
}

export function updateProviderProfile(
  deps: ProviderModuleDeps,
  id: string,
  patch: {
    name?: string;
    type?: string;
    endpoint?: string;
    apiKey?: unknown;
    defaultModel?: string | null;
    contextBudget?: number | null;
    temperature?: number;
    topP?: number;
    minP?: number;
    topK?: number;
    typicalP?: number;
    repPen?: number;
    freqPen?: number;
    presPen?: number;
    maxTokens?: number;
    stopSeq?: string;
    seed?: string | null;
    reasoningEffort?: string;
    streamResponse?: boolean;
  },
): ClientProviderProfileRecord {
  const existing = deps.store.getProviderProfile(id) as StoredProviderProfileRecord | null;
  if (!existing) {
    throw new Error(`Provider profile '${id}' was not found.`);
  }
  const hasApiKeyInput = Object.prototype.hasOwnProperty.call(patch, "apiKey");
  const apiKey = hasApiKeyInput
    ? resolveStoredApiKey(patch.apiKey, existing.apiKey ?? null)
    : (existing.apiKey ?? null);
  const merged: StoredProviderProfileRecord = {
    ...existing,
    ...patch,
    apiKey,
    id,
    isActive: existing.isActive,
  };
  deps.store.upsertProviderProfile(merged);
  return toClientProviderProfile(merged);
}

export function getProviderProfile(deps: ProviderModuleDeps, id: string): StoredProviderProfileRecord | null {
  return deps.store.getProviderProfile(id) as StoredProviderProfileRecord | null;
}

export function getProviderProfileForClient(deps: ProviderModuleDeps, id: string): ClientProviderProfileRecord | null {
  const profile = getProviderProfile(deps, id);
  return profile ? toClientProviderProfile(profile) : null;
}

export function getCachedProviderModels(deps: ProviderModuleDeps, providerProfileId: string): CachedProviderModelsRecord | null {
  return deps.providerModelsCache.get(providerProfileId) ?? null;
}

export function setCachedProviderModels(
  deps: ProviderModuleDeps,
  providerProfileId: string,
  models: Array<{ id: string; label: string }>,
): CachedProviderModelsRecord {
  const cached = {
    models,
    cachedAt: new Date().toISOString(),
  };
  deps.providerModelsCache.set(providerProfileId, cached);
  return cached;
}
