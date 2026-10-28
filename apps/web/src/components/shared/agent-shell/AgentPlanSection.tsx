import { useState } from "react";
import { toast } from "sonner";
import type { AgentPlanOwner } from "@vibe-tavern/domain";
import { useT } from "../../../i18n/context.js";
import { useAgentPlan } from "../../../hooks/use-agent-plan.js";
import { AgentPlanPanel } from "../agent-plan/AgentPlanPanel.js";
import { AgentPlanEditorModal } from "../agent-plan/AgentPlanEditorModal.js";

/**
 * AgentPlanSection (PM-6, EXPERIENCE_COPILOT_PLAN_MODE_PLAN; AS-6b2 moved
 * from the copilot editors' CopilotPlanSection) — the agent shell's mount of
 * the shared agent-plan mechanic, extracted from the shell when the
 * thread-scoped todo mechanic was removed (arch-gate file ratchet: the
 * shell's line budget shrinks by moving code out, never by growing).
 *
 * Owns ONE `useAgentPlan` subscription for the owner — the panel and the
 * editor modal read the SAME owner cache entry the shell's controller writes
 * into via the hook's `applyToolResult` (routed from `plan` tool results) —
 * plus the editor modal's local open state. The shell passes the streaming
 * lock; the model's rewrite and the user's edit can never race.
 *
 * Placement contract (unchanged from the todo-panel era): the caller pins this
 * section DIRECTLY below `AgentContextMeter` — it never scrolls with the
 * feed. The panel hides itself while the plan is empty.
 *
 * DR-9: a BRANCH owner (the sidechat's story plan) renders as the curtain
 * (mockup §5/§9 — this section is the mobile sidechat pane's mount; the
 * desktop sidechat drops the section entirely, P1, and the chat column's
 * strip becomes the story plan's desktop home, DR-11). Script/mini-app
 * owners pass no presentation props: today's inline panel, byte-identical.
 */
export function AgentPlanSection({ owner, locked }: { owner: AgentPlanOwner; locked: boolean }) {
  const { t } = useT();
  const { plan, save } = useAgentPlan(owner);
  const [editorOpen, setEditorOpen] = useState(false);
  const story = owner.kind === "chatBranch";

  // R4 (mockup §5): the revert-to-work write — the completed event becomes
  // the ONE active event, the currently-active one steps back to pending;
  // the write rides the hook's `save` (the editor's PUT — no new write
  // surface) and respects the same streaming lock.
  const revertTask = story
    ? (taskId: string) => {
      if (locked) return;
      void save({
        ...plan,
        tasks: plan.tasks.map((task) => (
          task.id === taskId
            ? { ...task, status: "active" }
            : task.status === "active"
              ? { ...task, status: "pending" }
              : task
        )),
      }).catch(() => {
        toast.error(t("agent_plan_revert_error"));
      });
    }
    : undefined;

  return (
    <>
      <AgentPlanPanel
        plan={plan}
        onOpenEditor={() => setEditorOpen(true)}
        locked={locked}
        presentation={story ? "curtain" : undefined}
        onRevertTask={revertTask}
      />
      {/* The editor locks (fields + save) while a turn streams so the model's
          rewrite and the user's edit can never race. */}
      <AgentPlanEditorModal owner={owner} open={editorOpen} onClose={() => setEditorOpen(false)} locked={locked} />
    </>
  );
}
