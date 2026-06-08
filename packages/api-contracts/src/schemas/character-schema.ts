import { z } from "zod";

export const createCharacterSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  firstMessage: z.string().optional(),
  scenario: z.string().optional(),
  personalitySummary: z.string().nullable().optional(),
  mesExample: z.string().optional(),
  mesExampleMode: z.enum(["always", "once", "depth", "disabled"]).optional(),
  mesExampleDepth: z.number().optional(),
  alternateGreetings: z.array(z.string()).optional(),
  postHistoryInstructions: z.string().optional(),
  creatorNotes: z.string().optional(),
  systemPrompt: z.string().optional(),
  depthPrompt: z.string().optional(),
  depthPromptDepth: z.number().optional(),
  depthPromptRole: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const updateCharacterSchema = z.object({
  chatId: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  personalitySummary: z.string().nullable().optional(),
  scenario: z.string().optional(),
  systemPrompt: z.string().optional(),
  firstMessage: z.string().nullable().optional(),
  mesExample: z.string().nullable().optional(),
  mesExampleMode: z.enum(["always", "once", "depth", "disabled"]).optional(),
  mesExampleDepth: z.number().optional(),
  alternateGreetings: z.array(z.string()).optional(),
  postHistoryInstructions: z.string().nullable().optional(),
  creatorNotes: z.string().nullable().optional(),
  depthPrompt: z.string().nullable().optional(),
  depthPromptDepth: z.number().nullable().optional(),
  depthPromptRole: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  avatarAssetId: z.string().nullable().optional(),
  avatarFullAssetId: z.string().nullable().optional(),
  avatarCropJson: z.string().nullable().optional(),
});

export const buildCharacterDraftSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  firstMessage: z.string(),
  mesExample: z.string(),
  mesExampleMode: z.enum(["always", "once", "depth", "disabled"]),
  mesExampleDepth: z.number(),
  scenario: z.string(),
  personalitySummary: z.string(),
  systemPrompt: z.string(),
  alternateGreetings: z.array(z.string()),
  postHistoryInstructions: z.string(),
  creatorNotes: z.string(),
  depthPrompt: z.string(),
  depthPromptDepth: z.number(),
  depthPromptRole: z.string(),
  tags: z.array(z.string()),
});

export type BuildCharacterDraft = z.infer<typeof buildCharacterDraftSchema>;
