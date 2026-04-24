import type { AssemblePromptResponse } from "@rp-platform/api-contracts";

export type ProviderType = 'openai_compat' | 'anthropic' | 'google' | 'cohere';

export interface ProviderProfile {
  id: string;
  name: string;
  type: ProviderType;
  endpoint: string;
  api_key: string;
  default_model: string | null;
  context_budget: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  context_length?: number;
  owned_by?: string;
}

export interface ProviderAdapter {
  type: ProviderType;
  listModels(profile: Omit<ProviderProfile, "type">): Promise<ModelInfo[]>;
  generateReply(
    profile: Omit<ProviderProfile, "type">,
    input: {
      model: string;
      prompt: AssemblePromptResponse;
    },
  ): Promise<string>;
}
