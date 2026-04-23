import { listProviderModels } from "../prototype-provider-gateway.js";
import { ProviderAdapter, ProviderProfile, ConnectionResult, ModelInfo } from "./types.js";

export class OpenAICompatAdapter implements ProviderAdapter {
  type = "openai_compat" as const;

  async testConnection(profile: Omit<ProviderProfile, 'type'>): Promise<ConnectionResult> {
    try {
      const modelsList = await listProviderModels({
        apiKey: profile.api_key ?? "",
        baseUrl: profile.endpoint,
      });
      const normalizedModels: ModelInfo[] = modelsList.map((model) => ({
        id: model.id,
        name: model.label,
      }));
      return {
        success: true,
        models: normalizedModels,
      };

    } catch (error: any) {
      return {
        success: false,
        models: [],
        error: error.message || "Failed to connect to provider.",
      };
    }
  }
}
