import type { AgentPlan } from "@vibe-tavern/domain";

/** Render the durable script-owned plan for the copilot's system prompt. */
export function renderAgentPlanSection(plan: AgentPlan | null): string {
  if (plan === null || (plan.goal === "" && plan.constraints.length === 0 && plan.tasks.length === 0)) {
    return "";
  }

  const activeTask = plan.tasks.find((task) => task.status === "active");
  const lines = ["# Plan", `Goal: ${plan.goal}`];
  if (plan.constraints.length > 0) {
    lines.push("Constraints:", ...plan.constraints.map((constraint) => `- ${constraint}`));
  }
  lines.push("Tasks:", ...plan.tasks.map((task) => `[${task.status}] ${task.title}`));
  if (activeTask !== undefined) {
    lines.push(
      `Current task "${activeTask.title}" — your approach (written before starting):`,
      activeTask.body || "(not written yet — write it with the plan tool before you start)",
    );
  }
  lines.push(
    "Write the current task's approach into its body BEFORE starting it.",
    "When a task is done, mark it completed and set the next one active.",
    "Other tasks' bodies are not shown here — call read_plan when you need them.",
  );
  return lines.join("\n");
}
