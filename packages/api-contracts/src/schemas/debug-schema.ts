import { z } from "zod";

export const debugSendLogSchema = z.any();

export const importJsonSchema = z.object({
  fileName: z.string(),
  jsonText: z.string(),
  chatId: z.string().optional(),
  skipExisting: z.boolean().optional(),
});
