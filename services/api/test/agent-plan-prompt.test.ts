import { describe, expect, test } from "bun:test";
import type { AgentPlan } from "@vibe-tavern/domain";
import { renderAgentPlanSection } from "../src/domain/agent-plan/agent-plan-prompt.js";

const planWithActiveTask: AgentPlan = {
  goal: "Build a counter experience",
  constraints: ["Keep the rules deterministic", "Use the existing visual bridge"],
  tasks: [
    { id: "rules", title: "Write rules", body: "Define the reducer before editing the buffer.", status: "active" },
    { id: "visual", title: "Bind visual", body: "Hidden pending details.", status: "pending" },
  ],
};

describe("renderAgentPlanSection", () => {
  test("renders the goal, constraints, tasks, current approach, and discipline", () => {
    expect(renderAgentPlanSection(planWithActiveTask)).toBe([
      "# Plan",
      "Goal: Build a counter experience",
      "Constraints:",
      "- Keep the rules deterministic",
      "- Use the existing visual bridge",
      "Tasks:",
      "[active] Write rules",
      "[pending] Bind visual",
      "Current task \"Write rules\" — your approach (written before starting):",
      "Define the reducer before editing the buffer.",
      "Write the current task's approach into its body BEFORE starting it.",
      "When a task is done, mark it completed and set the next one active.",
      "Other tasks' bodies are not shown here — call read_plan when you need them.",
    ].join("\n"));
  });

  test("omits constraints and current approach when no task is active", () => {
    const section = renderAgentPlanSection({
      goal: "Review the draft",
      constraints: [],
      tasks: [{ id: "review", title: "Review rules", body: "Do not expose this body.", status: "pending" }],
    });

    expect(section).toContain("# Plan\nGoal: Review the draft\nTasks:\n[pending] Review rules");
    expect(section).not.toContain("Constraints:");
    expect(section).not.toContain("Current task");
    expect(section).not.toContain("Do not expose this body.");
  });

  test("uses the required placeholder for an active task without an approach", () => {
    const section = renderAgentPlanSection({
      goal: "Start implementation",
      constraints: [],
      tasks: [{ id: "start", title: "Implement prompt", body: "", status: "active" }],
    });

    expect(section).toContain("Current task \"Implement prompt\" — your approach (written before starting):");
    expect(section).toContain("(not written yet — write it with the plan tool before you start)");
  });

  test("returns an empty string for null or an empty plan", () => {
    expect(renderAgentPlanSection(null)).toBe("");
    expect(renderAgentPlanSection({ goal: "", constraints: [], tasks: [] })).toBe("");
  });
});
