/**
 * CopilotTodoPanel (TAG-8) — the pinned, expandable step-plan panel in the
 * copilot chat tab, mounted DIRECTLY BELOW `ExperienceContextMeter` in
 * `ExperienceCopilotShell`. It is the ONLY renderer of the model's todo plan
 * («управляет только модель»): strictly read-only UI — no status cycling, no
 * editing, no user affordances of any kind.
 *
 * Data: `items` is a CONTROLLED prop derived by the shell from the turn
 * store's session-scoped `todoByThread[threadId]` (TAG-7; seeded from the
 * thread wire on mount/switch, live-updated by `todo` tool calls). Lifetime =
 * the copilot session («время жизни туду должно быть на всю сессию») — the
 * panel reappears after reloads because the store is re-seeded from the
 * thread row; `clearTurn` deliberately never touches it.
 *
 * Hidden until the model's first `todo` call ever (empty list → null).
 * Collapse/expand is a per-mount UI toggle held in LOCAL state only — it is
 * not session data, so nothing is persisted.
 *
 * Visual language is borrowed from the RP objective tracker
 * (`components/chat/message-slots/objective-zone.tsx`, quote д «можно взять
 * иконки от трекера целей»): the NodeGlyph circle per status (active = accent
 * ring + filled dot — here PULSING as the "current goal" live indicator;
 * completed = success + check; abandoned/pending = muted ring, abandoned with
 * close), `Ic.target` header, the inline Chevron. The collapsed format is the
 * verbatim «"Текущая цельнейм (кружок)"/(число оставшихся целей)»:
 * [glyph] current-title · N, where N counts the REMAINING goals
 * (pending + active — abandoned is given up, not remaining). The expanded
 * list is the full ordered plan («"текущая цельнейм" "следующие цельнейм"»).
 */
import { useState } from "react";
import type { CopilotTodoItem } from "@vibe-tavern/api-contracts";
import { cn } from "../../../../lib/cn.js";
import { Ic } from "../../../shared/icons.js";
import { CustomTooltip } from "../../../shared/Tooltip.js";
import { useT } from "../../../../i18n/context.js";

export interface CopilotTodoPanelProps {
  /** The model's current full step plan for this thread (full-list rewrite
   *  semantics). Empty → the panel renders nothing (pre-first-`todo`-call). */
  items: readonly CopilotTodoItem[];
}

type TodoStatus = CopilotTodoItem["status"];

/** The "current" goal: the item the model marked `active`, else the first
 *  still-pending one (mirrors ObjectiveService.pickActiveTask). Null when the
 *  plan is fully resolved (everything completed/abandoned). */
function pickCurrent(items: readonly CopilotTodoItem[]): CopilotTodoItem | null {
  return items.find((i) => i.status === "active") ?? items.find((i) => i.status === "pending") ?? null;
}

/** Remaining goals (verbatim «число оставшихся целей»): pending + active.
 *  Abandoned is given up, not remaining; completed is done. */
function countRemaining(items: readonly CopilotTodoItem[]): number {
  return items.filter((i) => i.status === "pending" || i.status === "active").length;
}

function statusClass(status: TodoStatus): string {
  switch (status) {
    case "active":
      return "border-accent text-accent";
    case "completed":
      return "border-success-text text-success-text";
    case "abandoned":
      return "border-t4 text-t4";
    default:
      return "border-t4 text-t4";
  }
}

/** Compact status glyph — the objective tracker's NodeGlyph, with the active
 *  dot PULSING as the "this is the current goal" live indicator. */
function NodeGlyph({ status }: { status: TodoStatus }) {
  return (
    <span
      data-testid={`copilot-todo-glyph-${status}`}
      className={cn("flex h-3 w-3 shrink-0 items-center justify-center rounded-full border [&_svg]:h-[7px] [&_svg]:w-[7px]", statusClass(status))}
    >
      {status === "active" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {status === "completed" && <Ic.check />}
      {status === "abandoned" && <Ic.close />}
    </span>
  );
}

/** Inline chevron — the same glyph objective-zone draws (no shared chevron
 *  icon exists in icons.tsx). Rotates with `open`. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0 text-t4 transition-transform duration-150", open ? "rotate-180" : "rotate-0")}
    >
      <polyline points="3 6 8 11 13 6" />
    </svg>
  );
}

export function CopilotTodoPanel({ items }: CopilotTodoPanelProps) {
  const { t } = useT();
  // Per-mount UI toggle only — NOT session data (see the file header).
  const [open, setOpen] = useState(false);

  // Hidden until the model's first `todo` call on this thread.
  if (items.length === 0) return null;

  const current = pickCurrent(items);
  const remaining = countRemaining(items);
  const summaryStatus: TodoStatus = current?.status ?? "completed";

  // ── Collapsed: one-line summary «"Текущая цельнейм (кружок)" / N» — click
  // anywhere to expand (objective-zone's collapsed pattern). ──
  if (!open) {
    return (
      <CustomTooltip content={t("copilot_todo_expand")}>
        <button
          type="button"
          data-testid="copilot-todo-panel"
          data-state="collapsed"
          onClick={() => setOpen(true)}
          aria-label={t("copilot_todo_expand")}
          className={cn(
            "group flex w-full min-w-0 shrink-0 items-center gap-1.5 border-b border-border bg-surface px-2 py-1",
            "text-left text-[11px] font-medium text-t3 transition-colors hover:text-t2",
          )}
        >
          <NodeGlyph status={summaryStatus} />
          <span className="min-w-0 flex-1 truncate">
            {current ? current.title : t("copilot_todo_done")}
          </span>
          <span className="shrink-0 tabular-nums text-t4">· {remaining}</span>
          <Chevron open={false} />
        </button>
      </CustomTooltip>
    );
  }

  // ── Expanded: Ic.target header + the full ordered list, read-only rows. ──
  return (
    <div
      data-testid="copilot-todo-panel"
      data-state="expanded"
      className="flex min-w-0 shrink-0 flex-col gap-1 border-b border-border bg-surface px-2 py-1.5"
    >
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-accent"><Ic.target /></span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-t4">{t("copilot_todo_title")}</span>
        <span className="shrink-0 tabular-nums text-t4">{remaining}</span>
        <CustomTooltip content={t("copilot_todo_collapse")}>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label={t("copilot_todo_collapse")}
            className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded text-t4 transition-colors hover:bg-s2 hover:text-t2 md:h-5 md:w-5"
          >
            <Chevron open />
          </button>
        </CustomTooltip>
      </div>
      <ol className="flex flex-col">
        {items.map((item, index) => (
          <li
            key={`${index}-${item.title}`}
            data-testid={`copilot-todo-item-${item.status}`}
            className="flex items-start gap-1.5 py-0.5"
          >
            <span className="mt-[1px] flex shrink-0 items-center justify-center">
              <NodeGlyph status={item.status} />
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 truncate font-ui text-[11px]",
                item.status === "completed" && "text-success-text line-through",
                item.status === "abandoned" && "text-t4 line-through",
                item.status === "active" && "text-t2",
                item.status === "pending" && "text-t3",
              )}
            >
              {item.title}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
