import { memo } from "react";
import { cn } from "../../../../lib/cn.js";
import type { ExperienceCopilotToolActivity } from "../../../../stores/experience-copilot-turn-store.js";
import { Icons } from "../../../shared/icons.js";
import { useT } from "../../../../i18n/context.js";

/**
 * Experience-copilot turn shell (ER-11c; CD-7 simplified to a live audit
 * feed). Props-driven: the shell (ER-11d) owns the two-buffer state; this
 * component renders the ACTIVE turn's tool-activity cards as compact audit
 * rows (status icon + summary + target badge) while the turn streams.
 *
 * The REVIEWING surface moved to the editor (CD-5/CD-6): the word-diff preview
 * and the Apply button that used to live here are gone — the inline diff with
 * per-hunk accept lives in `ExperienceCopilotEditorPanel` now, and settled
 * turns persist as history audit cards (CD-1,
 * `ExperienceCopilotMessageList`). This component keeps only the glanceable
 * live progress of the current turn.
 *
 * Fork of `CoauthorTurnShell`'s card chrome, adapted to the copilot's
 * two-buffer data shapes. Copilot activity has NO `greetingIndex` / `isAdd` /
 * `loreBundle` (those are co-author-only); the proposal triple is
 * `target ∈ {"rules", "visual"}` + `proposed` + `summary`.
 */
export interface ExperienceCopilotTurnShellProps {
  activities: ExperienceCopilotToolActivity[];
}

export const ExperienceCopilotTurnShell = memo(function ExperienceCopilotTurnShell({
  activities,
}: ExperienceCopilotTurnShellProps) {
  if (activities.length === 0) return null;

  return (
    <div
      data-testid="copilot-turn-shell-block"
      className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-surface p-2"
    >
      {activities.map((activity) => (
        <LiveActivityRow key={activity.toolCallId} activity={activity} />
      ))}
    </div>
  );
});

function LiveActivityRow({ activity }: { activity: ExperienceCopilotToolActivity }) {
  const { t } = useT();
  const isRead = activity.readPath !== undefined;
  const isProposal = activity.target !== undefined && activity.proposed !== undefined;
  const streaming = activity.status === "streaming";
  const errored = activity.status === "error";
  const targetText =
    activity.target === "rules" ? t("experience_copilot_rules") : t("experience_copilot_visual");

  const statusIcon = isRead ? (
    <Icons.FileText />
  ) : errored ? (
    <Icons.Close />
  ) : streaming ? (
    <Icons.Wrench />
  ) : (
    <Icons.Check />
  );
  const statusClass = errored ? "text-danger-text" : streaming ? "text-t3" : "text-success-text";

  // A read's meaningful label is the path; proposals/informational cards use
  // the model-supplied summary (commit-message label), falling back to the
  // tool name / target.
  const title = isRead
    ? activity.readPath!
    : activity.summary?.trim() || (isProposal ? targetText : activity.toolName);

  return (
    <div className="overflow-hidden rounded-md">
      <div
        data-testid="copilot-activity-card"
        data-tool={activity.toolName}
        {...(activity.target ? { "data-target": activity.target } : {})}
        className={cn(
          "flex min-w-0 items-center gap-1.5 px-2 py-1.5 font-ui text-[11px] font-medium tracking-[0.03em]",
          errored ? "text-danger-text" : "text-t2",
        )}
      >
        <span className={statusClass}>{statusIcon}</span>
        <span className="min-w-0 truncate">{title}</span>
        {isProposal && (
          <span
            data-testid="copilot-activity-target"
            className="ml-1 shrink-0 rounded-full bg-accent/15 px-1.5 py-px font-ui text-[10px] text-accent"
          >
            {targetText}
          </span>
        )}
        {streaming && <span className="italic text-t3">…</span>}
      </div>
      {errored && (
        <div className="px-3 py-1.5 font-ui text-[11px] text-danger-text">
          {t("experience_copilot_tool_failed")}
        </div>
      )}
    </div>
  );
}
