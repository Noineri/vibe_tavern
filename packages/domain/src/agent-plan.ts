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

export type AgentPlanOwner = {
  kind: "script";
  scriptId: string;
};

/**
 * Identifies which entity owns an agent thread (the shared agent-shell thread
 * table `experience_copilot_threads`). Threads were born script-owned (the
 * mini-app and script assistants); SIDECHAT_PLAN SC-0a adds chat-branch owners
 * so further agent kinds (the sidechat, later the director) can live on the
 * same machinery. Ownership is mutually exclusive per row and decides which
 * store methods and lifecycle routes serve the thread. Beside
 * {@link AgentPlanOwner} — the two owner unions of the agent shell.
 *
 * `agentKind` is the shared agent-kind registry slug (e.g. "sidechat-ooc") —
 * stored on the thread row itself for chat owners, because unlike a script
 * there is nothing to derive the kind from.
 */
export type AgentThreadOwner =
  | { kind: "script"; scriptId: string }
  | { kind: "chat"; chatId: string; branchId: string; agentKind: string };

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
