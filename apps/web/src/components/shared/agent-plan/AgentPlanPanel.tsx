import { useState } from "react";
import type { AgentPlan, AgentPlanTask } from "@vibe-tavern/api-contracts";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import { Ic } from "../icons.js";

export interface AgentPlanPanelProps {
  plan: AgentPlan;
  onOpenEditor: () => void;
  locked: boolean;
}

type TaskStatus = AgentPlanTask["status"];

function pickCurrent(tasks: AgentPlanTask[]): AgentPlanTask | null {
  return tasks.find((task) => task.status === "active") ?? tasks.find((task) => task.status === "pending") ?? null;
}

function countRemaining(tasks: AgentPlanTask[]): number {
  return tasks.filter((task) => task.status === "pending" || task.status === "active").length;
}

function statusClass(status: TaskStatus): string {
  switch (status) {
    case "active": return "border-accent text-accent";
    case "completed": return "border-success-text text-success-text";
    default: return "border-t4 text-t4";
  }
}

function NodeGlyph({ status }: { status: TaskStatus }) {
  return (
    <span
      data-testid={`agent-plan-glyph-${status}`}
      className={cn("flex h-3 w-3 shrink-0 items-center justify-center rounded-full border [&_svg]:h-[7px] [&_svg]:w-[7px]", statusClass(status))}
    >
      {status === "active" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {status === "completed" && <Ic.check />}
      {status === "abandoned" && <Ic.close />}
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={cn("shrink-0 text-t4 transition-transform duration-150", open ? "rotate-180" : "rotate-0")}>
      <polyline points="3 6 8 11 13 6" />
    </svg>
  );
}

/** Pinned, expandable summary of the script-owned agent plan. */
export function AgentPlanPanel({ plan, onOpenEditor, locked }: AgentPlanPanelProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);

  if (plan.tasks.length === 0 && plan.goal === "" && plan.constraints.length === 0) return null;

  const current = pickCurrent(plan.tasks);
  const remaining = countRemaining(plan.tasks);
  const summaryStatus: TaskStatus = current?.status ?? "completed";
  const editorButton = (
    <button
      type="button"
      data-testid="agent-plan-open-editor"
      disabled={locked}
      onClick={onOpenEditor}
      className="shrink-0 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:text-t1 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {t("agent_plan_editor")}
    </button>
  );

  if (!open) {
    return (
      <div data-testid="agent-plan-panel" data-state="collapsed" className="flex w-full min-w-0 shrink-0 items-center gap-1.5 border-b border-border bg-surface px-2 py-1 text-[calc(var(--ui-fs)-3px)] font-medium text-t3">
        <button
          type="button"
          data-testid="agent-plan-toggle"
          onClick={() => setOpen(true)}
          aria-label={t("agent_plan_expand")}
          className="group flex min-w-0 flex-1 items-center gap-1.5 text-left transition-colors hover:text-t2"
        >
          <NodeGlyph status={summaryStatus} />
          <span className="min-w-0 flex-1 truncate">{current ? current.title : t("agent_plan_done")}</span>
          <span className="shrink-0 tabular-nums text-t4">· {remaining} {t("agent_plan_remaining")}</span>
          <Chevron open={false} />
        </button>
        {editorButton}
      </div>
    );
  }

  return (
    <div data-testid="agent-plan-panel" data-state="expanded" className="flex min-w-0 shrink-0 flex-col gap-1 border-b border-border bg-surface px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-accent"><Ic.target /></span>
        <span className="text-[calc(var(--ui-fs)-4px)] font-semibold uppercase tracking-[0.06em] text-t4">{t("agent_plan_title")}</span>
        <span className="shrink-0 tabular-nums text-t4">{remaining} {t("agent_plan_remaining")}</span>
        {editorButton}
        <button type="button" onClick={() => setOpen(false)} aria-label={t("agent_plan_collapse")} className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded text-t4 transition-colors hover:bg-s2 hover:text-t2 md:h-5 md:w-5">
          <Chevron open />
        </button>
      </div>
      <ol className="flex flex-col">
        {plan.tasks.map((task) => (
          <li key={task.id} data-testid={`agent-plan-task-${task.status}`} className="flex items-start gap-1.5 py-0.5">
            <span className="mt-[1px] flex shrink-0 items-center justify-center"><NodeGlyph status={task.status} /></span>
            <span className="min-w-0 flex-1">
              <span className={cn("block truncate font-ui text-[calc(var(--ui-fs)-3px)]", task.status === "completed" && "text-success-text line-through", task.status === "abandoned" && "text-t4 line-through", task.status === "active" && "text-t2", task.status === "pending" && "text-t3")}>{task.title}</span>
              {task.status === "active" && task.body && <span className="mt-0.5 block whitespace-pre-wrap font-ui text-[calc(var(--ui-fs)-3px)] text-t4">{task.body}</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
