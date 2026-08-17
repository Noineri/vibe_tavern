import * as Popover from "@radix-ui/react-popover";
import { useMemo, useState } from "react";
import type { ExperienceCopilotThreadWire } from "@vibe-tavern/api-contracts";
import { cn } from "../../../../lib/cn.js";
import { Icons } from "../../../shared/icons.js";
import { formatRelativeTime } from "../../../layout/sidebar-utils.js";
import { SidebarChatRename } from "../../../layout/sections/SidebarChatRename.js";
import { useT } from "../../../../i18n/context.js";

/**
 * ExperienceSessionSwitcher (ER-12b) — the copilot chat-header session dock.
 *
 * A compact header bar that shows the ACTIVE session's label and opens a Radix
 * Popover listing every session for the script: the active one is highlighted
 * + non-clickable, archived ones are dimmed/dated and clickable, a pencil on
 * every row renames inline, and a dashed "+ New session" action sits at the
 * bottom (it archives the current session server-side and starts fresh — see
 * the shell's `handleNewSession`).
 *
 * NUMBERING: untitled sessions display "Session N" where N is the 1-based
 * position in the script's chronological creation order (computed here from
 * `createdAt`; nothing is persisted). A user-set title replaces the number.
 *
 * CONTROLLED and presentational: it owns NO async work and NO session state
 * beyond the local which-row-is-renaming flag. The shell
 * (ExperienceCopilotShell) owns `sessions` / `threadId` and passes them down;
 * `onActivate` / `onNew` / `onRename` are the shell's handlers.
 *
 * `disabled` is the no-mid-stream-switch invariant: the shell passes
 * `ctrl.isSending` so the trigger, every item, and New are inert while a turn
 * is streaming. Switching `threadId` mid-stream would race the in-flight
 * stream's settle-closure (which would overwrite the new view), so the switch
 * path is simply blocked until the turn settles — no controller change needed.
 * The RENAME pencil stays enabled while streaming: it only touches the title,
 * which races nothing.
 */
export interface ExperienceSessionSwitcherProps {
  /** All sessions (active + archived) for the script, newest first. */
  sessions: ExperienceCopilotThreadWire[];
  activeThreadId: string | null;
  /** True while a turn is streaming → block switch/new (see header). */
  disabled?: boolean;
  onActivate: (threadId: string) => void;
  onNew: () => void;
  onRename: (threadId: string, title: string) => void;
}

/** Session label: the stored title when non-empty, else the numbered locale
 *  fallback ("Session N" — N is the creation-order position). */
function sessionLabel(
  session: ExperienceCopilotThreadWire,
  fallback: string,
  number: number | undefined,
): string {
  const trimmed = session.title?.trim();
  if (trimmed) return trimmed;
  return number !== undefined ? `${fallback} ${number}` : fallback;
}

export function ExperienceSessionSwitcher({
  sessions,
  activeThreadId,
  disabled = false,
  onActivate,
  onNew,
  onRename,
}: ExperienceSessionSwitcherProps) {
  const { t } = useT();
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const activeSession = sessions.find((s) => s.id === activeThreadId) ?? null;
  const sessionFallback = t("experience_copilot_session");

  // Auto-numbering map: 1-based position in createdAt order (the shell lists
  // sessions newest-first, so the number is NOT the array index). ISO strings
  // compare lexicographically, matching chronological order.
  const numbersById = useMemo(() => {
    const byCreation = [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const map = new Map<string, number>();
    byCreation.forEach((s, index) => map.set(s.id, index + 1));
    return map;
  }, [sessions]);

  const activeLabel = activeSession
    ? sessionLabel(activeSession, sessionFallback, numbersById.get(activeSession.id))
    : sessionFallback;

  const renameInputCls = cn(
    "w-full rounded-sm border border-border bg-s1 px-1.5 py-0.5 font-ui text-[13px] text-t1",
    "outline-none focus-visible:border-accent-t",
  );

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-testid="copilot-session-switcher-trigger"
          disabled={disabled}
          aria-label={t("experience_copilot_switch_session")}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors",
            "hover:bg-s2 focus-visible:bg-s2",
            "disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent",
          )}
        >
          <Icons.Chat className="h-3.5 w-3.5 shrink-0 text-t3" />
          <span className="min-w-0 flex-1 truncate font-ui text-[13px] text-t1">{activeLabel}</span>
          <Icons.Caret direction="d" className="h-3 w-3 shrink-0 text-t3" />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          className="glass-blur z-[301] flex w-[260px] flex-col overflow-hidden rounded-lg border border-border bg-glass-bg shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none"
        >
          <div className="flex max-h-[280px] flex-col overflow-y-auto p-1">
            {sessions.map((session) => {
              const isActive = session.id === activeThreadId;
              const isArchived = session.archivedAt !== null;
              const label = sessionLabel(session, sessionFallback, numbersById.get(session.id));
              const date = formatRelativeTime(session.updatedAt);
              const isRenaming = renamingId === session.id;

              const row = isRenaming ? (
                <SidebarChatRename
                  // Seed with the DISPLAY label: Enter-unchanged aborts (the
                  // auto number is not a stored title), typing replaces it.
                  initialValue={label}
                  className={renameInputCls}
                  onCommit={(next) => {
                    setRenamingId(null);
                    onRename(session.id, next);
                  }}
                  onCancel={() => setRenamingId(null)}
                />
              ) : (
                <>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate",
                        isActive ? "font-medium text-accent-t" : "text-t1",
                        isArchived && !isActive && "text-t3",
                      )}
                    >
                      {label}
                    </span>
                    {isActive && <Icons.Check className="h-3.5 w-3.5 shrink-0 text-accent-t" />}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-t4">
                    {date && <span className="shrink-0 tabular-nums">{date}</span>}
                    {isArchived && (
                      <>
                        {date && <span className="shrink-0 text-t4">·</span>}
                        <span className="shrink-0 text-t4">{t("experience_copilot_archived")}</span>
                      </>
                    )}
                  </div>
                </>
              );

              // Shared shell: relative wrapper + absolutely-positioned pencil.
              // The pencil must NOT nest inside the row <button> (a button in a
              // button is invalid HTML and drops clicks) — it overlays the row's
              // right edge, and `pr-9` keeps the label from running under it.
              // The pencil stays enabled while streaming: renaming races nothing.
              const pencil = isRenaming ? null : (
                <button
                  type="button"
                  data-testid={`copilot-session-rename-${session.id}`}
                  aria-label={t("experience_copilot_rename_session")}
                  onClick={(event) => {
                    event.stopPropagation();
                    setRenamingId(session.id);
                  }}
                  className="absolute right-1.5 top-2 z-[1] shrink-0 rounded-sm p-1 text-t4 transition-colors hover:bg-s1 hover:text-t1 focus-visible:bg-s1 focus-visible:text-t1"
                >
                  <Icons.Edit className="h-3 w-3" />
                </button>
              );

              if (isActive) {
                // The active session is a selection indicator, not a switch
                // target — rendered as a non-interactive row.
                return (
                  <div
                    key={session.id}
                    data-testid={`copilot-session-${session.id}`}
                    data-active="true"
                    data-archived={isArchived ? "true" : "false"}
                    className="relative mx-0.5 flex flex-col rounded-md bg-accent-dim px-2.5 py-1.5 pr-9"
                  >
                    {row}
                    {pencil}
                  </div>
                );
              }

              return (
                <div
                  key={session.id}
                  className="relative mx-0.5 rounded-md transition-colors hover:bg-s2 focus-within:bg-s2"
                >
                  <button
                    type="button"
                    data-testid={`copilot-session-${session.id}`}
                    data-active="false"
                    data-archived={isArchived ? "true" : "false"}
                    disabled={disabled}
                    onClick={() => {
                      if (disabled) return;
                      onActivate(session.id);
                    }}
                    className="flex w-full flex-col rounded-md px-2.5 py-1.5 pr-9 text-left transition-colors focus-visible:bg-s2 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
                  >
                    {row}
                  </button>
                  {pencil}
                </div>
              );
            })}
          </div>

          <button
            type="button"
            data-testid="copilot-session-new"
            disabled={disabled}
            onClick={() => {
              if (disabled) return;
              onNew();
            }}
            className="flex shrink-0 items-center gap-2 border-t border-border px-2.5 py-2 text-left font-ui text-[12.5px] text-t2 transition-colors hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
          >
            <Icons.Plus className="h-3.5 w-3.5 shrink-0 text-accent-t" />
            <span className="truncate">{t("experience_copilot_new_session")}</span>
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
