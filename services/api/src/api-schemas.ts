import { z } from "zod";

export const debugSendLogSchema = z.record(z.unknown());

export const createPersonaSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(""),
  pronouns: z.string().nullable().optional(),
  defaultForNewChats: z.boolean().optional(),
});

export const createCharacterSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  firstMessage: z.string().optional(),
  scenario: z.string().optional(),
  personalitySummary: z.string().nullable().optional(),
});

export const createChatSchema = z.object({
  characterId: z.string().optional(),
});

export const cloneChatSchema = z.record(z.unknown());

export const updateChatSettingsSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  scenario: z.string(),
  systemPrompt: z.string(),
});

export const sendMessageSchema = z.object({
  content: z.string(),
});

export const editMessageSchema = z.object({
  content: z.string().optional().default(""),
});

export const setPersonaSchema = z.object({
  personaId: z.string(),
});

export const setPromptPresetSchema = z.object({
  promptPresetId: z.string(),
});

export const renameChatSchema = z.object({
  title: z.string(),
});

export const updateCharacterSchema = z.object({
  chatId: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  scenario: z.string().optional(),
  systemPrompt: z.string().optional(),
  mesExample: z.string().nullable().optional(),
  alternateGreetings: z.array(z.string()).optional(),
  postHistoryInstructions: z.string().nullable().optional(),
  creatorNotes: z.string().nullable().optional(),
});

export const updatePersonaSchema = z.object({
  chatId: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
});

export const setPersonalLorebookSchema = z.object({
  enabled: z.boolean(),
});

export const updateLorebookSchema = z.object({
  chatId: z.string(),
  lorebookRaw: z.string(),
});

export const testActivationSchema = z.object({
  text: z.string(),
});

export const createLoreEntrySchema = z.record(z.unknown());

export const updateLoreEntrySchema = z.record(z.unknown());

export const testProviderDraftSchema = z.object({
  endpoint: z.string().optional(),
  apiKey: z.string().optional(),
});

export const importJsonSchema = z.object({
  fileName: z.string(),
  jsonText: z.string(),
  chatId: z.string().optional(),
});

export const saveProviderDraftSchema = z.record(z.unknown());

export const updateProviderProfileSchema = z.record(z.unknown());

export const fetchModelsSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
});

export const testChatSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
});

export const testChatProfileSchema = z.object({
  model: z.string(),
});

export const createPromptPresetSchema = z.record(z.unknown());

export const updatePromptPresetSchema = z.record(z.unknown());
