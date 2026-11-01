import { z } from "zod";

/** The route knows the operation/target; only the producer owns run/branch
 * identity. Never reconstruct either from the currently selected chat history. */
export const chatGenerationOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("send"), messageId: z.null() }),
  z.object({ operation: z.literal("generate"), messageId: z.null() }),
  z.object({ operation: z.literal("regenerate"), messageId: z.string().min(1) }),
  z.object({ operation: z.literal("continue"), messageId: z.string().min(1) }),
]);
export type ChatGenerationOperation = z.infer<typeof chatGenerationOperationSchema>;

/** First numbered frame, retained together with the exact run's deltas. */
export const chatGenerationContextSchema = z.intersection(chatGenerationOperationSchema, z.object({
  runId: z.string().min(1),
  chatId: z.string().min(1),
  branchId: z.string().min(1),
}));
export type ChatGenerationContext = z.infer<typeof chatGenerationContextSchema>;
