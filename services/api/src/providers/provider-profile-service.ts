import type { ProviderStore } from "@vibe-tavern/db";
import type { StoredProviderProfileRecord } from "@vibe-tavern/domain";
import {
  toClientProviderProfile,
  resolveStoredApiKey,
  type ClientProviderProfileRecord,
  type CachedProviderModelsRecord,
  type FavoriteProviderModelRecord,
} from "../session/session-runtime-dto.js";
import { notFound } from "../errors.js";
import { logSendDebug } from "../send-debug-log.js";

// ─── Public contract (duck-typed — consumers import this as `type`) ──────

export interface ProviderProfileService {
  listProviderProfiles(): Promise<ClientProviderProfileRecord[]>;
  saveProviderProfile(profile: Partial<StoredProviderProfileRecord>): Promise<ClientProviderProfileRecord>;
  deleteProviderProfile(id: string): Promise<void>;
  activateProviderProfile(id: string): Promise<ClientProviderProfileRecord>;
  resolveActiveProviderProfile(): Promise<StoredProviderProfileRecord | null>;
  updateProviderProfile(
    id: string,
    patch: Partial<Omit<StoredProviderProfileRecord, 'id' | 'isActive' | 'createdAt' | 'updatedAt'>>,
  ): Promise<ClientProviderProfileRecord>;
  getProviderProfile(id: string): Promise<StoredProviderProfileRecord | null>;
  getProviderProfileForClient(id: string): Promise<ClientProviderProfileRecord | null>;
  getCachedProviderModels(providerProfileId: string): Promise<CachedProviderModelsRecord | null>;
  setCachedProviderModels(
    providerProfileId: string,
    models: Array<{ id: string; label: string; contextLength?: number; capabilities?: { thinking?: boolean; tools?: boolean; vision?: boolean } }>,
  ): Promise<CachedProviderModelsRecord>;
  listFavoriteProviderModels(providerProfileId: string): Promise<FavoriteProviderModelRecord[]>;
  addFavoriteProviderModel(
    providerProfileId: string,
    model: { modelId: string; label?: string | null; contextLength?: number | null },
  ): Promise<FavoriteProviderModelRecord>;
  removeFavoriteProviderModel(providerProfileId: string, modelId: string): Promise<void>;
}

// ─── Factory ─────────────────────────────────────────────────────────────

async function withCachedModels(providers: ProviderStore, profile: ClientProviderProfileRecord): Promise<ClientProviderProfileRecord> {
  const cached = await providers.getCachedModels(profile.id);
  if (cached && cached.length > 0) {
    return {
      ...profile,
      cachedModels: {
        models: cached.map((m) => ({
          id: m.modelSlug,
          label: m.modelName,
          ...(m.contextLength != null ? { contextLength: m.contextLength } : {}),
          ...(m.capabilities ? { capabilities: m.capabilities } : {}),
        })),
        cachedAt: cached[0]!.fetchedAt,
      },
    };
  }
  return profile;
}

export function createProviderProfileService(providers: ProviderStore): ProviderProfileService {
  return {
    listProviderProfiles: async () => {
      const profiles = await providers.listAll();
      const clientProfiles = profiles.map(toClientProviderProfile);
      return Promise.all(clientProfiles.map((p) => withCachedModels(providers, p)));
    },

    saveProviderProfile: async (profile) => {
      const existing = profile.id
        ? await providers.getById(profile.id)
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
        const { id: _id, isActive: _isActive, createdAt: _ca, updatedAt: _ua, ...patch } = profile;
        logSendDebug("provider.save.updateData", {
          profileId: existing.id,
          updateDataApiKeyLength: typeof patch.apiKey === "string" ? patch.apiKey.length : `(type: ${typeof patch.apiKey})`,
          updateDataFields: Object.keys(patch).filter(k => (patch as Record<string, unknown>)[k] !== undefined).sort().join(","),
        });
        await providers.update(existing.id, patch);
        const updated = (await providers.getById(existing.id))!;
        logSendDebug("provider.save.afterDb", {
          profileId: updated.id,
          dbApiKeyLength: updated.apiKey?.length ?? 0,
        });
        return toClientProviderProfile(updated);
      }

      logSendDebug("provider.save.create", {
        name: profile.name ?? "New Provider",
        providerPreset: profile.providerPreset ?? "openai",
        apiKeyLength: apiKey?.length ?? 0,
      });
      const created = await providers.create({
        name: profile.name ?? "New Provider",
        providerPreset: profile.providerPreset ?? "openai",
        endpoint: profile.endpoint ?? "",
        apiKey,
        defaultModel: profile.defaultModel,
        visionModel: profile.visionModel,
        contextBudget: profile.contextBudget,
        temperature: profile.temperature,
        topP: profile.topP,
        minP: profile.minP,
        topK: profile.topK,
        topA: profile.topA,
        typicalP: profile.typicalP,
        tfsZ: profile.tfsZ,
        repeatLastN: profile.repeatLastN,
        mirostat: profile.mirostat,
        mirostatTau: profile.mirostatTau,
        mirostatEta: profile.mirostatEta,
        dryMultiplier: profile.dryMultiplier,
        dryBase: profile.dryBase,
        dryAllowedLength: profile.dryAllowedLength,
        drySequenceBreakers: profile.drySequenceBreakers,
        xtcThreshold: profile.xtcThreshold,
        xtcProbability: profile.xtcProbability,
        frequencyPenalty: profile.frequencyPenalty,
        presencePenalty: profile.presencePenalty,
        repetitionPenalty: profile.repetitionPenalty,
        maxTokens: profile.maxTokens,
        stopSequences: profile.stopSequences,
        seed: profile.seed,
        reasoningEffort: profile.reasoningEffort,
        showReasoning: profile.showReasoning,
        streamResponse: profile.streamResponse,
        customSamplers: profile.customSamplers,
      });
      logSendDebug("provider.save.created", {
        profileId: created.id,
        dbApiKeyLength: created.apiKey?.length ?? 0,
      });
      return toClientProviderProfile(created);
    },

    deleteProviderProfile: async (id) => {
      try {
        await providers.delete(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/not found/i.test(message)) {
          throw notFound("ProviderProfile", message);
        }
        throw error;
      }
    },

    activateProviderProfile: async (id) => {
      await providers.activate(id);
      const profile = await providers.getById(id);
      if (!profile) {
        throw notFound("ProviderProfile", `Provider profile '${id}' was not found after activation.`);
      }
      return toClientProviderProfile(profile);
    },

    resolveActiveProviderProfile: async () => {
      const profile = await providers.getActive();
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
      return profile;
    },

    updateProviderProfile: async (id, patch) => {
      const existing = await providers.getById(id);
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

      const updateData = { ...patch };
      if (hasApiKeyInput) updateData.apiKey = apiKey;

      logSendDebug("provider.update.data", {
        profileId: id,
        updateDataApiKeyLength: typeof updateData.apiKey === "string" ? updateData.apiKey.length : `(type: ${typeof updateData.apiKey})`,
        updateDataFields: Object.keys(updateData).filter(k => updateData[k as keyof typeof updateData] !== undefined).sort().join(","),
      });

      await providers.update(id, updateData);

      const updated = (await providers.getById(id))!;
      logSendDebug("provider.update.afterDb", {
        profileId: id,
        dbApiKeyLength: updated.apiKey?.length ?? 0,
      });
      return toClientProviderProfile(updated);
    },

    getProviderProfile: async (id) => {
      return providers.getById(id);
    },

    getProviderProfileForClient: async (id) => {
      const profile = await providers.getById(id);
      if (!profile) return null;
      return withCachedModels(providers, toClientProviderProfile(profile));
    },

    getCachedProviderModels: async (providerProfileId) => {
      const models = await providers.getCachedModels(providerProfileId);
      if (!models || models.length === 0) return null;
      return {
        models: models.map((m) => ({
          id: m.modelSlug,
          label: m.modelName,
          ...(m.contextLength != null ? { contextLength: m.contextLength } : {}),
          ...(m.capabilities ? { capabilities: m.capabilities } : {}),
        })),
        cachedAt: models[0]?.fetchedAt ?? new Date().toISOString(),
      };
    },

    setCachedProviderModels: async (providerProfileId, models) => {
      await providers.saveCachedModels(providerProfileId, models.map((m) => ({
        modelSlug: m.id,
        modelName: m.label,
        contextLength: m.contextLength,
        capabilities: m.capabilities,
      })));
      return {
        models,
        cachedAt: new Date().toISOString(),
      };
    },

    listFavoriteProviderModels: async (providerProfileId) => {
      const profile = await providers.getById(providerProfileId);
      if (!profile) {
        throw notFound("ProviderProfile", `Provider profile '${providerProfileId}' was not found.`);
      }
      const favorites = await providers.listFavoriteModels(providerProfileId);
      return favorites.map((favorite) => ({
        id: favorite.id,
        providerProfileId: favorite.providerProfileId,
        modelId: favorite.modelId,
        label: favorite.label,
        contextLength: favorite.contextLength,
        createdAt: favorite.createdAt,
      }));
    },

    addFavoriteProviderModel: async (providerProfileId, model) => {
      const profile = await providers.getById(providerProfileId);
      if (!profile) {
        throw notFound("ProviderProfile", `Provider profile '${providerProfileId}' was not found.`);
      }
      const saved = await providers.addFavoriteModel(providerProfileId, model);
      return {
        id: saved.id,
        providerProfileId: saved.providerProfileId,
        modelId: saved.modelId,
        label: saved.label,
        contextLength: saved.contextLength,
        createdAt: saved.createdAt,
      };
    },

    removeFavoriteProviderModel: async (providerProfileId, modelId) => {
      const profile = await providers.getById(providerProfileId);
      if (!profile) {
        throw notFound("ProviderProfile", `Provider profile '${providerProfileId}' was not found.`);
      }
      await providers.removeFavoriteModel(providerProfileId, modelId);
    },
  };
}
