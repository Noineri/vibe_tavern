import { ProviderProfile, ConnectionResult, ProviderAdapter, ProviderType } from './types.js';
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
}
