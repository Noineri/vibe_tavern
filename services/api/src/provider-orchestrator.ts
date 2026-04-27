import type { AssemblePromptResponse } from "@rp-platform/api-contracts";
import type { ProviderManager } from "./providers/manager.js";
import type { SessionRuntime } from "./session-runtime.js";

type SupportedProviderType = "openai_compat" | "anthropic" | "google" | "cohere";

interface StoredProviderProfileRecord {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  apiKey: string | null;
  defaultModel?: string | null;
  contextBudget?: number | null;
}

export class ProviderOrchestrator {
  constructor(
    private readonly runtime: SessionRuntime,
    private readonly providerManager: ProviderManager,
  ) {}

  async refreshProfileModels(profile: StoredProviderProfileRecord): Promise<Array<{ id: string; label: string }>> {
    try {
      const models = await this.providerManager.listModels(this.toManagerProfile(profile));
      const normalized = models.map((model) => ({
        id: model.id,
        label: model.name ?? model.id,
      }));

      this.runtime.setCachedProviderModels(profile.id, normalized);
      return normalized;
    } catch (error) {
      const cached = this.runtime.getCachedProviderModels(profile.id);
      if (cached?.models.length) {
        return cached.models;
      }

      const fallbackModel = profile.defaultModel?.trim();
      if (fallbackModel) {
        const fallback = [{ id: fallbackModel, label: fallbackModel }];
        this.runtime.setCachedProviderModels(profile.id, fallback);
        return fallback;
      }

      throw error;
    }
  }

  async generateProfileReply(
    profile: StoredProviderProfileRecord,
    input: {
      model: string;
      prompt: AssemblePromptResponse;
    },
  ): Promise<string> {
    return this.providerManager.generateReply(this.toManagerProfile(profile), input);
  }

  private toManagerProfile(profile: StoredProviderProfileRecord) {
    return {
      id: profile.id,
      name: profile.name,
      type: profile.type as SupportedProviderType,
      endpoint: profile.endpoint,
      api_key: profile.apiKey ?? "",
      default_model: profile.defaultModel ?? null,
      context_budget: profile.contextBudget ?? 8192,
    };
  }
}
