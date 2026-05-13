import type { ProviderStore } from "@rp-platform/db";
import type { StoredProviderProfileRecord } from "@rp-platform/domain";
import {
  listProviderProfiles,
  saveProviderProfile,
  deleteProviderProfile,
  activateProviderProfile,
  resolveActiveProviderProfile,
  updateProviderProfile,
  getProviderProfile,
  getProviderProfileForClient,
  getCachedProviderModels,
  setCachedProviderModels,
  listFavoriteProviderModels,
  addFavoriteProviderModel,
  removeFavoriteProviderModel,
  type ProviderModuleDeps,
} from "./session-runtime-provider.js";
import type {
  ClientProviderProfileRecord,
  CachedProviderModelsRecord,
  FavoriteProviderModelRecord,
} from "./session-runtime-dto.js";

/**
 * Provider kind capability metadata for future AI SDK migration.
 * Values reflect current behavior conservatively.
 */
export interface ProviderCapabilityFlags {
  supportsAbortSignal: boolean;
  supportsPrefill: boolean;
  supportsStreaming: boolean;
}

const DEFAULT_CAPABILITIES: ProviderCapabilityFlags = {
  supportsAbortSignal: true,
  supportsPrefill: false,
  supportsStreaming: false,
};

export class ProviderProfileService {
  constructor(private readonly providers: ProviderStore) {}

  private get deps(): ProviderModuleDeps {
    return { providers: this.providers };
  }

  async listProviderProfiles(): Promise<ClientProviderProfileRecord[]> {
    return listProviderProfiles(this.deps);
  }

  async saveProviderProfile(profile: Partial<StoredProviderProfileRecord>): Promise<ClientProviderProfileRecord> {
    return saveProviderProfile(this.deps, profile);
  }

  async deleteProviderProfile(id: string): Promise<void> {
    return deleteProviderProfile(this.deps, id);
  }

  async activateProviderProfile(id: string): Promise<ClientProviderProfileRecord> {
    return activateProviderProfile(this.deps, id);
  }

  async resolveActiveProviderProfile(): Promise<StoredProviderProfileRecord | null> {
    return resolveActiveProviderProfile(this.deps);
  }

  async updateProviderProfile(
    id: string,
    patch: Partial<Omit<StoredProviderProfileRecord, 'id' | 'isActive' | 'createdAt' | 'updatedAt'>>,
  ): Promise<ClientProviderProfileRecord> {
    return updateProviderProfile(this.deps, id, patch);
  }

  async getProviderProfile(id: string): Promise<StoredProviderProfileRecord | null> {
    return getProviderProfile(this.deps, id);
  }

  async getProviderProfileForClient(id: string): Promise<ClientProviderProfileRecord | null> {
    return getProviderProfileForClient(this.deps, id);
  }

  async getCachedProviderModels(providerProfileId: string): Promise<CachedProviderModelsRecord | null> {
    return getCachedProviderModels(this.deps, providerProfileId);
  }

  async setCachedProviderModels(
    providerProfileId: string,
    models: Array<{ id: string; label: string }>,
  ): Promise<CachedProviderModelsRecord> {
    return setCachedProviderModels(this.deps, providerProfileId, models);
  }

  async listFavoriteProviderModels(providerProfileId: string): Promise<FavoriteProviderModelRecord[]> {
    return listFavoriteProviderModels(this.deps, providerProfileId);
  }

  async addFavoriteProviderModel(
    providerProfileId: string,
    model: { modelId: string; label?: string | null; contextLength?: number | null },
  ): Promise<FavoriteProviderModelRecord> {
    return addFavoriteProviderModel(this.deps, providerProfileId, model);
  }

  async removeFavoriteProviderModel(providerProfileId: string, modelId: string): Promise<void> {
    return removeFavoriteProviderModel(this.deps, providerProfileId, modelId);
  }

  /**
   * Returns conservative capability flags for a provider kind.
   * FW-AI briefs will replace this with real adapter capability queries.
   */
  getProviderCapabilities(_providerType: string): ProviderCapabilityFlags {
    void _providerType;
    return DEFAULT_CAPABILITIES;
  }
}
