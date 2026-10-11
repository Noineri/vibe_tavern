import { AGENT_PLAN_TASK_STATUS } from "@vibe-tavern/domain";
import { z } from "zod";

/** One persisted, model-maintained step in an agent plan. */
export const agentPlanTaskSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    body: z.string(),
    status: z.enum(Object.values(AGENT_PLAN_TASK_STATUS)),
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
