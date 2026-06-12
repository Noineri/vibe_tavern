import type { ProviderProfileRecord, FavoriteProviderModelRecord, ProviderModelOption, TestChatResponse } from "./types.js";
import type { ProviderProbeResponse } from "@vibe-tavern/domain";
import { client } from "./client.js";
import { unwrapRpc } from "./unwrap.js";

export async function listProviderProfiles(): Promise<ProviderProfileRecord[]> {
  const response = await client.api.providers.$get();
  return unwrapRpc<ProviderProfileRecord[]>(response);
}

export async function fetchProviderProfile(providerProfileId: string): Promise<ProviderProfileRecord> {
  const response = await client.api.providers[":providerId"].$get({ param: { providerId: providerProfileId } });
  return unwrapRpc<ProviderProfileRecord>(response);
}

export async function saveProviderProfile(input: {
  id?: string;
  name: string;
  providerPreset: string;
  endpoint: string;
  apiKey?: string | null;
  defaultModel?: string | null;
  visionModel?: string | null;
  contextBudget?: number | null;
  pinContextBudget?: boolean;
  temperature?: number;
  topP?: number;
  minP?: number;
  topK?: number;
  topA?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  repetitionPenalty?: number;
  maxTokens?: number;
  stopSequences?: string[];
  logitBias?: Array<{ tokenId: number; bias: number; text?: string; sourceText?: string; model?: string }>;
  seed?: string | null;
  reasoningEffort?: string;
  showReasoning?: boolean;
  streamResponse?: boolean;
  customSamplers?: boolean;
}): Promise<ProviderProfileRecord> {
  const response = await client.api.providers.$post({ json: input });
  return unwrapRpc<ProviderProfileRecord>(response);
}

export async function updateProviderProfile(
  providerProfileId: string,
  patch: {
    name?: string;
    providerPreset?: string;
    endpoint?: string;
    apiKey?: string | null;
    defaultModel?: string | null;
    visionModel?: string | null;
    contextBudget?: number | null;
    pinContextBudget?: boolean;
    temperature?: number;
    topP?: number;
    minP?: number;
    topK?: number;
    topA?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    repetitionPenalty?: number;
    maxTokens?: number;
    stopSequences?: string[];
    logitBias?: Array<{ tokenId: number; bias: number; text?: string; sourceText?: string; model?: string }>;
    seed?: string | null;
    reasoningEffort?: string;
    showReasoning?: boolean;
    streamResponse?: boolean;
    customSamplers?: boolean;
  },
): Promise<ProviderProfileRecord> {
  const response = await client.api.providers[":providerId"].$patch({ param: { providerId: providerProfileId }, json: patch });
  return unwrapRpc<ProviderProfileRecord>(response);
}

export async function deleteProviderProfile(providerProfileId: string): Promise<{ ok: true }> {
  const response = await client.api.providers[":providerId"].$delete({ param: { providerId: providerProfileId } });
  return unwrapRpc<{ ok: true }>(response);
}

export async function activateProviderProfile(providerProfileId: string): Promise<ProviderProfileRecord> {
  const response = await client.api.providers[":providerId"].activate.$post({ param: { providerId: providerProfileId } });
  return unwrapRpc<ProviderProfileRecord>(response);
}

export async function testProviderDraft(input: { endpoint: string; apiKey: string; providerType?: string }): Promise<ProviderProbeResponse> {
  const response = await client.api.providers.test.$post({ json: input });
  return unwrapRpc<ProviderProbeResponse>(response);
}

export async function testProviderProfile(providerProfileId: string): Promise<ProviderProbeResponse> {
  const response = await client.api.providers[":providerId"].test.$post({ param: { providerId: providerProfileId } });
  return unwrapRpc<ProviderProbeResponse>(response);
}

export async function fetchProviderProfileModels(providerProfileId: string): Promise<{ models: ProviderModelOption[] }> {
  const response = await client.api.providers[":providerId"].models.$post({ param: { providerId: providerProfileId } });
  return unwrapRpc<{ models: ProviderModelOption[] }>(response);
}

export async function listFavoriteProviderModels(providerProfileId: string): Promise<FavoriteProviderModelRecord[]> {
  const response = await client.api.providers[":providerId"]["model-favorites"].$get({ param: { providerId: providerProfileId } });
  return unwrapRpc<FavoriteProviderModelRecord[]>(response);
}

export async function addFavoriteProviderModel(
  providerProfileId: string,
  model: { modelId: string; label?: string | null; contextLength?: number | null },
): Promise<FavoriteProviderModelRecord> {
  const response = await client.api.providers[":providerId"]["model-favorites"].$post({ param: { providerId: providerProfileId }, json: model });
  return unwrapRpc<FavoriteProviderModelRecord>(response);
}

export async function removeFavoriteProviderModel(providerProfileId: string, modelId: string): Promise<{ ok: true }> {
  const response = await client.api.providers[":providerId"]["model-favorites"].$delete({ param: { providerId: providerProfileId }, json: { modelId } });
  return unwrapRpc<{ ok: true }>(response);
}

export async function fetchModelsByEndpoint(baseUrl: string, apiKey?: string, providerType?: string): Promise<{ models: ProviderModelOption[] }> {
  const response = await client.api.providers["fetch-models"].$post({ json: { baseUrl, apiKey: apiKey ?? "", providerType } });
  return unwrapRpc<{ models: ProviderModelOption[] }>(response);
}

export async function testProviderChat(baseUrl: string, apiKey: string, model: string, providerType?: string): Promise<TestChatResponse> {
  const response = await client.api.providers["test-chat"].$post({ json: { baseUrl, apiKey, model, providerType } });
  return unwrapRpc<TestChatResponse>(response);
}

export async function testProfileChat(providerProfileId: string, model: string): Promise<TestChatResponse> {
  const response = await client.api.providers[":providerId"]["test-chat"].$post({ param: { providerId: providerProfileId }, json: { model } });
  return unwrapRpc<TestChatResponse>(response);
}
