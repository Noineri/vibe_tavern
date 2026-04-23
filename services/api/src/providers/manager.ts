import type { AssemblePromptResponse } from "@rp-platform/api-contracts";
import { ProviderProfile, ConnectionResult, ProviderAdapter, ProviderType, ModelInfo } from './types.js';
import { OpenAICompatAdapter } from './openai.js';

export class ProviderManager {
  private adapters: Map<ProviderType, ProviderAdapter> = new Map();

  constructor() {
    this.registerAdapter(new OpenAICompatAdapter());
    // Anthropic and others will be registered here
  }

  registerAdapter(adapter: ProviderAdapter) {
    this.adapters.set(adapter.type, adapter);
  }

  /**
   * Performs a fast connection test and model fetch for a given profile.
   */
  async testProfileConnection(profile: ProviderProfile): Promise<ConnectionResult> {
    const adapter = this.adapters.get(profile.type);

    if (!adapter) {
      return {
        success: false,
        models: [],
        error: `Unsupported provider type: ${profile.type}`,
      };
    }

    return await adapter.testConnection(profile);
  }

  async listModels(profile: ProviderProfile): Promise<ModelInfo[]> {
    const adapter = this.adapters.get(profile.type);

    if (!adapter) {
      throw new Error(`Unsupported provider type: ${profile.type}`);
    }

    return adapter.listModels(profile);
  }

  async generateReply(
    profile: ProviderProfile,
    input: {
      model: string;
      prompt: AssemblePromptResponse;
    },
  ): Promise<string> {
    const adapter = this.adapters.get(profile.type);

    if (!adapter) {
      throw new Error(`Unsupported provider type: ${profile.type}`);
    }

    return adapter.generateReply(profile, input);
  }
}
