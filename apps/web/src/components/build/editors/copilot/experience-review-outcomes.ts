import { useCallback, useEffect } from "react";
import { agentThreadKey, type AgentKind } from "../../../../lib/agent-host-registry.js";
import { allReviewHunkIds, type CopilotBufferReview } from "../../../shared/agent-shell/AgentBufferReviewEditor.js";
import { buildExperienceCopilotReviewSnapshot, experienceReviewRoundId } from "../../../../lib/experience-copilot-review-snapshot.js";
import { useAgentReviewOutcomeStore } from "../../../../stores/agent-review-outcome-store.js";

/**
 * The experience review session's OUTCOME-LEDGER family — every helper that
 * writes a buffer's local review outcome into the per-thread
 * `agent-review-outcome-store` (application evidence, reversals, wholesale
 * cancels, supersession retention). Extracted verbatim from
 * `use-experience-copilot-review.ts` when that file crossed the size ratchet
 * (AP-15); behavior is unchanged — the session hook imports this family and
 * calls it from the same call sites.
 */

/** Records a successful local buffer application with all prior applied hunks for the round. */
export function recordExperienceAppliedOutcome({ kind, threadId, target, bufferReview, accepted, dismissed, applied, cancelled = false, replaceApplied = false }: {
  kind: AgentKind;
  threadId: string;
  target: "rules" | "visual";
  bufferReview: CopilotBufferReview;
  accepted: ReadonlySet<number>;
  dismissed: ReadonlySet<number>;
  applied: ReadonlySet<number>;
  cancelled?: boolean;
  /** Reversal paths replace prior local application evidence with surviving hunks. */
  replaceApplied?: boolean;
}): void {
  const prior = useAgentReviewOutcomeStore.getState().outcomesByThread[agentThreadKey(kind, threadId)]?.[target];
  const roundId = experienceReviewRoundId(bufferReview.base, bufferReview.proposed);
  const appliedHunkIds = replaceApplied
    ? new Set(applied)
    : new Set([...(prior?.record.roundId === roundId ? prior.appliedHunkIds : []), ...applied]);
  const [record] = buildExperienceCopilotReviewSnapshot([{
    target,
    base: bufferReview.base,
    proposed: bufferReview.proposed,
    offeredHunkIds: [...allReviewHunkIds(bufferReview)],
    acceptedHunkIds: accepted,
    dismissedHunkIds: dismissed,
    appliedHunkIds,
    cancelled,
  }]).targets;
  if (record) useAgentReviewOutcomeStore.getState().record(kind, threadId, record, [...appliedHunkIds]);
}

/** Binds the host's current thread to successful local application recording. */
export function useExperienceReviewOutcomeRecorder(kind: AgentKind, threadId: string | null) {
  return useCallback((target: "rules" | "visual", bufferReview: CopilotBufferReview, accepted: ReadonlySet<number>, dismissed: ReadonlySet<number>, applied: ReadonlySet<number>, cancelled = false, replaceApplied = false) => {
    if (threadId) recordExperienceAppliedOutcome({ kind, threadId, target, bufferReview, accepted, dismissed, applied, cancelled, replaceApplied });
  }, [kind, threadId]);
}

/** Records a non-application review transition without losing prior local applies. */
export function recordExperienceReviewOutcome({ kind, threadId, target, bufferReview, accepted, dismissed, cancelled = false }: {
  kind: AgentKind;
  threadId: string;
  target: "rules" | "visual";
  bufferReview: CopilotBufferReview;
  accepted: ReadonlySet<number>;
  dismissed: ReadonlySet<number>;
  cancelled?: boolean;
}): void {
  recordExperienceAppliedOutcome({
    kind,
    threadId,
    target,
    bufferReview,
    accepted,
    dismissed,
    applied: new Set(),
    cancelled,
  });
}

/** Marks every active target cancelled before a revert drops its live proposal. */
export function recordExperienceRevertedOutcomes(kind: AgentKind, threadId: string, targets: ReadonlyArray<{
  target: "rules" | "visual";
  review: CopilotBufferReview | null;
  accepted: ReadonlySet<number>;
  dismissed: ReadonlySet<number>;
}>): void {
  for (const { target, review, accepted, dismissed } of targets) {
    if (!review) continue;
    recordExperienceReviewOutcome({
      kind,
      threadId,
      target,
      bufferReview: review,
      accepted,
      dismissed: new Set([...dismissed, ...allReviewHunkIds(review)]),
      cancelled: true,
    });
  }
}

/** Cancels a resolved record when no rendered diff remains to reconstruct it. */
export function cancelStoredExperienceOutcomes(kind: AgentKind, threadId: string, targets: readonly ("rules" | "visual")[]): void {
  const state = useAgentReviewOutcomeStore.getState();
  const outcomes = state.outcomesByThread[agentThreadKey(kind, threadId)] ?? {};
  for (const target of targets) {
    const outcome = outcomes[target];
    if (!outcome) continue;
    state.record(kind, threadId, { ...outcome.record, outcome: "cancelled" }, outcome.appliedHunkIds);
  }
}

/** Retains one replaced target record so the model can identify supersession. */
export function useExperienceReviewSupersession(kind: AgentKind, threadId: string | null, target: "rules" | "visual", base: string | undefined, proposed: string | undefined) {
  useEffect(() => {
    if (!threadId || base === undefined || proposed === undefined) return;
    useAgentReviewOutcomeStore.getState().supersede(kind, threadId, target, experienceReviewRoundId(base, proposed));
  }, [kind, threadId, target, base, proposed]);
}
