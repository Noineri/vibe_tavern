import { memo, useMemo, useState } from "react";
import { cn } from "../../../../lib/cn.js";
import type { ExperienceCopilotToolActivity } from "../../../../stores/experience-copilot-turn-store.js";
import {
  aggregateExperienceCopilotProposal,
  buildExperienceCopilotApplyPatch,
  type ExperienceCopilotApplyPatch,
} from "../../../../lib/experience-copilot-apply.js";
import { buildWordDiff, TextDiffPreview } from "../../../shared/TextDiffPreview.js";
import { AnimatedDisclosure } from "../../../shared/AnimatedDisclosure.js";
import { Icons } from "../../../shared/icons.js";
import { useT } from "../../../../i18n/context.js";

/**
 * Experience-copilot turn shell (ER-11c). Props-driven: the shell (ER-11d)
 * owns the two-buffer state and the Apply commit; this component renders the
 * active turn's tool-activity cards + the Apply affordance.
 *
 * Fork of `CoauthorTurnShell`/`CoauthorToolActivitySlot`, adapted to the
 * copilot's two-buffer data shapes. Copilot activity has NO `greetingIndex` /
 * `isAdd` / `loreBundle` (those are co-author-only); the proposal triple is
 * `target ∈ {"rules", "visual"}` + `proposed` + `summary`.
 *
 * Activity shapes:
 *  - `read_skill_file` → glanceable read card showing `readPath` (no diff).
 *  - `write_buffer` / `edit_buffer` → target + summary + an intra-line diff of
 *    base → proposed (word-level, via the shared `TextDiffPreview`).
 *  - `run_test` / `run_simulate` / `suggest_visual_binding` → informational
 *    summary only (no diff).
 */
export interface ExperienceCopilotTurnShellProps {
  activities: ExperienceCopilotToolActivity[];
  /** Canonical rules buffer text (the diff's "before" side). */
  baseRules: string;
  /** Canonical visual buffer text (the diff's "before" side). */
  baseVisual: string;
  /** Commits the proposed buffers (only the buffers the model proposed). */
  onApply: (patch: ExperienceCopilotApplyPatch) => void;
}

export const ExperienceCopilotTurnShell = memo(function ExperienceCopilotTurnShell({
  activities,
  baseRules,
  baseVisual,
  onApply,
}: ExperienceCopilotTurnShellProps) {
  const { t } = useT();
  const proposal = useMemo(() => aggregateExperienceCopilotProposal(activities), [activities]);

  // Track the last-applied proposal so the button reflects an "applied" state.
  // Keyed by the proposed content so a NEW proposal (the model's multi-step
  // loop) re-enables the button automatically.
  const proposalKey = proposal.hasProposal
    ? `${proposal.proposedRules ?? ""}\u0000${proposal.proposedVisual ?? ""}`
    : null;
  const [appliedKey, setAppliedKey] = useState<string | null>(null);
  const applied = appliedKey !== null && appliedKey === proposalKey;

  const apply = () => {
    if (!proposal.hasProposal) return;
    const merged: ExperienceCopilotApplyPatch = {
      ...(proposal.proposedRules !== undefined ? { rules: proposal.proposedRules } : {}),
      ...(proposal.proposedVisual !== undefined ? { visual: proposal.proposedVisual } : {}),
    };
    onApply(buildExperienceCopilotApplyPatch(merged, proposal));
    setAppliedKey(proposalKey);
  };

  if (activities.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-surface p-2">
      {activities.map((activity) => (
        <ExperienceCopilotActivityCard
          key={activity.toolCallId}
          activity={activity}
          baseRules={baseRules}
          baseVisual={baseVisual}
        />
      ))}

      <div className="flex items-center justify-end gap-2 border-t border-border/50 pt-2">
        <button
          type="button"
          data-testid="copilot-apply-btn"
          disabled={!proposal.hasProposal || applied}
          onClick={apply}
          className={cn(
            "cursor-pointer rounded-[5px] bg-accent px-3 py-[5px] font-ui text-xs font-medium text-on-accent transition-all duration-100 hover:brightness-110",
            "disabled:cursor-default disabled:opacity-45 disabled:filter-none",
          )}
        >
          {applied ? t("experience_copilot_applied") : t("experience_copilot_apply")}
        </button>
      </div>
    </div>
  );
});

function ExperienceCopilotActivityCard({
  activity,
  baseRules,
  baseVisual,
}: {
  activity: ExperienceCopilotToolActivity;
  baseRules: string;
  baseVisual: string;
}) {
  const { t } = useT();
  const isRead = activity.readPath !== undefined;
  const isProposal = activity.target !== undefined && activity.proposed !== undefined;
  const [open, setOpen] = useState(false);
  const targetText =
    activity.target === "rules" ? t("experience_copilot_rules") : t("experience_copilot_visual");
  const streaming = activity.status === "streaming";
  const errored = activity.status === "error";

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
  // the model-supplied summary (commit-message label), falling back to the tool
  // name / target.
  const title = isRead
    ? activity.readPath!
    : activity.summary?.trim() || (isProposal ? targetText : activity.toolName);

  // Only proposal + informational cards expand; reads have no preview (the path
  // IS the label; the file content is intentionally not surfaced) and streaming
  // placeholders aren't interactive.
  const expandable = !isRead && !streaming;

  const base = isProposal ? (activity.target === "rules" ? baseRules : baseVisual) : "";

  return (
    <div className="overflow-hidden rounded-md">
      <button
        type="button"
        data-testid="copilot-activity-card"
        data-tool={activity.toolName}
        {...(activity.target ? { "data-target": activity.target } : {})}
        disabled={streaming}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded px-2 py-1.5 text-left font-ui text-[11px] font-medium tracking-[0.03em] text-t2 transition-colors duration-100 hover:bg-s2/50 hover:text-t1 disabled:cursor-default"
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
        {expandable && (
          <span className="ml-auto text-t3">
            {open ? <Icons.Caret direction="u" /> : <Icons.Caret direction="d" />}
          </span>
        )}
      </button>

      {errored && (
        <div className="px-3 py-1.5 font-ui text-[11px] text-danger-text">{t("experience_copilot_tool_failed")}</div>
      )}

      <AnimatedDisclosure open={expandable && open}>
        <div className="ml-2 mt-1 max-h-48 overflow-auto border-l-2 border-border/50 px-3 py-2">
          {isProposal ? (
            <TextDiffPreview
              granularity="word"
              summary={buildWordDiff(base, activity.proposed!)}
              labels={{
                title: t("experience_copilot_proposed"),
                tooLarge: t("experience_copilot_diff_too_large"),
                noChanges: t("experience_copilot_no_changes"),
              }}
            />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-msg-t2">
              {activity.summary ?? ""}
            </pre>
          )}
        </div>
      </AnimatedDisclosure>
    </div>
  );
}
