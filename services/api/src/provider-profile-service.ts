import type { ChatSessionStore } from "@rp-platform/db";
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
  type ProviderModuleDeps,
} from "./session-runtime-provider.js";
import type {
  StoredProviderProfileRecord,
  ClientProviderProfileRecord,
  CachedProviderModelsRecord,
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
  private readonly providerModelsCache = new Map<string, CachedProviderModelsRecord>();

  constructor(private readonly store: ChatSessionStore) {}

  private get deps(): ProviderModuleDeps {
    return { store: this.store, providerModelsCache: this.providerModelsCache };
  }

  listProviderProfiles(): ClientProviderProfileRecord[] {
    return listProviderProfiles(this.deps);
  }

  async saveProviderProfile(profile: Partial<StoredProviderProfileRecord>): Promise<ClientProviderProfileRecord> {
    return saveProviderProfile(this.deps, profile);
  }

  deleteProviderProfile(id: string): void {
    deleteProviderProfile(this.deps, id);
  }

  activateProviderProfile(id: string): ClientProviderProfileRecord {
    return activateProviderProfile(this.deps, id);
  }

  resolveActiveProviderProfile(): StoredProviderProfileRecord | null {
    return resolveActiveProviderProfile(this.deps);
  }

  updateProviderProfile(
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
    return updateProviderProfile(this.deps, id, patch);
  }

  getProviderProfile(id: string): StoredProviderProfileRecord | null {
    return getProviderProfile(this.deps, id);
  }

  getProviderProfileForClient(id: string): ClientProviderProfileRecord | null {
    return getProviderProfileForClient(this.deps, id);
  }

  getCachedProviderModels(providerProfileId: string): CachedProviderModelsRecord | null {
    return getCachedProviderModels(this.deps, providerProfileId);
  }

  setCachedProviderModels(
    providerProfileId: string,
    models: Array<{ id: string; label: string }>,
  ): CachedProviderModelsRecord {
    return setCachedProviderModels(this.deps, providerProfileId, models);
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
