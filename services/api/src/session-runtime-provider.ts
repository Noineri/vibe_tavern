import type { ProviderStore, ProviderProfile } from "@rp-platform/db";
import {
  toClientProviderProfile,
  resolveStoredApiKey,
  providerProfileToStoredRecord,
  providerPatchToUpdateData,
  type StoredProviderProfileRecord,
  type ClientProviderProfileRecord,
  type CachedProviderModelsRecord,
} from "./session-runtime-dto.js";
import { notFound } from "./errors.js";
import { logSendDebug } from "./send-debug-log.js";

export interface ProviderModuleDeps {
  providers: ProviderStore;
}

export async function listProviderProfiles(deps: ProviderModuleDeps): Promise<ClientProviderProfileRecord[]> {
  const profiles = await deps.providers.listAll();
  return profiles.map((profile) => toClientProviderProfile(providerProfileToStoredRecord(profile)));
}

export async function saveProviderProfile(deps: ProviderModuleDeps, profile: Partial<StoredProviderProfileRecord>): Promise<ClientProviderProfileRecord> {
  const existing = profile.id
    ? await deps.providers.getById(profile.id)
    : null;

  const hasApiKeyInput = Object.prototype.hasOwnProperty.call(profile, "apiKey");
  const apiKey = hasApiKeyInput
    ? resolveStoredApiKey(profile.apiKey, existing?.apiKey ?? null)
    : (existing?.apiKey ?? null);

  logSendDebug("provider.save", {
    operation: existing ? "update" : "create",
    profileId: profile.id ?? "(new)",
    hasApiKeyInput,
    rawApiKeyProvided: profile.apiKey !== undefined ? (typeof profile.apiKey === "string" ? `string(${profile.apiKey.length}ch)` : typeof profile.apiKey) : "(absent)",
    resolvedApiKeyLength: apiKey?.length ?? 0,
    existingApiKeyLength: existing?.apiKey?.length ?? 0,
    incomingFields: Object.keys(profile).sort().join(","),
  });

  if (existing) {
    // Update existing profile
    const patch: Record<string, unknown> = { ...profile, apiKey };
    delete (patch as any).id;
    delete (patch as any).isActive;
    delete (patch as any).createdAt;
    delete (patch as any).updatedAt;
    // Map old field names to new
    const updateData = providerPatchToUpdateData(patch as any);
    logSendDebug("provider.save.updateData", {
      profileId: existing.id,
      updateDataApiKeyLength: typeof updateData.apiKey === "string" ? updateData.apiKey.length : `(type: ${typeof updateData.apiKey})`,
      updateDataFields: Object.keys(updateData).filter(k => (updateData as any)[k] !== undefined).sort().join(","),
    });
    await deps.providers.update(existing.id, updateData);
    const updated = (await deps.providers.getById(existing.id))!;
    logSendDebug("provider.save.afterDb", {
      profileId: updated.id,
      dbApiKeyLength: updated.apiKey?.length ?? 0,
    });
    return toClientProviderProfile(providerProfileToStoredRecord(updated));
  }

  // Create new profile
  logSendDebug("provider.save.create", {
    name: profile.name ?? "New Provider",
    providerPreset: profile.type ?? "openai",
    apiKeyLength: apiKey?.length ?? 0,
  });
  const created = await deps.providers.create({
    name: profile.name ?? "New Provider",
    providerPreset: profile.type ?? "openai",
    endpoint: profile.endpoint ?? "",
    apiKey,
    defaultModel: profile.defaultModel,
    contextBudget: profile.contextBudget,
    temperature: profile.temperature,
    topP: profile.topP,
    minP: profile.minP,
    topK: profile.topK,
    frequencyPenalty: profile.freqPen,
    presencePenalty: profile.presPen,
    repetitionPenalty: profile.repPen,
    maxTokens: profile.maxTokens,
    stopSequences: profile.stopSeq ? profile.stopSeq.split(",").map(s => s.trim()).filter(Boolean) : undefined,
    seed: profile.seed,
    reasoningEffort: profile.reasoningEffort,
    streamResponse: profile.streamResponse,
  });
  logSendDebug("provider.save.created", {
    profileId: created.id,
    dbApiKeyLength: created.apiKey?.length ?? 0,
  });
  return toClientProviderProfile(providerProfileToStoredRecord(created));
}

export async function deleteProviderProfile(deps: ProviderModuleDeps, id: string): Promise<void> {
  try {
    await deps.providers.delete(id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found/i.test(message)) {
      throw notFound("ProviderProfile", message);
    }
    throw error;
  }
}

export async function activateProviderProfile(deps: ProviderModuleDeps, id: string): Promise<ClientProviderProfileRecord> {
  await deps.providers.activate(id);
  const profile = await deps.providers.getById(id);
  if (!profile) {
    throw notFound("ProviderProfile", `Provider profile '${id}' was not found after activation.`);
  }
  return toClientProviderProfile(providerProfileToStoredRecord(profile));
}

export async function resolveActiveProviderProfile(deps: ProviderModuleDeps): Promise<StoredProviderProfileRecord | null> {
  const profile = await deps.providers.getActive();
  if (profile) {
    logSendDebug("provider.resolveActive", {
      profileId: profile.id,
      name: profile.name,
      providerPreset: profile.providerPreset,
      apiKeyLength: profile.apiKey?.length ?? 0,
      defaultModel: profile.defaultModel,
    });
  } else {
    logSendDebug("provider.resolveActive", { profileId: null });
  }
  return profile ? providerProfileToStoredRecord(profile) : null;
}

export async function updateProviderProfile(
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
): Promise<ClientProviderProfileRecord> {
  const existing = await deps.providers.getById(id);
  if (!existing) {
    throw notFound("ProviderProfile", `Provider profile '${id}' was not found.`);
  }
  const hasApiKeyInput = Object.prototype.hasOwnProperty.call(patch, "apiKey");
  const apiKey = hasApiKeyInput
    ? resolveStoredApiKey(patch.apiKey, existing.apiKey ?? null)
    : (existing.apiKey ?? null);

  logSendDebug("provider.update", {
    profileId: id,
    hasApiKeyInput,
    rawApiKeyProvided: patch.apiKey !== undefined ? (typeof patch.apiKey === "string" ? `string(${patch.apiKey.length}ch)` : typeof patch.apiKey) : "(absent)",
    resolvedApiKeyLength: apiKey?.length ?? 0,
    existingApiKeyLength: existing.apiKey?.length ?? 0,
    patchFields: Object.keys(patch).sort().join(","),
  });

  const updateData = providerPatchToUpdateData(patch);
  if (hasApiKeyInput) updateData.apiKey = apiKey;

  logSendDebug("provider.update.data", {
    profileId: id,
    updateDataApiKeyLength: typeof updateData.apiKey === "string" ? updateData.apiKey.length : `(type: ${typeof updateData.apiKey})`,
    updateDataFields: Object.keys(updateData).filter(k => updateData[k as keyof typeof updateData] !== undefined).sort().join(","),
  });

  await deps.providers.update(id, updateData);

  const updated = (await deps.providers.getById(id))!;
  logSendDebug("provider.update.afterDb", {
    profileId: id,
    dbApiKeyLength: updated.apiKey?.length ?? 0,
  });
  return toClientProviderProfile(providerProfileToStoredRecord(updated));
}

export async function getProviderProfile(deps: ProviderModuleDeps, id: string): Promise<StoredProviderProfileRecord | null> {
  const profile = await deps.providers.getById(id);
  return profile ? providerProfileToStoredRecord(profile) : null;
}

export async function getProviderProfileForClient(deps: ProviderModuleDeps, id: string): Promise<ClientProviderProfileRecord | null> {
  const profile = await getProviderProfile(deps, id);
  return profile ? toClientProviderProfile(profile) : null;
}

export async function getCachedProviderModels(deps: ProviderModuleDeps, providerProfileId: string): Promise<CachedProviderModelsRecord | null> {
  const models = await deps.providers.getCachedModels(providerProfileId);
  if (!models || models.length === 0) return null;
  return {
    models: models.map((m) => ({ id: m.modelSlug, label: m.modelName })),
    cachedAt: models[0]?.fetchedAt ?? new Date().toISOString(),
  };
}

export async function setCachedProviderModels(
  deps: ProviderModuleDeps,
  providerProfileId: string,
  models: Array<{ id: string; label: string }>,
): Promise<CachedProviderModelsRecord> {
  await deps.providers.saveCachedModels(providerProfileId, models.map((m) => ({
    modelSlug: m.id,
    modelName: m.label,
  })));
  return {
    models,
    cachedAt: new Date().toISOString(),
  };
}
