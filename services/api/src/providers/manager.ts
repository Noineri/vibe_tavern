import type { AssemblePromptResponse } from "@rp-platform/api-contracts";
import { ProviderProfile, ProviderAdapter, ProviderType, ModelInfo } from './types.js';
import { OpenAICompatAdapter } from './openai.js';
import { AnthropicAdapter } from './anthropic.js';
import { GoogleAdapter } from './google.js';

export class ProviderManager {
  private adapters: Map<ProviderType, ProviderAdapter> = new Map();

  constructor() {
    this.registerAdapter(new OpenAICompatAdapter());
    this.registerAdapter(new AnthropicAdapter());
    this.registerAdapter(new GoogleAdapter());
  }

  registerAdapter(adapter: ProviderAdapter) {
    this.adapters.set(adapter.type, adapter);
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
