import { useEffect, useState } from "react";
import type { AgentPlan, AgentPlanOwner, AgentPlanTask, AgentPlanTaskStatus } from "@vibe-tavern/domain";
import { STORY_DAY_PART, type StoryClock, type StoryDayPart } from "@vibe-tavern/domain";
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
import { NumberInput } from "../NumberInput.js";
import { ScrollArea } from "../scroll-area.js";
import { SegmentedControl } from "../SegmentedControl.js";
import { TextInput } from "../text-input.js";
import { agentPlanEditorLabels } from "./agent-plan-editor-labels.js";
import { PART_LABEL_KEYS } from "./story-event-time.js";

export interface AgentPlanEditorModalProps {
  owner: AgentPlanOwner;
  open: boolean;
  onClose: () => void;
  locked: boolean;
  /** DK-9: the calendar chip's open — the editor scrolls to and rings that
   *  event's row while set (the section clears it for the plain editor
   *  button). Null = no focus. */
  focusTaskId?: string | null;
  /** DK-10 (mockup §6): the branch story clock, threaded by AgentPlanSection
   *  (`useStorySceneClock`) — the when-row renders only for a chatBranch
   *  owner WHILE the clock reads. Null/undefined = no row: script plans and
   *  a branch whose clock does not read (a marked schema without a readable
   *  record) render byte-identically to before this unit, matching the
   *  calendar's off state. The clock VALUE anchors the default day when an
   *  undated event is assigned. */
  storyClock?: StoryClock | null;
}

/** The when-row's mode segments: an undated event runs in plan order; a
 *  dated one carries `at = { day, part }` (the domain's StoryEventTime). */
type WhenMode = "undated" | "dated";

/** The part SegmentedControl's fifth value — "at any time of the day",
 *  written as `part: null` (the domain's day-start rank). Never collides
 *  with the four STORY_DAY_PART words. */
const ANYTIME_PART = "any";

type WhenPartOption = StoryDayPart | typeof ANYTIME_PART;

/** The four story parts in story order (the domain const's own order). */
const STORY_PART_OPTIONS: readonly StoryDayPart[] = Object.values(STORY_DAY_PART);

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

/** Full-screen mobile / wide desktop editor for a script-owned or branch-owned agent plan. */
export function AgentPlanEditorModal({ owner, open, onClose, locked, focusTaskId = null, storyClock = null }: AgentPlanEditorModalProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const { plan, isLoading, save } = useAgentPlan(owner);
  // DR-9 (mockup §7): the label set derives from the owner kind — a branch
  // owner (the story plan) gets the story wording, a script owner today's.
  const labels = agentPlanEditorLabels(owner);
  const [draft, setDraft] = useState<AgentPlan>(() => clonePlan(plan));
  const [saveError, setSaveError] = useState<string | null>(null);
  // DK-10 (mockup §6): the when-row gate — a chatBranch story plan while the
  // clock READS (not merely clockOn: a marked schema without a readable
  // record shows nothing, matching the calendar's off state). Every write
  // below keeps `at` valid by construction (integer day >= 1, one of the
  // four parts or null) — `isStoryEventTime` on the wire rejects anything
  // else, and the PUT has been strict since DK-1.
  const whenReady = owner.kind === "chatBranch" && storyClock !== null;
  // The parts SegmentedControl's options: the four story parts (the ONE
  // PART_LABEL_KEYS map) + "any time" (part null). Rebuilt per render — the
  // labels localize through t.
  const partOptions: Array<{ value: WhenPartOption; label: string }> = [
    ...STORY_PART_OPTIONS.map((part) => ({ value: part, label: t(PART_LABEL_KEYS[part]) })),
    { value: ANYTIME_PART, label: t("story_plan_when_anytime") },
  ];

  useEffect(() => {
    if (open) {
      setDraft(clonePlan(plan));
      setSaveError(null);
    }
  }, [open, plan]);

  // DK-9: the calendar chip's open — scroll the focused event's row into
  // view and ring it (the row is found by id through the plan's task order,
  // the same `agent-plan-editor-task-<index>` testid the rows carry).
  const focusIndex = focusTaskId !== null ? draft.tasks.findIndex((task) => task.id === focusTaskId) : -1;
  useEffect(() => {
    if (!open || focusIndex < 0) return;
    const row = document.querySelector<HTMLElement>(`[data-testid="agent-plan-editor-task-${focusIndex}"]`);
    row?.scrollIntoView({ block: "center" });
  }, [open, focusIndex]);

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
    <Modal open={open} onClose={close} title={t(labels.title)} description={t(labels.title)}>
      <div className={cn(
        "flex flex-col",
        isMobile
          ? "glass-blur-under h-full w-full overflow-hidden"
          : cn(modalPanelCls, "max-h-[calc(100vh-60px)] w-[1080px] max-w-[calc(100vw-32px)]"),
      )}>
        <div className={cn("shrink-0 border-b border-border", isMobile ? "px-4 pb-3 pt-4" : "px-6 pb-4 pt-5")}>
          <h2 className="font-ui text-[calc(var(--ui-fs)+2px)] font-medium text-t1">{t(labels.title)}</h2>
          {locked && <p className="mt-1 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("agent_plan_locked")}</p>}
        </div>
        {/* CNR-8h: the editor body rides the thin ScrollArea lane (3px
            rest / 5px hover) instead of the native 8px fallback — the CNR-8g
            modal-body idiom: ONE wrapper for both viewports (shared body;
            the CNR-7g policy hides the lane on phones), the viewport takes
            the panel's remaining height, and the px/py padding moved onto
            the content element so it scrolls with the fields. */}
        <ScrollArea scrollbarSize="thin" className="min-h-0 flex-1" contentClassName={isMobile ? "px-4 py-4" : "px-6 py-5"}>
          {isLoading ? (
            <p className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("agent_plan_loading")}</p>
          ) : (
            <div className="flex flex-col gap-5">
              <div>
                <label htmlFor="agent-plan-goal" className={lblCls}>{t(labels.goal)}</label>
                <AutoTextarea id="agent-plan-goal" value={draft.goal} disabled={locked} minRows={2} onChange={(event) => setDraft((current) => ({ ...current, goal: event.target.value }))} />
                {labels.goalHint !== undefined && (
                  <p data-testid="agent-plan-goal-hint" className="mt-1 font-ui text-[calc(var(--ui-fs)-4px)] leading-relaxed text-t3">{t(labels.goalHint)}</p>
                )}
              </div>
              <div>
                <span className={lblCls}>{t(labels.constraints)}</span>
                <div className="flex flex-col gap-2">
                  {draft.constraints.map((constraint, index) => (
                    <div key={index} className="flex items-start gap-2">
                      <AutoTextarea aria-label={`${t("agent_plan_constraints")} ${index + 1}`} value={constraint} disabled={locked} minRows={1} onChange={(event) => setDraft((current) => ({ ...current, constraints: current.constraints.map((item, itemIndex) => itemIndex === index ? event.target.value : item) }))} />
                      <button type="button" aria-label={t("agent_plan_remove")} title={t("agent_plan_remove")} disabled={locked} onClick={() => removeConstraint(index)} className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded text-t4 transition-colors hover:bg-s2 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"><Ic.close /></button>
                    </div>
                  ))}
                </div>
                <button type="button" disabled={locked} onClick={() => setDraft((current) => ({ ...current, constraints: [...current.constraints, ""] }))} className="mt-2 cursor-pointer font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-colors hover:text-t1 disabled:cursor-not-allowed disabled:opacity-40">{t(labels.addConstraint)}</button>
              </div>
              <div>
                <span className={lblCls}>{t(labels.tasks)}</span>
                <div className="flex flex-col gap-3">
                  {draft.tasks.map((task, index) => {
                    // A const binding so the when-row's closures below read
                    // the narrowed `at` cleanly (no non-null casts).
                    const at = task.at;
                    return (
                    <div key={task.id} data-testid={`agent-plan-editor-task-${index}`} className={cn("rounded-[6px] border bg-s2 p-3", index === focusIndex ? "border-accent" : "border-border")}>
                      <div className="flex flex-wrap items-center gap-2">
                        <DropdownSelect value={task.status} options={STATUS_OPTIONS.map((option) => ({ id: option.id, label: t(option.labelKey) }))} onChange={(status) => updateTask(index, { status: status as AgentPlanTaskStatus })} disabled={locked} searchable={false} triggerTestId={`agent-plan-status-${index}`} triggerClassName="flex h-9 w-full items-center justify-between rounded-[6px] border border-border bg-s2 px-3 font-ui text-[calc(var(--ui-fs)-2px)] text-t1 hover:border-accent sm:w-[150px]" />
                        <TextInput aria-label={`${t("agent_plan_task_title")} ${index + 1}`} value={task.title} disabled={locked} onChange={(event) => updateTask(index, { title: event.target.value })} className="min-w-[180px] flex-1" />
                        <div className="ml-auto flex shrink-0 items-center gap-1 max-[400px]:basis-full max-[400px]:justify-end">
                          <button type="button" aria-label={t("agent_plan_move_up")} title={t("agent_plan_move_up")} disabled={locked || index === 0} onClick={() => moveTask(index, -1)} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded text-t4 transition-colors hover:bg-s3 hover:text-t1 disabled:cursor-not-allowed disabled:opacity-40">{Ic.caret("u")}</button>
                          <button type="button" aria-label={t("agent_plan_move_down")} title={t("agent_plan_move_down")} disabled={locked || index === draft.tasks.length - 1} onClick={() => moveTask(index, 1)} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded text-t4 transition-colors hover:bg-s3 hover:text-t1 disabled:cursor-not-allowed disabled:opacity-40">{Ic.caret("d")}</button>
                          <button type="button" aria-label={t("agent_plan_remove")} title={t("agent_plan_remove")} disabled={locked} onClick={() => removeTask(index)} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded text-t4 transition-colors hover:bg-s3 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"><Ic.close /></button>
                        </div>
                      </div>
                      <AutoTextarea aria-label={`${t(labels.taskBody)} ${index + 1}`} value={task.body} disabled={locked} minRows={2} placeholder={t(labels.taskBodyPlaceholder)} onChange={(event) => updateTask(index, { body: event.target.value })} className="mt-2" />
                      {labels.taskBodyHint !== undefined && (
                        <p className="mt-1 font-ui text-[calc(var(--ui-fs)-4px)] leading-relaxed text-t3">{t(labels.taskBodyHint)}</p>
                      )}
                      {/* DK-10 (mockup §6): the when-row — only for a story
                          plan while the clock reads. flex-wrap: the parts
                          control (~420px at the default font) wraps to its
                          own line under the ~524px row budget and on the
                          phone (`wrap mobileFill` — it goes full-width and
                          wraps internally there); no copy is shortened
                          (AD-022). The row label is the mockup's muted
                          sentence-case meta, NOT lblCls (that carries the
                          uppercase above-a-field chrome). */}
                      {whenReady && (
                        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="w-11 shrink-0 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{t("story_plan_when")}</span>
                          <SegmentedControl<WhenMode>
                            ariaLabel={t("story_plan_when")}
                            value={at === undefined ? "undated" : "dated"}
                            options={[
                              { value: "undated", label: t("story_plan_when_undated") },
                              { value: "dated", label: t("story_plan_when_dated") },
                            ]}
                            onChange={(mode) => {
                              if (mode === "dated") {
                                // Assign: the clock's current day anchors the
                                // default; part null = "any time" (the fifth
                                // segment starts selected).
                                const day = storyClock !== null ? storyClock.day : 1;
                                updateTask(index, { at: { day, part: null } });
                              } else {
                                updateTask(index, { at: undefined });
                              }
                            }}
                            disabled={locked}
                          />
                          {at !== undefined && (
                            <>
                              <span className="shrink-0 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{t("story_plan_when_day")}</span>
                              {/* The canon Number primitive (frontend intent
                                  table): hideControls is the compact inline
                                  shape, min={1} carries the day floor, and the
                                  adjacent span is the visible label (the
                                  CharacterForm depth-field convention — no
                                  programmatic aria-label). Left-aligned by the
                                  primitive's hideControls base: an appended
                                  text-center loses the cascade to the baked
                                  text-left (verified against the built
                                  stylesheet order) and custom CSS is banned. */}
                              <NumberInput
                                inputTestId={`agent-plan-when-day-${index}`}
                                min={1}
                                step={1}
                                hideControls
                                value={at.day}
                                disabled={locked}
                                // The blur commit can still parse a fractional
                                // day (4.5) — round it to the block invariant
                                // (integer day >= 1; min carries the floor).
                                onChange={(day) => updateTask(index, { at: { day: Math.max(1, Math.round(day)), part: at.part } })}
                                className="w-full max-w-14 shrink-0"
                              />
                              <SegmentedControl<WhenPartOption>
                                ariaLabel={t("story_plan_when")}
                                value={at.part ?? ANYTIME_PART}
                                options={partOptions}
                                onChange={(part) => {
                                  updateTask(index, { at: { day: at.day, part: part === ANYTIME_PART ? null : part } });
                                }}
                                wrap
                                mobileFill
                                disabled={locked}
                              />
                            </>
                          )}
                        </div>
                      )}
                    </div>
                    );
                  })}
                </div>
                <button type="button" disabled={locked} onClick={() => setDraft((current) => ({ ...current, tasks: [...current.tasks, newTask()] }))} className="mt-2 cursor-pointer font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-colors hover:text-t1 disabled:cursor-not-allowed disabled:opacity-40">{t(labels.addTask)}</button>
              </div>
            </div>
          )}
        </ScrollArea>
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
