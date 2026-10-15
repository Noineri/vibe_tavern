/**
 * Model-facing review outcome lines (REVIEW_OUTCOME_FEEDBACK_PLAN).
 *
 * The single renderer for an agent review snapshot section, shared by the
 * experience copilot context package (`kinds/experience-kind.ts`) and the
 * co-author prompt (`../chat/coauthor-prompt.ts`). An explicit empty snapshot
 * renders a sentence rather than silence (empty ≠ absent); an absent snapshot
 * renders nothing — callers skip the section.
 */
import type { AgentReviewSnapshot, ReviewTargetRecord } from "@vibe-tavern/api-contracts";

const NO_OUTCOMES_LINE = "no unreviewed proposals and no recorded outcomes";

function renderTargetLine(target: ReviewTargetRecord): string {
  const details: string[] = [];
  if (target.hunks !== undefined) {
    details.push(`hunks: accepted ${target.hunks.accepted}, rejected ${target.hunks.rejected}, pending ${target.hunks.pending}`);
  }
  if (target.items !== undefined) {
    details.push(`items: offered ${target.items.offered}, selected ${target.items.selected}, applied ${target.items.applied}`);
  }
  if (target.selected !== undefined) {
    details.push(`selected: ${target.selected ? "yes" : "no"}`);
  }
  if (target.supersededByRound !== undefined) {
    details.push(`superseded by round \`${target.supersededByRound}\``);
  }
  return `- ${target.target} round \`${target.roundId}\`: **${target.outcome}**${details.length > 0 ? ` (${details.join("; ")})` : ""}`;
}

/**
 * How the model must read the records (owner incident 2026-10-13: the model
 * insisted its rejected edits were live). It rides inside the section rather
 * than a base prompt so it reaches users with a customized service prompt, and
 * appears only when there are records to read.
 */
const OUTCOME_GUIDANCE = [
  "These records are authoritative: they report what the user actually did with your earlier proposals, and they override your own memory of what you proposed.",
  "`rejected`, `cancelled` and `superseded` changes are NOT in the editor — never describe them as applied or insist that they are.",
  "`applied-partial` means only the counted accepted hunks or items landed; `awaiting` means the user has not decided yet.",
  "Applied is not saved: an applied change can still be unsaved. The current editor content shown in this prompt is the ground truth — re-read it before proposing follow-up edits.",
] as const;

/** One line per reviewed target, or the explicit no-outcomes sentence. */
function renderReviewOutcomeLines(review: AgentReviewSnapshot): string[] {
  return review.targets.length === 0 ? [NO_OUTCOMES_LINE] : review.targets.map(renderTargetLine);
}

/** The `## Proposal review outcomes` section: heading, reading guidance when records exist, then the records. */
export function renderReviewOutcomeSection(review: AgentReviewSnapshot): string[] {
  return [
    "## Proposal review outcomes",
    ...(review.targets.length > 0 ? OUTCOME_GUIDANCE : []),
    ...renderReviewOutcomeLines(review),
  ];
}
