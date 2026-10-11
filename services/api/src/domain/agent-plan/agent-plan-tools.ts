import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { agentPlanSchema } from "@vibe-tavern/api-contracts";
import { normalizeAgentPlan, type AgentPlan } from "@vibe-tavern/domain";

export interface AgentPlanToolResult {
  readonly ok: boolean;
  readonly activeTitle?: string;
  readonly remaining?: number;
  readonly error?: string;
}

/** Build the script-owned plan tools without depending on the copilot runtime. */
export function createAgentPlanTools(deps: {
  readonly load: () => Promise<AgentPlan | null>;
  readonly save: (plan: AgentPlan) => Promise<void>;
}): ToolSet {
  return {
    plan: tool({
      description:
        "Replace the full plan for this script. Send the complete {plan} object every time. At most one task may be active.",
      inputSchema: z.object({ plan: agentPlanSchema }),
      execute: async ({ plan }): Promise<AgentPlanToolResult> => {
        const normalized = normalizeAgentPlan(plan);
        if (normalized === null) {
          throw new Error("at most one task can be active");
        }
        try {
          await deps.save(normalized);
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        const activeTitle = normalized.tasks.find((task) => task.status === "active")?.title;
        const remaining = normalized.tasks.filter(
          (task) => task.status === "pending" || task.status === "active",
        ).length;
        return { ok: true, activeTitle, remaining };
      },
    }),
    read_plan: tool({
      description: "Read the full current plan for this script.",
      inputSchema: z.object({}),
      execute: async (): Promise<AgentPlan | { empty: true }> => (await deps.load()) ?? { empty: true },
    }),
  };
}
