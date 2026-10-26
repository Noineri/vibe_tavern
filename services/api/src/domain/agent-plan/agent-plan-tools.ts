import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { agentPlanSchema } from "@vibe-tavern/api-contracts";
import { normalizeAgentPlan, type AgentPlan, type AgentPlanOwner } from "@vibe-tavern/domain";

export interface AgentPlanToolResult {
  readonly ok: boolean;
  readonly activeTitle?: string;
  readonly remaining?: number;
  readonly error?: string;
}

/** Options that shape the exposed tool set (SIDECHAT_PLAN SC-0h). */
export interface AgentPlanToolOptions {
  /** The owner whose plan the tools read/write. Drives the model-facing
   *  scope wording only — the load/save closures carry the actual owner at
   *  the store boundary. Absent keeps the script wording (every pre-SC-0h
   *  caller is script-owned). */
  readonly owner?: AgentPlanOwner;
  /** Read-only mode (chat hosts, e.g. SC-12's sidechat): expose ONLY
   *  `read_plan` — the branch-plan write is reserved for the director kind
   *  (owner ruling 7), so no `plan` tool is handed to the model. */
  readonly readOnly?: boolean;
}

/** The model-facing scope noun for an owner — script callers keep today's
 *  wording byte-identically (it is part of their pinned tool surface). */
function ownerScope(owner: AgentPlanOwner | undefined): string {
  return owner?.kind === "chatBranch" ? "this chat branch" : "this script";
}

/** Build the shared agent plan tools without depending on the copilot runtime. */
export function createAgentPlanTools(
  deps: {
    readonly load: () => Promise<AgentPlan | null>;
    readonly save: (plan: AgentPlan) => Promise<void>;
  },
  options: AgentPlanToolOptions = {},
): ToolSet {
  const scope = ownerScope(options.owner);
  const readPlan = tool({
    description: `Read the full current plan for ${scope}.`,
    inputSchema: z.object({}),
    execute: async (): Promise<AgentPlan | { empty: true }> => (await deps.load()) ?? { empty: true },
  });
  if (options.readOnly) {
    return { read_plan: readPlan };
  }
  return {
    plan: tool({
      description:
        `Replace the full durable plan for ${scope} — the serious multi-step work with a goal; the plan survives sessions. ` +
        "Send the complete {plan} object every time. At most one task may be active. " +
        "For a quick checklist of the current session's small tasks, use the `todo` tool instead.",
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
    read_plan: readPlan,
  };
}
