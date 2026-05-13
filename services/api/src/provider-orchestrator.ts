import type { StoredProviderProfileRecord } from "@rp-platform/domain";
import type { ProviderProfileService } from "./provider-profile-service.js";
import { listProviderModels } from "./provider-gateway.js";
import { normalizeProviderType } from "./ai/provider-profile-mapper.js";
import { logSendDebug } from "./send-debug-log.js";

const PROVIDER_TYPES_REQUIRING_AUTH_FOR_MODELS = new Set(["anthropic", "google"]);

export class ProviderOrchestrator {
  constructor(
    private readonly providerProfileService: ProviderProfileService,
  ) {}

  async refreshProfileModels(profile: StoredProviderProfileRecord): Promise<Array<{ id: string; label: string; contextLength?: number }>> {
    const providerType = normalizeProviderType(profile.providerPreset);
    try {
      const models = await listProviderModels({
        baseUrl: profile.endpoint,
        apiKey: profile.apiKey ?? "",
        providerType,
        requiresAuthForModels: PROVIDER_TYPES_REQUIRING_AUTH_FOR_MODELS.has(providerType),
      });
      const normalized = models.map((model) => ({
        id: model.id,
        label: model.label ?? model.id,
        ...(model.contextLength != null ? { contextLength: model.contextLength } : {}),
        ...(model.capabilities ? { capabilities: {
          thinking: model.capabilities.reasoning,
          tools: model.capabilities.tools,
          vision: model.capabilities.vision,
        } } : {}),
      }));

      await this.providerProfileService.setCachedProviderModels(profile.id, normalized);
      return normalized;
    } catch (error) {
      const cached = await this.providerProfileService.getCachedProviderModels(profile.id);
      if (cached?.models.length) {
        return cached.models;
      }

      const fallbackModel = profile.defaultModel?.trim();
      if (fallbackModel) {
        const fallback = [{ id: fallbackModel, label: fallbackModel }];
        await this.providerProfileService.setCachedProviderModels(profile.id, fallback);
        return fallback;
      }

      throw error;
    }
  }
}
