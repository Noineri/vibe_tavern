import { z } from "zod";
import { CHAT_GENERATION_JOB_STATUSES } from "@vibe-tavern/domain";

/** QueueJob's existing web shape. Null DB result columns project to omitted
 * fields; enqueuedAt stays epoch milliseconds, not an ISO timestamp.
 * recordId is an optional UI timeline correlation, not a persisted FK. */
export const chatGenerationJobSchema = z.object({
  id: z.string().min(1),
  chatId: z.string().min(1),
  messageId: z.string().min(1),
  model: z.string().min(1),
  promptPresetId: z.string().min(1).nullable(),
  recordId: z.string().min(1).optional(),
  status: z.enum(CHAT_GENERATION_JOB_STATUSES),
  variantIndex: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  enqueuedAt: z.number().int().nonnegative(),
});
export type ChatGenerationJob = z.infer<typeof chatGenerationJobSchema>;
