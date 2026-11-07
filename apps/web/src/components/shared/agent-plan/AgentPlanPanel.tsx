import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentPlan, AgentPlanTask } from "@vibe-tavern/api-contracts";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import { Ic } from "../icons.js";
import { ScrollArea } from "../scroll-area.js";

export interface AgentPlanPanelProps {
  plan: AgentPlan;
  onOpenEditor: () => void;
  locked: boolean;
  /** DR-9 (mockup §5): "curtain" renders the expanded part as an OVERLAY
   *  below the collapsed row — absolute, the column's full width, max-h-60vh
   *  internal scroll, the `--shadow-md` token, closes on outside click / Esc
   *  / chevron. The row itself is constant, so surrounding content never
   *  shifts. Default "inline" is today's in-flow expansion, byte-identical. */
  presentation?: "inline" | "curtain";
  /** DR-9: extra actions rendered at the end of the collapsed row AND in the
   *  expanded header AFTER the editor button (the story strip's "call the
   *  director" action, wired by DR-11). */
  actions?: ReactNode;
  /** DR-11 (mock §5/§9): actions rendered in the EXPANDED headers BEFORE
   *  the editor button — the story strip's check-now (`story_plan_check_now`). The mock's
   *  interleaved order (check · editor · call) is not expressible through
   *  the trailing `actions` slot, which always lands after the editor
   *  button; this slot fills the gap. While set in curtain mode the header
   *  wraps: the header actions (these + the editor button + `actions`) take
   *  their OWN row on the phone (§9, 44px targets — the wrapper stretches
   *  its children; `md:contents` dissolves the wrapper on desktop, so the
   *  desktop header is exactly §5's one row). Undefined = today's headers,
   *  byte-identical. */
  headerActionsBefore?: ReactNode;
  /** DR-11 (mock §4): while a non-empty string in CURTAIN mode, the
   *  collapsed row shows the flash (`agent_plan_story_flash_done`) on the success tint with the
   *  completed glyph — the passed-check flash the story strip drives for
   *  ~6 s after the tracker's check completes the current event; the count
   *  and chevron stay live (the refreshed plan drives them). */
  flashTitle?: string | null;
  /** DK-9 (mockup §6): the flash's tone — "success" (the DR-11 default, the
   *  completed glyph) or "accent" (the clock-promotion flash
   *  `story_cal_flash_promoted`: the accent tint + the clock glyph). One
   *  tone live per change — the strip decides, never both at once. */
  flashTone?: "success" | "accent";
  /** DR-9: default true — today's editor button in the collapsed row (the
   *  expanded header always carries the button, whatever this says). */
  showEditorInCollapsedRow?: boolean;
  /** DR-9 (R4): renders the revert-to-work button (agent_plan_revert) on
   *  completed events in curtain mode. The handler (AgentPlanSection's)
   *  saves the reverted task as the one active event through the plan
   *  hook's `save` — the editor's write. */
  onRevertTask?: (taskId: string) => void;
  /** DK-6 (mockup §1): the curtain's SECOND header row — the story deck's
   *  tab strip (events/deck/calendar counts, StoryCurtainTabs).
   *  Rendered inside the scroll content right after the first header row;
   *  undefined = nothing rendered (today's curtain, byte-identical). */
  curtainTabs?: ReactNode;
  /** DK-6: replaces the curtain's DEFAULT body (the premise line + the
   *  task list) when set — the deck/calendar tab bodies. Undefined = the
   *  default body (the events tab, byte-identical). */
  curtainBody?: ReactNode;
}

type TaskStatus = AgentPlanTask["status"];

/** The plan's CURRENT task (first `active`, else first `pending`) — the web
 *  twin of the server's `pickCurrentStoryEvent` (story-plan-sync.ts names
 *  this rule G2; later per-event features read ONE derivation). Exported
 *  since DR-10a: the story-plan proposal card picks the event whose body it
 *  shows through the same rule. */
export function pickCurrent(tasks: AgentPlanTask[]): AgentPlanTask | null {
  return tasks.find((task) => task.status === "active") ?? tasks.find((task) => task.status === "pending") ?? null;
}

/** The plan's remaining (pending + active) task count — the collapsed row's
 *  number. Exported since DK-6: the story section's tab row passes THE SAME
 *  derivation as the events tab's muted count (never a second one). */
export function countRemaining(tasks: AgentPlanTask[]): number {
  return tasks.filter((task) => task.status === "pending" || task.status === "active").length;
}

function statusClass(status: TaskStatus): string {
  switch (status) {
    case "active": return "border-accent text-accent";
    case "completed": return "border-success-text text-success-text";
    default: return "border-t4 text-t4";
  }
}

/** The task-status node glyph (pending/active/completed/abandoned circle).
 *  Exported since DR-10a: the story-plan proposal card's event rows render
 *  the same glyph as the plan panel — one derivation. */
export function NodeGlyph({ status }: { status: TaskStatus }) {
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

/** The panel's text-button chrome — the editor button's (`agent_plan_editor`) classes.
 *  Exported since DR-11: the story strip's call-director button composes THE
 *  SAME base (mock §1: "the composed classes of today's editor button
 *  text button + shrink-0 whitespace-nowrap" — the base already carries
 *  `shrink-0`), so the strip's action can never drift from the row's own
 *  button. */
export const agentPlanTextButtonCls =
  "shrink-0 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:text-t1 disabled:cursor-not-allowed disabled:opacity-40";

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={cn("shrink-0 text-t4 transition-transform duration-150", open ? "rotate-180" : "rotate-0")}>
      <polyline points="3 6 8 11 13 6" />
    </svg>
  );
}

/** Pinned, expandable summary of the owner-scoped agent plan (a script's task
 *  plan inline, or a branch's story plan as the DR-9 curtain). */
export function AgentPlanPanel({
  plan,
  onOpenEditor,
  locked,
  presentation = "inline",
  actions,
  headerActionsBefore,
  flashTitle,
  flashTone = "success",
  showEditorInCollapsedRow = true,
  onRevertTask,
  curtainTabs,
  curtainBody,
}: AgentPlanPanelProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const curtain = presentation === "curtain";
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Curtain close paths (mockup §5): outside click and Esc, armed only while
  // the overlay is open — the same armed-while-open listener shape as
  // RichChatRow's branch popover. The chevron toggles through `setOpen`.
  useEffect(() => {
    if (!curtain || !open) return;
    const handlePointerDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [curtain, open]);

  if (plan.tasks.length === 0 && plan.goal === "" && plan.constraints.length === 0) return null;

  const current = pickCurrent(plan.tasks);
  const remaining = countRemaining(plan.tasks);
  const summaryStatus: TaskStatus = current?.status ?? "completed";
  // DR-11 (§4): the passed-check flash — curtain-only by contract (the
  // story strip is its only driver). DK-9 (§6): the same mechanism's second
  // tone — the clock-promotion flash on the accent tint with the clock
  // glyph (mutually exclusive per change: the strip picks the tone).
  const flashing = curtain && typeof flashTitle === "string" && flashTitle !== "";
  const accentFlash = flashing && flashTone === "accent";
  const editorButton = (
    <button
      type="button"
      data-testid="agent-plan-open-editor"
      disabled={locked}
      onClick={onOpenEditor}
      className={agentPlanTextButtonCls}
    >
      {t("agent_plan_editor")}
    </button>
  );

  // Curtain-only (R4): the revert-to-work button on completed events — a
  // 44px touch target on mobile (canon), compact on desktop.
  const revertButton = (task: AgentPlanTask): ReactNode => (
    <button
      type="button"
      data-testid={`agent-plan-revert-${task.id}`}
      disabled={locked}
      onClick={() => onRevertTask?.(task.id)}
      className="ml-1 flex min-h-11 shrink-0 cursor-pointer items-center whitespace-nowrap font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:text-t1 disabled:cursor-not-allowed disabled:opacity-40 md:min-h-0"
    >
      {t("agent_plan_revert")}
    </button>
  );

  const taskList = (withRevert: boolean) => (
    <ol className="flex flex-col">
      {plan.tasks.map((task) => (
        <li key={task.id} data-testid={`agent-plan-task-${task.status}`} className="flex items-start gap-1.5 py-0.5">
          <span className="mt-[1px] flex shrink-0 items-center justify-center"><NodeGlyph status={task.status} /></span>
          <span className="min-w-0 flex-1">
            {/* The MODEL's task titles and the active task's detail —
                page-translatable (owner follow-up 2026-10-24). */}
            <span translate="yes" className={cn("block truncate font-ui text-[calc(var(--ui-fs)-3px)]", task.status === "completed" && "text-success-text line-through", task.status === "abandoned" && "text-t4 line-through", task.status === "active" && "text-t2", task.status === "pending" && "text-t3")}>{task.title}</span>
            {task.status === "active" && task.body && <span translate="yes" className="mt-0.5 block whitespace-pre-wrap font-ui text-[calc(var(--ui-fs)-3px)] text-t4">{task.body}</span>}
          </span>
          {withRevert && task.status === "completed" && onRevertTask !== undefined && revertButton(task)}
        </li>
      ))}
    </ol>
  );

  if (!curtain) {
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
            {/* The current task is the MODEL's plan title — page-translatable
                (owner follow-up 2026-10-24); the count beside it is chrome. */}
            <span translate="yes" className="min-w-0 flex-1 truncate">{current ? current.title : t("agent_plan_done")}</span>
            <span className="shrink-0 tabular-nums text-t4">· {remaining} {t("agent_plan_remaining")}</span>
            <Chevron open={false} />
          </button>
          {showEditorInCollapsedRow && editorButton}
          {actions}
        </div>
      );
    }

    return (
      <div data-testid="agent-plan-panel" data-state="expanded" className="flex min-w-0 shrink-0 flex-col gap-1 border-b border-border bg-surface px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-accent"><Ic.target /></span>
          <span className="text-[calc(var(--ui-fs)-4px)] font-semibold uppercase tracking-[0.06em] text-t4">{t("agent_plan_title")}</span>
          <span className="shrink-0 tabular-nums text-t4">{remaining} {t("agent_plan_remaining")}</span>
          {headerActionsBefore}
          {editorButton}
          {actions}
          <button type="button" onClick={() => setOpen(false)} aria-label={t("agent_plan_collapse")} className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded text-t4 transition-colors hover:bg-s2 hover:text-t2 md:h-5 md:w-5">
            <Chevron open />
          </button>
        </div>
        {taskList(false)}
      </div>
    );
  }

  // ── Curtain presentation (DR-9, mockup §5/§9) ────────────────────────────
  // The collapsed row is CONSTANT (shut or open) — only the absolute overlay
  // is added, so the surrounding layout never shifts. The curtain hangs from
  // the row's bottom edge (`top-full`), full column width, z-30: above the
  // feed it covers, below the shell's Radix popovers (z-[220]) and tooltips.
  return (
    <div data-testid="agent-plan-panel" data-state={open ? "expanded" : "collapsed"} ref={rootRef} className="relative w-full min-w-0 shrink-0">
      <div
        className={cn(
          "flex w-full min-w-0 items-center gap-1.5 border-b border-border px-2 py-1 text-[calc(var(--ui-fs)-3px)] font-medium text-t3",
          // §4's flash row: the SUCCESS or ACCENT tint replaces the surface
          // background (never stacked — bg utilities resolve by stylesheet
          // order, not class-string order; the ternary keeps exactly one
          // live).
          flashing ? (accentFlash ? "bg-accent-dim" : "bg-success-dim") : "bg-surface",
        )}
      >
        <button
          type="button"
          data-testid="agent-plan-toggle"
          onClick={() => setOpen(!open)}
          aria-label={open ? t("agent_plan_collapse") : t("agent_plan_expand")}
          className="group flex min-w-0 flex-1 items-center gap-1.5 text-left transition-colors hover:text-t2"
        >
          {accentFlash
            ? <span className="shrink-0 text-accent"><Ic.clock /></span>
            : <NodeGlyph status={flashing ? "completed" : summaryStatus} />}
          {/* The current task is the MODEL's plan title — page-translatable
              (owner follow-up 2026-10-24); the count beside it is chrome.
              DR-11: the flash label interpolates that same model title, so it
              opts in with the span; the all-done line is the story label
              (§4 story-done label `agent_plan_story_done` — the curtain is the story
              presentation, like the header's story title since DR-9). DK-9
              (§6): the accent tone interpolates the promoted event the same
              way (`story_cal_flash_promoted`). */}
          <span translate="yes" className={cn("min-w-0 flex-1 truncate", flashing && !accentFlash && "text-success-text", accentFlash && "text-accent-t")}>
            {accentFlash
              ? t("story_cal_flash_promoted", { event: flashTitle })
              : flashing
                ? t("agent_plan_story_flash_done", { title: flashTitle })
                : current
                  ? current.title
                  : t(curtain ? "agent_plan_story_done" : "agent_plan_done")}
          </span>
          <span className="shrink-0 tabular-nums text-t4">· {remaining} {t("agent_plan_remaining")}</span>
          <Chevron open={open} />
        </button>
        {showEditorInCollapsedRow && editorButton}
        {actions}
      </div>
      {/* CNR-8h: the open curtain body rides the thin ScrollArea lane (3px
          rest / 5px hover) instead of the native 8px fallback — the cap
          moved onto the ScrollArea root (the curtain itself: same absolute
          §5 geometry, same max-h-[60vh] ceiling) and the gap/padding onto
          the content element so both scroll with the rows. Header, premise
          and task list keep their order; no consumer ever held the old div
          by ref. The lane hides on phones (CNR-7g policy). */}
      {open && (
        <ScrollArea
          scrollbarSize="thin"
          data-testid="agent-plan-curtain"
          className="absolute left-0 right-0 top-full z-30 max-h-[60vh] border-b border-border bg-surface shadow-[var(--shadow-md)]"
          contentClassName="flex flex-col gap-1 px-2 py-1.5"
        >
          <div className={cn("flex items-center gap-1.5", headerActionsBefore !== undefined && "flex-wrap")}>
            <span className="shrink-0 text-accent"><Ic.target /></span>
            <span className="text-[calc(var(--ui-fs)-4px)] font-semibold uppercase tracking-[0.06em] text-t4">{t("agent_plan_story_title")}</span>
            <span className="shrink-0 tabular-nums text-t4">{remaining} {t("agent_plan_remaining")}</span>
            {headerActionsBefore === undefined ? (
              <>
                {editorButton}
                {actions}
              </>
            ) : (
              /* DR-11 (§5/§9): §5's interleaved order — check-now
                 BEFORE the editor button, call-director (the `actions`
                 slot) after it. On the phone (§9) the wrapper's w-full under
                 the wrapped header takes its own row and its stretch default
                 gives every child a 44px target; `md:contents` dissolves the
                 wrapper on desktop so the header is §5's single row (the
                 chevron's ml-auto right-aligns the whole action group). */
              <div data-testid="agent-plan-curtain-header-actions" className="flex w-full shrink-0 gap-4 md:contents">
                {headerActionsBefore}
                {editorButton}
                {actions}
              </div>
            )}
            <button type="button" data-testid="agent-plan-curtain-close" onClick={() => setOpen(false)} aria-label={t("agent_plan_collapse")} className="ml-auto flex h-11 w-11 shrink-0 items-center justify-center rounded text-t4 transition-colors hover:bg-s2 hover:text-t2 md:h-5 md:w-5">
              <Chevron open />
            </button>
          </div>
          {/* DK-6 (§1): the second header row — the story deck's tab strip
              (curtain-only; undefined = nothing, today's curtain). */}
          {curtainTabs}
          {curtainBody === undefined ? (
            <>
              {/* P2 (§5): the premise as one muted line at the top — a
                  reminder for the user; it never reaches the RP model. The
                  goal is model text, so the line opts into page translation. */}
              {plan.goal !== "" && (
                <p data-testid="agent-plan-premise" translate="yes" className="my-1 border-l-2 border-border2 py-0.5 pl-2 font-ui text-[calc(var(--ui-fs)-2px)] leading-normal text-t3">
                  {t("agent_plan_story_premise", { premise: plan.goal })}
                </p>
              )}
              {taskList(true)}
            </>
          ) : (
            /* DK-6: the deck/calendar tab body replaces the default body. */
            curtainBody
          )}
        </ScrollArea>
      )}
    </div>
  );
}
