/** Statuses shared by the copilot todo and persisted agent plan tasks. */
export const AGENT_PLAN_TASK_STATUS = {
  pending: "pending",
  active: "active",
  completed: "completed",
  abandoned: "abandoned",
} as const;

export type AgentPlanTaskStatus = typeof AGENT_PLAN_TASK_STATUS[keyof typeof AGENT_PLAN_TASK_STATUS];

export interface AgentPlanTask {
  id: string;
  title: string;
  body: string;
  status: AgentPlanTaskStatus;
}

export interface AgentPlan {
  goal: string;
  constraints: string[];
  tasks: AgentPlanTask[];
}

/** Who owns a persisted agent plan. The two arms are mutually exclusive and
 * map to different tables in the store layer: script rows live in
 * `agent_plans` (script_id soft link, no FK — the snapshot convention),
 * chat-branch rows in `agent_branch_plans` (hard FK cascade — a branch is
 * runtime state whose plan must not outlive it). */
export type AgentPlanOwner =
  | { kind: "script"; scriptId: string }
  | { kind: "chatBranch"; chatId: string; branchId: string };

export const EMPTY_AGENT_PLAN: AgentPlan = {
  goal: "",
  constraints: [],
  tasks: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentPlanTaskStatus(value: unknown): value is AgentPlanTaskStatus {
  return Object.values(AGENT_PLAN_TASK_STATUS).some((status) => status === value);
}

/**
 * Normalizes an agent plan loaded from persisted JSON without imposing product
 * length limits. Invalid tasks are dropped; an ambiguous active task makes the
 * whole plan unusable rather than silently choosing one.
 */
export function normalizeAgentPlan(raw: unknown): AgentPlan | null {
  if (!isRecord(raw)) return null;

  const tasks: AgentPlanTask[] = [];
  let activeCount = 0;
  const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  for (const candidate of rawTasks) {
    if (!isRecord(candidate)) continue;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
    if (!id || !title) continue;

    const status = isAgentPlanTaskStatus(candidate.status)
      ? candidate.status
      : AGENT_PLAN_TASK_STATUS.pending;
    if (status === AGENT_PLAN_TASK_STATUS.active) activeCount += 1;
    tasks.push({
      id,
      title,
      body: typeof candidate.body === "string" ? candidate.body : "",
      status,
    });
  }

  if (activeCount > 1) return null;

  return {
    goal: typeof raw.goal === "string" ? raw.goal : "",
    constraints: Array.isArray(raw.constraints)
      ? raw.constraints.filter((constraint): constraint is string => typeof constraint === "string")
      : [],
    tasks,
  };
}
