import { z } from "zod";
import { coauthorTargetSchema, coauthorLoreBundleSchema, coauthorLoreBundleOutputSchema, coauthorToolOutputSchema, coauthorTrackerTemplateOutputSchema } from "./schemas/chat-schema.js";

/** CA-15's v1 shape, including the tracker proposal already supported by Apply.
 * Read-only tool cards and unfinished/failed activities are not review drafts. */
export const coauthorReviewActivitySchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.literal("done"),
  args: z.unknown().optional(),
  summary: z.string().optional(),
  target: coauthorTargetSchema.optional(),
  proposed: z.string().optional(),
  greetingIndex: z.number().int().nonnegative().optional(),
  isAdd: z.boolean().optional(),
  loreBundle: coauthorLoreBundleSchema.optional(),
  trackerTemplate: coauthorTrackerTemplateOutputSchema.shape.trackerTemplate.optional(),
}).refine((activity) => Boolean(
  ((activity.target === "profile" || activity.target === "greeting") && activity.proposed?.length)
  || activity.loreBundle || activity.trackerTemplate,
), { message: "A Co-Author review activity must be a finalized proposal." });
export type CoauthorReviewActivity = z.infer<typeof coauthorReviewActivitySchema>;

export const coauthorReviewEnvelopeSchema = z.object({
  _v: z.literal(1),
  activities: z.array(coauthorReviewActivitySchema).min(1),
}).strict();
export type CoauthorReviewEnvelope = z.infer<typeof coauthorReviewEnvelopeSchema>;

/** Later duplicate wins at its first insertion position, matching CA-15. */
export function buildCoauthorReviewEnvelope(activities: readonly unknown[]): CoauthorReviewEnvelope | null {
  const byId = new Map<string, CoauthorReviewActivity>();
  for (const candidate of activities) {
    const parsed = coauthorReviewActivitySchema.safeParse(candidate);
    if (parsed.success) byId.set(parsed.data.toolCallId, parsed.data);
  }
  return byId.size ? { _v: 1, activities: [...byId.values()] } : null;
}

/** Pure projection from native committed results, also used by the live-event
 * collector. The existing output schemas are authoritative; no tool-name list
 * duplicates the profile/greeting/lore producers. */
export function coauthorReviewActivityFromResult(input: {
  toolCallId: string; toolName: string; args?: unknown; result: unknown; isError?: boolean;
}): CoauthorReviewActivity | null {
  if (input.isError) return null;
  const base = { toolCallId: input.toolCallId, toolName: input.toolName === "edit_profile" ? "write_profile" : input.toolName, status: "done" as const,
    ...(input.args !== undefined ? { args: input.args } : {}) };
  const lore = coauthorLoreBundleOutputSchema.safeParse(input.result);
  const tracker = input.toolName === "set_tracker_template" ? coauthorTrackerTemplateOutputSchema.safeParse(input.result) : null;
  const text = coauthorToolOutputSchema.safeParse(input.result);
  const activity = lore.success ? { ...base, summary: lore.data.summary, loreBundle: lore.data.bundle }
    : tracker?.success ? { ...base, ...tracker.data }
    : text.success ? { ...base, ...text.data } : null;
  const parsed = coauthorReviewActivitySchema.safeParse(activity);
  return parsed.success ? parsed.data : null;
}
