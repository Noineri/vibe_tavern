import { z } from "zod";
import { copilotTodoItemSchema, experienceCopilotTargetSchema } from "./experience-copilot-schema.js";
import { isPersistableAgentReviewActivity } from "../agent-review-round.js";

export const agentToolStatusSchema = z.enum(["streaming", "done", "error"]);
export type AgentToolStatus = z.infer<typeof agentToolStatusSchema>;

/** Full rewritten session checklist projected onto a tool activity card. */
export const agentTodoActivityResultSchema = z.object({
  items: z.array(copilotTodoItemSchema).readonly(),
  remaining: z.number(),
  activeTitle: z.string().optional(),
});
export type AgentTodoActivityResult = z.infer<typeof agentTodoActivityResultSchema>;

/** Question text comes from the carrier call; resolved results carry the answer. */
export const agentAskStateSchema = z.object({
  question: z.string(),
  options: z.array(z.string()).readonly().optional(),
  recommended: z.string().optional(),
  status: z.enum(["awaiting_answer", "answered", "skipped"]),
  answer: z.string().optional(),
});
export type AgentAskState = z.infer<typeof agentAskStateSchema>;

/**
 * Permission-card material is carried in the activity, not fetched by the UI.
 *
 * DMT-11: `kind` distinguishes the two permission families — `"prompt_read"`
 * (the legacy `read_message_prompt` request) and `"swipe"` (the Director's
 * `request_message_swipe`). OPTIONAL so legacy persisted activities (every
 * pre-DMT-11 row is a prompt read) still parse unchanged; producers set it
 * through the ONE decoder (`agent-permission-state.ts`), which derives it from
 * the TOOL NAME — never from payload fields, so a client-sent `instruction`
 * cannot turn a prompt read into a swipe. The remaining new fields carry the
 * swipe family's material: the frozen target identity (`messageId`/
 * `variantId`) and the instruction (`instruction` — the PROPOSED draft while
 * awaiting, the FINAL user-approved text once granted). The prompt-read
 * decoder simply never reads those fields, so its states are unchanged.
 */
export const agentPermissionStateSchema = z.object({
  status: z.enum(["awaiting_permission", "granted", "denied"]),
  kind: z.enum(["prompt_read", "swipe"]).optional(),
  position: z.number().optional(),
  variantNumber: z.number().optional(),
  replyFirstLine: z.string().optional(),
  promptTokens: z.number().optional(),
  presetName: z.string().optional(),
  messageId: z.string().optional(),
  variantId: z.string().optional(),
  instruction: z.string().optional(),
});
export type AgentPermissionState = z.infer<typeof agentPermissionStateSchema>;

/** One accumulated tool call, shared by live turn state and persisted review.
 * args is the opaque operation input (SEARCH/REPLACE or whole-buffer content).
 * Only finalized proposal producers enter a review envelope below. */
export const agentToolActivitySchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  status: agentToolStatusSchema,
  args: z.unknown().optional(),
  summary: z.string().optional(),
  target: experienceCopilotTargetSchema.optional(),
  proposed: z.string().optional(),
  readPath: z.string().optional(),
  todo: agentTodoActivityResultSchema.optional(),
  ask: agentAskStateSchema.optional(),
  permission: agentPermissionStateSchema.optional(),
});
export type AgentToolActivity = z.infer<typeof agentToolActivitySchema>;

/** Persist finalized rules/visual or code proposals, never streaming/errors or
 * read-only activities. Each kind's producer/adapter selects its own targets.
 * Keep the activity's structural type so existing live-store callers do not
 * need casts or a second handwritten projection at the persistence boundary. */
export const agentReviewActivitySchema = agentToolActivitySchema.refine(
  (activity): boolean => isPersistableAgentReviewActivity(activity),
  { message: "A review activity must be a finalized buffer proposal." },
);

/** Turn-start buffers, oldest snapshot first; id is monotonic per thread. */
export const agentReviewBufferSnapshotSchema = z.object({
  id: z.number(),
  rules: z.string(),
  visual: z.string(),
});
export type AgentReviewBufferSnapshot = z.infer<typeof agentReviewBufferSnapshotSchema>;

/** CD-8 pending proposal frozen before a new send clears the live activities. */
export const agentDanglingCaptureSchema = z.object({
  rules: z.string().optional(),
  visual: z.string().optional(),
  baseRules: z.string(),
  baseVisual: z.string(),
});
export type AgentDanglingCapture = z.infer<typeof agentDanglingCaptureSchema>;

/** Serializable round state: arrays (not Sets) preserve selected hunk ids,
 * including too-large sentinel ids. Review keys retain their literal NULs. */
export const agentReviewRoundSchema = z.object({
  snapshots: z.array(agentReviewBufferSnapshotSchema),
  nextSnapshotId: z.number(),
  acceptedRules: z.array(z.number().int()),
  acceptedVisual: z.array(z.number().int()),
  dismissedRules: z.array(z.number().int()),
  dismissedVisual: z.array(z.number().int()),
  rulesKey: z.string().nullable(),
  visualKey: z.string().nullable(),
  dangling: agentDanglingCaptureSchema.nullable(),
});
export type AgentReviewRound = z.infer<typeof agentReviewRoundSchema>;

/** V2 persistence/API contract. Legacy V1 migration remains a client concern;
 * the server never accepts an unanchored V1 envelope as if it were V2. */
export const agentReviewEnvelopeSchema = z.object({
  _v: z.literal(2),
  activities: z.array(agentReviewActivitySchema),
  round: agentReviewRoundSchema.nullable(),
}).strict();
export type AgentReviewEnvelope = z.infer<typeof agentReviewEnvelopeSchema>;
