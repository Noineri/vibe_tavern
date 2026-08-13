import * as Popover from "@radix-ui/react-popover";
import type { ExperienceCopilotThreadWire } from "@vibe-tavern/api-contracts";
import { cn } from "../../../../lib/cn.js";
import { Icons } from "../../../shared/icons.js";
import { formatRelativeTime } from "../../../layout/sidebar-utils.js";
import { useT } from "../../../../i18n/context.js";

/**
 * ExperienceSessionSwitcher (ER-12b) — the copilot chat-header session dock.
 *
 * A compact header bar that shows the ACTIVE session's title (or a locale
 * "Session" fallback) and opens a Radix Popover listing every session for the
 * script: the active one is highlighted + non-clickable, archived ones are
 * dimmed/dated and clickable, and a dashed "+ New session" action sits at the
 * bottom (it archives the current session server-side and starts fresh — see
 * the shell's `handleNewSession`).
 *
 * CONTROLLED and presentational: it owns NO async work and NO session state.
 * The shell (ExperienceCopilotShell) owns `sessions` / `threadId` and passes
 * them down; `onActivate` / `onNew` are the shell's switch/new handlers.
 *
 * `disabled` is the no-mid-stream-switch invariant: the shell passes
 * `ctrl.isSending` so the trigger, every item, and New are inert while a turn
 * is streaming. Switching `threadId` mid-stream would race the in-flight
 * stream's settle-closure (which would overwrite the new view), so the switch
 * path is simply blocked until the turn settles — no controller change needed.
 */
export interface ExperienceSessionSwitcherProps {
  /** All sessions (active + archived) for the script, newest first. */
  sessions: ExperienceCopilotThreadWire[];
  activeThreadId: string | null;
  /** True while a turn is streaming → block switch/new (see header). */
  disabled?: boolean;
  onActivate: (threadId: string) => void;
  onNew: () => void;
}

/** Session label: the stored title when non-empty, else the locale fallback. */
function sessionLabel(session: ExperienceCopilotThreadWire, fallback: string): string {
  const trimmed = session.title?.trim();
  return trimmed ? trimmed : fallback;
}

export function ExperienceSessionSwitcher({
  sessions,
  activeThreadId,
  disabled = false,
  onActivate,
  onNew,
}: ExperienceSessionSwitcherProps) {
  const { t } = useT();

  const activeSession = sessions.find((s) => s.id === activeThreadId) ?? null;
  const sessionFallback = t("experience_copilot_session");
  const activeLabel = activeSession ? sessionLabel(activeSession, sessionFallback) : sessionFallback;

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
              const label = sessionLabel(session, sessionFallback);
              const date = formatRelativeTime(session.updatedAt);

              const row = (
                <>
                  <div className="flex min-w-0 items-center gap-2">
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

              if (isActive) {
                // The active session is a selection indicator, not a switch
                // target — rendered as a non-interactive row.
                return (
                  <div
                    key={session.id}
                    data-testid={`copilot-session-${session.id}`}
                    data-active="true"
                    data-archived={isArchived ? "true" : "false"}
                    className="mx-0.5 flex flex-col rounded-md bg-accent-dim px-2.5 py-1.5"
                  >
                    {row}
                  </div>
                );
              }

              return (
                <button
                  key={session.id}
                  type="button"
                  data-testid={`copilot-session-${session.id}`}
                  data-active="false"
                  data-archived={isArchived ? "true" : "false"}
                  disabled={disabled}
                  onClick={() => {
                    if (disabled) return;
                    onActivate(session.id);
                  }}
                  className="mx-0.5 flex flex-col rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-s2 focus-visible:bg-s2 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
                >
                  {row}
                </button>
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
