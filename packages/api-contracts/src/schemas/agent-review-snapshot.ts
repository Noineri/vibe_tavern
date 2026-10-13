import { z } from "zod";

export const reviewHunkCountsSchema = z.object({
  accepted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
});
export type ReviewHunkCounts = z.infer<typeof reviewHunkCountsSchema>;

export const reviewOutcomeSchema = z.enum([
  "awaiting",
  "applied",
  "applied-partial",
  "rejected",
  "cancelled",
  "superseded",
]);
export type ReviewOutcome = z.infer<typeof reviewOutcomeSchema>;

const reviewRoundIdSchema = z.string().regex(/^[a-f\d]{1,16}$/i);

export const reviewTargetRecordSchema = z.object({
  target: z.enum(["rules", "visual", "card", "lore", "tracker_template"]),
  roundId: reviewRoundIdSchema,
  outcome: reviewOutcomeSchema,
  hunks: reviewHunkCountsSchema.optional(),
  items: z.object({
    offered: z.number().int().nonnegative(),
    selected: z.number().int().nonnegative(),
    applied: z.number().int().nonnegative(),
  }).optional(),
  selected: z.boolean().optional(),
  supersededByRound: reviewRoundIdSchema.optional(),
});
export type ReviewTargetRecord = z.infer<typeof reviewTargetRecordSchema>;

export const agentReviewSnapshotSchema = z.object({
  targets: z.array(reviewTargetRecordSchema),
});
export type AgentReviewSnapshot = z.infer<typeof agentReviewSnapshotSchema>;
