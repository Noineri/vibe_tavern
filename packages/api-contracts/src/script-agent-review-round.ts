/** Script review uses native code activities and the existing rules slot for
 * its ONE buffer's snapshots/keys/hunks/dangling. Never relabel tool outputs. */
import type { AgentToolActivity, AgentReviewRound, AgentReviewEnvelope, AgentDanglingCapture } from "./schemas/agent-review-round-schema.js";
import { appendAgentReviewSnapshot, createEmptyAgentReviewRound, ensureAgentReviewKey, finalizeBufferReviewActivities } from "./agent-review-round.js";

/** The script host's existing last-wins aggregation, including empty code. */
export function aggregateScriptAgentCodeProposal(activities: readonly AgentToolActivity[]): string | undefined {
  let last: string | undefined;
  for (const activity of activities) {
    if (activity.status === "done" && activity.target === "code" && typeof activity.proposed === "string") last = activity.proposed;
  }
  return last;
}

export function captureScriptAgentReviewProposal(activities: readonly AgentToolActivity[], round: AgentReviewRound | null, code: string): AgentDanglingCapture | null {
  const live = aggregateScriptAgentCodeProposal(activities);
  const proposed = live ?? round?.dangling?.rules;
  if (proposed === undefined) return null;
  const base = live !== undefined ? round?.snapshots.at(-1)?.rules : round?.dangling?.baseRules;
  return { rules: proposed, baseRules: base ?? code, baseVisual: "" };
}

/** Like the experience transition, null means no producer write, not deletion. */
export function buildScriptAgentReviewEnvelope(previous: AgentReviewEnvelope | null, activities: readonly AgentToolActivity[], code: string): AgentReviewEnvelope | null {
  const finalized = finalizeBufferReviewActivities(activities, "script");
  if (finalized.length === 0) return null;
  let round = previous?.round ?? createEmptyAgentReviewRound();
  const dangling = captureScriptAgentReviewProposal(previous?.activities ?? [], round, code);
  if (dangling) round = { ...round, dangling };
  round = appendAgentReviewSnapshot(round, { rules: code, visual: "" });
  round = ensureAgentReviewKey(round, "rules", `${code}\0${aggregateScriptAgentCodeProposal(finalized)!}`);
  return { _v: 2, activities: finalized, round };
}
