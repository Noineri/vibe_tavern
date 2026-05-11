import { z } from "zod";

export const summarizeChatSchema = z.object({
  providerProfileId: z.string().min(1),
  maxMessages: z.number().int().min(1).max(200),
});

export const saveChatSummarySchema = z.object({
  summary: z.string(),
});
