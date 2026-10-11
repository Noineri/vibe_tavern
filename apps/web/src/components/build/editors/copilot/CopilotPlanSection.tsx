import { useState } from "react";
import type { AgentPlanOwner } from "@vibe-tavern/domain";
import { useAgentPlan } from "../../../../hooks/use-agent-plan.js";
import { AgentPlanPanel } from "../../../shared/agent-plan/AgentPlanPanel.js";
import { AgentPlanEditorModal } from "../../../shared/agent-plan/AgentPlanEditorModal.js";

/**
 * CopilotPlanSection (PM-6, EXPERIENCE_COPILOT_PLAN_MODE_PLAN) — the copilot
 * shell's mount of the shared agent-plan mechanic, extracted from
 * ExperienceCopilotShell when the thread-scoped todo mechanic was removed
 * (arch-gate file ratchet: the shell's line budget shrinks by moving code
 * out, never by growing).
 *
 * Owns ONE `useAgentPlan` subscription for the script — the panel and the
 * editor modal read the SAME owner cache entry the shell's controller writes
 * into via the hook's `applyToolResult` (routed from `plan` tool results) —
 * plus the editor modal's local open state. The shell passes the streaming
 * lock; the model's rewrite and the user's edit can never race.
 *
 * Placement contract (unchanged from the todo-panel era): the caller pins this
 * section DIRECTLY below `ExperienceContextMeter` — it never scrolls with the
 * feed. The panel hides itself while the plan is empty.
 */
export function CopilotPlanSection({ owner, locked }: { owner: AgentPlanOwner; locked: boolean }) {
  const { plan } = useAgentPlan(owner);
  const [editorOpen, setEditorOpen] = useState(false);

  return (
    <>
      <AgentPlanPanel plan={plan} onOpenEditor={() => setEditorOpen(true)} locked={locked} />
      {/* The editor locks (fields + save) while a turn streams so the model's
          rewrite and the user's edit can never race. */}
      <AgentPlanEditorModal owner={owner} open={editorOpen} onClose={() => setEditorOpen(false)} locked={locked} />
    </>
  );
}
