import { z } from "zod";

export const createCharacterSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  firstMessage: z.string().optional(),
  scenario: z.string().optional(),
  personalitySummary: z.string().nullable().optional(),
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
  avatarAssetId: z.string().nullable().optional(),
});

export const buildCharacterDraftSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  firstMessage: z.string(),
  mesExample: z.string(),
  scenario: z.string(),
  personalitySummary: z.string(),
  systemPrompt: z.string(),
  alternateGreetings: z.array(z.string()),
  postHistoryInstructions: z.string(),
  creatorNotes: z.string(),
  characterBook: z.string().nullable(),
  depthPrompt: z.string(),
  depthPromptDepth: z.number(),
  depthPromptRole: z.string(),
  extensions: z.string(),
  tags: z.array(z.string()),
});

export type BuildCharacterDraft = z.infer<typeof buildCharacterDraftSchema>;
