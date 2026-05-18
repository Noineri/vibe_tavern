import { z } from "zod";

export const summarizeChatSchema = z.object({
  providerProfileId: z.string().min(1),
  model: z.string().trim().optional(),
  maxMessages: z.number().int().min(1),
});

export const saveChatSummarySchema = z.object({
  summary: z.string(),
});
