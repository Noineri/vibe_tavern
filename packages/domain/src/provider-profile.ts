/**
 * Canonical provider profile type — single source of truth.
 *
 * Matches ProviderStore.ProviderProfile from @rp-platform/db exactly.
 * All layers (DB, services, AI executors, client) use this type directly.
 * No adapters or field renames between layers.
 *
 * Client-facing code should derive via:
 *   ClientProviderProfile = Omit<StoredProviderProfileRecord, 'apiKey'> & { hasStoredApiKey: boolean }
 */
export interface StoredProviderProfileRecord {
  id: string;
  name: string;
  providerPreset: string;
  endpoint: string;
  apiKey: string | null;
  defaultModel: string | null;
  contextBudget: number | null;
  maxTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  topA: number;
  frequencyPenalty: number;
  presencePenalty: number;
  repetitionPenalty: number;
  stopSequences: string[];
  seed: string | null;
  reasoningEffort: string;
  streamResponse: boolean;
  customSamplers: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
