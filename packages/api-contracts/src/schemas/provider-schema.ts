import { z } from "zod";

export const testProviderDraftSchema = z.object({
  endpoint: z.string().optional(),
  apiKey: z.string().optional(),
  providerType: z.string().optional(),
});

const providerCoreSchema = z.object({
  name: z.string().min(1),
  providerPreset: z.string(),
  endpoint: z.string(),
  apiKey: z.string().nullable().optional(),
  defaultModel: z.string().nullable().optional(),
  contextBudget: z.number().nullable().optional(),
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().optional(),
  minP: z.number().optional(),
  topA: z.number().optional(),
  typicalP: z.number().optional(),
  tfsZ: z.number().optional(),
  repeatLastN: z.number().optional(),
  mirostat: z.number().optional(),
  mirostatTau: z.number().optional(),
  mirostatEta: z.number().optional(),
  dryMultiplier: z.number().optional(),
  dryBase: z.number().optional(),
  dryAllowedLength: z.number().optional(),
  drySequenceBreakers: z.array(z.string()).optional(),
  xtcThreshold: z.number().optional(),
  xtcProbability: z.number().optional(),
  frequencyPenalty: z.number().optional(),
  presencePenalty: z.number().optional(),
  repetitionPenalty: z.number().optional(),
  stopSequences: z.array(z.string()).optional(),
  logitBias: z.array(z.object({
    tokenId: z.number().int(),
    bias: z.number().min(-100).max(100),
    text: z.string().optional(),
    sourceText: z.string().optional(),
    model: z.string().optional(),
  })).optional(),
  seed: z.string().nullable().optional(),
  reasoningEffort: z.string().optional(),
  showReasoning: z.boolean().optional(),
  streamResponse: z.boolean().optional(),
  customSamplers: z.boolean().optional(),
});

export const saveProviderDraftSchema = providerCoreSchema.extend({
  id: z.string().optional(),
});

export const updateProviderProfileSchema = providerCoreSchema.partial();

export const favoriteProviderModelSchema = z.object({
  modelId: z.string().min(1),
  label: z.string().nullable().optional(),
  contextLength: z.number().int().nullable().optional(),
});

export const fetchModelsSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  providerType: z.string().optional(),
});

export const testChatSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  providerType: z.string().optional(),
});

export const testChatProfileSchema = z.object({
  model: z.string(),
});

export const tokenizeSchema = z.object({
  text: z.string().min(1),
  model: z.string().optional(),
});
