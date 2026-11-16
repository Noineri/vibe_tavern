import { AGENT_PLAN_TASK_STATUS, STORY_DAY_PART } from "@vibe-tavern/domain";
import { z } from "zod";

/**
 * The optional story-time stamp on a task (DK-1). Wire design: a STRICT
 * mirror of the domain validity rule (`isStoryEventTime`) — `day` an integer
 * >= 1, `part` one of the four day parts or null, no extra keys. The field
 * itself is optional (absence = undated). Deliberately stricter than
 * `normalizeAgentPlan`: the wire rejects a payload carrying a malformed `at`
 * outright (bad data never persists), while the domain normalizer tolerates
 * one on the read path by dropping just the stamp and keeping the task.
 */
const storyEventTimeSchema = z
  .object({
    day: z.number().int().min(1),
    part: z.enum(Object.values(STORY_DAY_PART)).nullable(),
  })
  .strict();

/** One persisted, model-maintained step in an agent plan. */
export const agentPlanTaskSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    body: z.string(),
    status: z.enum(Object.values(AGENT_PLAN_TASK_STATUS)),
    at: storyEventTimeSchema.optional(),
  })
  .strict();
export type AgentPlanTask = z.infer<typeof agentPlanTaskSchema>;

/** The full script-owned plan maintained through the plan tool. */
export const agentPlanSchema = z
  .object({
    goal: z.string(),
    constraints: z.array(z.string()),
    tasks: z.array(agentPlanTaskSchema),
  })
  .strict();
export type AgentPlan = z.infer<typeof agentPlanSchema>;
