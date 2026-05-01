export interface StoredProviderProfileRecord {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  apiKey: string | null;
  defaultModel?: string | null;
  contextBudget?: number | null;
  temperature?: number;
  topP?: number;
  minP?: number;
  topK?: number;
  typicalP?: number;
  repPen?: number;
  freqPen?: number;
  presPen?: number;
  maxTokens?: number;
  stopSeq?: string;
  seed?: string | null;
  reasoningEffort?: string;
  streamResponse?: boolean;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}
