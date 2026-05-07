import type { StoredProviderProfileRecord } from "./session-runtime-dto.js";
import type { ProviderProfileService } from "./provider-profile-service.js";
import { providerProfileToStoredRecord } from "./session-runtime-dto.js";
import type { ProviderProfile } from "@rp-platform/db";
import { listProviderModels } from "./provider-gateway.js";
import { logSendDebug } from "./send-debug-log.js";

export class ProviderOrchestrator {
  constructor(
    private readonly providerProfileService: ProviderProfileService,
  ) {}

  async refreshProfileModels(profile: StoredProviderProfileRecord): Promise<Array<{ id: string; label: string }>> {
    try {
      const models = await listProviderModels({
        baseUrl: profile.endpoint,
        apiKey: profile.apiKey ?? "",
        providerType: profile.type,
      });
      const normalized = models.map((model) => ({
        id: model.id,
        label: model.label ?? model.id,
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
