import { useEffect, useState } from "react";
import type { AgentPlan, AgentPlanOwner, AgentPlanTask, AgentPlanTaskStatus } from "@vibe-tavern/domain";
import { useAgentPlan } from "../../../hooks/use-agent-plan.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { lblCls } from "../../../lib/field-tokens.js";
import { AutoTextarea } from "../auto-textarea.js";
import { DropdownSelect } from "../DropdownSelect.js";
import { Ic } from "../icons.js";
import { Modal } from "../Modal.js";
import { modalPanelCls } from "../modal-helpers.js";
import { TextInput } from "../text-input.js";

export interface AgentPlanEditorModalProps {
  owner: AgentPlanOwner;
  open: boolean;
  onClose: () => void;
  locked: boolean;
}

const STATUS_OPTIONS: Array<{ id: AgentPlanTaskStatus; labelKey: "agent_plan_status_pending" | "agent_plan_status_active" | "agent_plan_status_completed" | "agent_plan_status_abandoned" }> = [
  { id: "pending", labelKey: "agent_plan_status_pending" },
  { id: "active", labelKey: "agent_plan_status_active" },
  { id: "completed", labelKey: "agent_plan_status_completed" },
  { id: "abandoned", labelKey: "agent_plan_status_abandoned" },
];

function clonePlan(plan: AgentPlan): AgentPlan {
  return { goal: plan.goal, constraints: [...plan.constraints], tasks: plan.tasks.map((task) => ({ ...task })) };
}

function newTask(): AgentPlanTask {
  return { id: `task_${crypto.randomUUID()}`, title: "", body: "", status: "pending" };
}

/** Full-screen mobile / wide desktop editor for a script-owned agent plan. */
export function AgentPlanEditorModal({ owner, open, onClose, locked }: AgentPlanEditorModalProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const { plan, isLoading, save } = useAgentPlan(owner);
  const [draft, setDraft] = useState<AgentPlan>(() => clonePlan(plan));
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(clonePlan(plan));
      setSaveError(null);
    }
  }, [open, plan]);

  const updateTask = (index: number, patch: Partial<AgentPlanTask>) => {
    setDraft((current) => ({
      ...current,
      tasks: current.tasks.map((task, taskIndex) => taskIndex === index ? { ...task, ...patch } : task),
    }));
  };

  const removeConstraint = (index: number) => setDraft((current) => ({ ...current, constraints: current.constraints.filter((_, itemIndex) => itemIndex !== index) }));
  const removeTask = (index: number) => setDraft((current) => ({ ...current, tasks: current.tasks.filter((_, itemIndex) => itemIndex !== index) }));
  const moveTask = (index: number, direction: -1 | 1) => setDraft((current) => {
    const target = index + direction;
    if (target < 0 || target >= current.tasks.length) return current;
    const tasks = [...current.tasks];
    const [task] = tasks.splice(index, 1);
    tasks.splice(target, 0, task!);
    return { ...current, tasks };
  });

  const handleSave = async () => {
    if (locked) return;
    setSaveError(null);
    try {
      await save(draft);
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };

  const close = () => {
    if (!locked) onClose();
  };

  return (
    <Modal open={open} onClose={close} title={t("agent_plan_editor")} description={t("agent_plan_editor")}>
      <div className={cn(
        "flex flex-col",
        isMobile
          ? "glass-blur-under h-full w-full overflow-hidden"
          : cn(modalPanelCls, "max-h-[calc(100vh-60px)] w-[1080px] max-w-[calc(100vw-32px)]"),
      )}>
        <div className={cn("shrink-0 border-b border-border", isMobile ? "px-4 pb-3 pt-4" : "px-6 pb-4 pt-5")}>
          <h2 className="font-ui text-[calc(var(--ui-fs)+2px)] font-medium text-t1">{t("agent_plan_editor")}</h2>
          {locked && <p className="mt-1 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("agent_plan_locked")}</p>}
        </div>
        <div className={cn("min-h-0 flex-1 overflow-y-auto", isMobile ? "px-4 py-4" : "px-6 py-5")}>
          {isLoading ? (
            <p className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("agent_plan_loading")}</p>
          ) : (
            <div className="flex flex-col gap-5">
              <div>
                <label htmlFor="agent-plan-goal" className={lblCls}>{t("agent_plan_goal")}</label>
                <AutoTextarea id="agent-plan-goal" value={draft.goal} disabled={locked} minRows={2} onChange={(event) => setDraft((current) => ({ ...current, goal: event.target.value }))} />
              </div>
              <div>
                <span className={lblCls}>{t("agent_plan_constraints")}</span>
                <div className="flex flex-col gap-2">
                  {draft.constraints.map((constraint, index) => (
                    <div key={index} className="flex items-start gap-2">
                      <AutoTextarea aria-label={`${t("agent_plan_constraints")} ${index + 1}`} value={constraint} disabled={locked} minRows={1} onChange={(event) => setDraft((current) => ({ ...current, constraints: current.constraints.map((item, itemIndex) => itemIndex === index ? event.target.value : item) }))} />
                      <button type="button" aria-label={t("agent_plan_remove")} title={t("agent_plan_remove")} disabled={locked} onClick={() => removeConstraint(index)} className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded text-t4 transition-colors hover:bg-s2 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"><Ic.close /></button>
                    </div>
                  ))}
                </div>
                <button type="button" disabled={locked} onClick={() => setDraft((current) => ({ ...current, constraints: [...current.constraints, ""] }))} className="mt-2 cursor-pointer font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-colors hover:text-t1 disabled:cursor-not-allowed disabled:opacity-40">{t("agent_plan_add_constraint")}</button>
              </div>
              <div>
                <span className={lblCls}>{t("agent_plan_tasks")}</span>
                <div className="flex flex-col gap-3">
                  {draft.tasks.map((task, index) => (
                    <div key={task.id} data-testid={`agent-plan-editor-task-${index}`} className="rounded-[6px] border border-border bg-s2 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <DropdownSelect value={task.status} options={STATUS_OPTIONS.map((option) => ({ id: option.id, label: t(option.labelKey) }))} onChange={(status) => updateTask(index, { status: status as AgentPlanTaskStatus })} disabled={locked} searchable={false} triggerTestId={`agent-plan-status-${index}`} triggerClassName="flex h-9 w-full items-center justify-between rounded-[6px] border border-border bg-s2 px-3 font-ui text-[calc(var(--ui-fs)-2px)] text-t1 hover:border-accent sm:w-[150px]" />
                        <TextInput aria-label={`${t("agent_plan_task_title")} ${index + 1}`} value={task.title} disabled={locked} onChange={(event) => updateTask(index, { title: event.target.value })} className="min-w-[180px] flex-1" />
                        <div className="ml-auto flex shrink-0 items-center gap-1 max-[400px]:basis-full max-[400px]:justify-end">
                          <button type="button" aria-label={t("agent_plan_move_up")} title={t("agent_plan_move_up")} disabled={locked || index === 0} onClick={() => moveTask(index, -1)} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded text-t4 transition-colors hover:bg-s3 hover:text-t1 disabled:cursor-not-allowed disabled:opacity-40">{Ic.caret("u")}</button>
                          <button type="button" aria-label={t("agent_plan_move_down")} title={t("agent_plan_move_down")} disabled={locked || index === draft.tasks.length - 1} onClick={() => moveTask(index, 1)} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded text-t4 transition-colors hover:bg-s3 hover:text-t1 disabled:cursor-not-allowed disabled:opacity-40">{Ic.caret("d")}</button>
                          <button type="button" aria-label={t("agent_plan_remove")} title={t("agent_plan_remove")} disabled={locked} onClick={() => removeTask(index)} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded text-t4 transition-colors hover:bg-s3 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"><Ic.close /></button>
                        </div>
                      </div>
                      <AutoTextarea aria-label={`${t("agent_plan_task_body")} ${index + 1}`} value={task.body} disabled={locked} minRows={2} placeholder={t("agent_plan_task_body_placeholder")} onChange={(event) => updateTask(index, { body: event.target.value })} className="mt-2" />
                    </div>
                  ))}
                </div>
                <button type="button" disabled={locked} onClick={() => setDraft((current) => ({ ...current, tasks: [...current.tasks, newTask()] }))} className="mt-2 cursor-pointer font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-colors hover:text-t1 disabled:cursor-not-allowed disabled:opacity-40">{t("agent_plan_add_task")}</button>
              </div>
            </div>
          )}
        </div>
        <div className={cn("shrink-0 border-t border-border bg-surface", isMobile ? "px-4 py-3" : "px-6 py-3")}>
          {saveError && <p role="alert" className="mb-2 font-ui text-[calc(var(--ui-fs)-2px)] text-danger">{saveError}</p>}
          <div className="flex items-center justify-end gap-2">
            <button type="button" disabled={locked} onClick={onClose} className="h-[37px] cursor-pointer rounded-md bg-transparent px-4 py-0 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1 disabled:cursor-not-allowed disabled:opacity-40">{t("agent_plan_cancel")}</button>
            <button type="button" data-testid="agent-plan-save" disabled={locked || isLoading} onClick={() => { void handleSave(); }} className="h-[37px] cursor-pointer rounded-md bg-accent px-[21px] py-0 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50">{t("agent_plan_save")}</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
