import { z } from "zod";

export const testProviderDraftSchema = z.object({
  endpoint: z.string().optional(),
  apiKey: z.string().optional(),
  providerType: z.string().optional(),
});

const providerCoreSchema = z.object({
  name: z.string().min(1),
  type: z.string(),
  endpoint: z.string(),
  apiKey: z.string().nullable().optional(),
  defaultModel: z.string().nullable().optional(),
  contextBudget: z.number().nullable().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  minP: z.number().optional(),
  topK: z.number().optional(),
  typicalP: z.number().optional(),
  repPen: z.number().optional(),
  freqPen: z.number().optional(),
  presPen: z.number().optional(),
  maxTokens: z.number().optional(),
  stopSeq: z.string().optional(),
  seed: z.string().nullable().optional(),
  reasoningEffort: z.string().optional(),
  streamResponse: z.boolean().optional(),
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
