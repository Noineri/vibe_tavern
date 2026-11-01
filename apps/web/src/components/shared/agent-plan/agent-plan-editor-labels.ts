import type { AgentPlanOwner } from "@vibe-tavern/domain";
import type Resources from "../../../i18n/resources.js";

type PlanLabelKey = keyof Resources["en"];

/**
 * DR-9 (mockup §7): the plan editor's label set derives from the owner kind
 * — ONE derivation; every label `AgentPlanEditorModal` renders flows through
 * here (a second hand-written label map would be a copy #2 defect). A branch
 * owner (the sidechat's story plan) gets the story wording; a script owner
 * keeps today's labels, byte-identically (their suites pin it).
 */
export interface AgentPlanEditorLabelSet {
  /** Modal + header title. */
  title: PlanLabelKey;
  /** Label above the goal/premise field. */
  goal: PlanLabelKey;
  /** Muted hint under the goal field (story plans only — §7). */
  goalHint?: PlanLabelKey;
  constraints: PlanLabelKey;
  addConstraint: PlanLabelKey;
  tasks: PlanLabelKey;
  addTask: PlanLabelKey;
  /** Aria-label base for a task's body field. */
  taskBody: PlanLabelKey;
  /** Muted hint under each task's body (story plans only — §7). */
  taskBodyHint?: PlanLabelKey;
  taskBodyPlaceholder: PlanLabelKey;
}

const SCRIPT_LABELS: AgentPlanEditorLabelSet = {
  title: "agent_plan_editor",
  goal: "agent_plan_goal",
  constraints: "agent_plan_constraints",
  addConstraint: "agent_plan_add_constraint",
  tasks: "agent_plan_tasks",
  addTask: "agent_plan_add_task",
  taskBody: "agent_plan_task_body",
  taskBodyPlaceholder: "agent_plan_task_body_placeholder",
};

const STORY_LABELS: AgentPlanEditorLabelSet = {
  title: "agent_plan_story_title",
  goal: "agent_plan_story_goal",
  goalHint: "agent_plan_story_goal_hint",
  constraints: "agent_plan_story_constraints",
  addConstraint: "agent_plan_story_add_constraint",
  tasks: "agent_plan_story_tasks",
  addTask: "agent_plan_story_add_task",
  taskBody: "agent_plan_story_task_body",
  taskBodyHint: "agent_plan_story_task_body_hint",
  taskBodyPlaceholder: "agent_plan_story_task_body_placeholder",
};

export function agentPlanEditorLabels(owner: AgentPlanOwner): AgentPlanEditorLabelSet {
  return owner.kind === "chatBranch" ? STORY_LABELS : SCRIPT_LABELS;
}
