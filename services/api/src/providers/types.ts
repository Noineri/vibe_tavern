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

export interface ConnectionResult {
  success: boolean;
  models: ModelInfo[];
  error?: string;
}

export interface ProviderAdapter {
  type: ProviderType;
  /**
   * Performs a fast health check and retrieves available models.
   * Should not block for more than a few seconds.
   */
  testConnection(profile: Omit<ProviderProfile, 'type'>): Promise<ConnectionResult>;
}
