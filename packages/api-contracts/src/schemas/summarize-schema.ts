import { z } from "zod";

export const chatSummarySourceSchema = z.enum(["manual", "auto"]);

export const autoSummaryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  everyN: z.number().int().min(1).max(500).default(20),
  useChatModel: z.boolean().default(true),
  excludeSummarized: z.boolean().default(true),
  providerProfileId: z.string().trim().optional(),
  model: z.string().trim().optional(),
});

export const createChatSummarySchema = z.object({
  label: z.string().trim().optional().default(""),
  content: z.string().optional().default(""),
  summarizedFrom: z.number().int().min(1),
  summarizedTo: z.number().int().min(0),
  includeInContext: z.boolean().optional().default(true),
  excludeSummarized: z.boolean().optional().default(true),
  source: chatSummarySourceSchema.optional().default("manual"),
  sortOrder: z.number().int().optional(),
});

export const updateChatSummarySchema = z.object({
  label: z.string().trim().optional(),
  content: z.string().optional(),
  summarizedFrom: z.number().int().min(1).optional(),
  summarizedTo: z.number().int().min(0).optional(),
  includeInContext: z.boolean().optional(),
  excludeSummarized: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const generateChatSummarySchema = z.object({
  providerProfileId: z.string().min(1),
  model: z.string().trim().optional(),
  summarizedFrom: z.number().int().min(1),
  summarizedTo: z.number().int().min(1),
  targetSummaryId: z.string().trim().optional(),
  label: z.string().trim().optional(),
  includeInContext: z.boolean().optional().default(true),
  excludeSummarized: z.boolean().optional().default(true),
});

export const updateMemorySettingsSchema = z.object({
  messageHistoryLimit: z.number().int().min(0).optional(),
  autoSummaryConfig: autoSummaryConfigSchema.partial().optional(),
});

// Legacy endpoint schemas retained for backward compatibility during the Memory 1.0 migration.
export const summarizeChatSchema = z.object({
  providerProfileId: z.string().min(1),
  model: z.string().trim().optional(),
  maxMessages: z.number().int().min(1),
});

export const saveChatSummarySchema = z.object({
  summary: z.string(),
});
