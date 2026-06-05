import { z } from "zod";

const promptPresetCoreSchema = z.object({
  name: z.string(),
  bindModel: z.string().optional(),
  system: z.string().optional(),
  jailbreak: z.string().optional(),
  prefill: z.string().optional(),
  authorsNote: z.string().optional(),
  authorsNoteDepth: z.number().optional(),
  authorsNotePosition: z.enum(["in_prompt", "in_chat", "after_chat"]).optional(),
  summary: z.string().optional(),
  tools: z.string().optional(),
  nsfw: z.string().optional(),
  enhanceDefinitions: z.string().optional(),
  customInjections: z.array(z.unknown()).optional(),
  promptOrder: z.array(z.object({
    identifier: z.string(),
    enabled: z.boolean(),
    order: z.number().optional(),
    kind: z.enum(["built_in", "custom"]).optional(),
  })).optional(),
  advancedMode: z.boolean().optional(),
  scriptAiSystemPrompt: z.string().optional(),
  aiAssistantPrompts: z.string().optional(),
});

export const createPromptPresetSchema = promptPresetCoreSchema;

export const updatePromptPresetSchema = promptPresetCoreSchema.partial();

export const setPromptPresetSchema = z.object({
  promptPresetId: z.string(),
});
