import type { AssemblePromptResponse } from "@rp-platform/api-contracts";

export type ProviderType = 'openai_compat' | 'anthropic' | 'google' | 'ollama' | 'llamacpp' | 'koboldcpp';

export interface ProviderProfile {
  id: string;
  name: string;
  type: ProviderType;
  endpoint: string;
  api_key: string;
  default_model: string | null;
  context_budget: number;
  maxTokens?: number | null;
  temperature?: number | null;
  topP?: number | null;
  minP?: number | null;
  topK?: number | null;
  typicalP?: number | null;
  repPen?: number | null;
  freqPen?: number | null;
  presPen?: number | null;
  stopSeq?: string | null;
  seed?: number | string | null;
  reasoningEffort?: string | null;
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
