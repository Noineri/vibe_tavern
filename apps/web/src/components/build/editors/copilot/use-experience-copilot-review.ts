import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { ExperienceCopilotLaunchContext, ReviewTargetRecord } from "@vibe-tavern/api-contracts";
import { agentThreadKey, type AgentHostBridge, type AgentKind } from "../../../../lib/agent-host-registry.js";
import type { CopilotDigest } from "../../../../lib/experience-copilot-digest.js";
import type { CopilotBufferReview } from "../../../shared/agent-shell/AgentBufferReviewEditor.js";
import type { TFunc } from "../../../../i18n/locale-helpers.js";
import { useCopilotReviewState } from "../../../../hooks/use-copilot-review-state.js";
import { useAgentTurnStore, type AgentToolActivity } from "../../../../stores/agent-turn-store.js";
import { syncPersistedCopilotRound } from "../../../../lib/experience-copilot-draft.js";
import { EMPTY_REVIEW_ROUND, useAgentReviewRoundStore } from "../../../../stores/agent-review-store.js";
import { useShallow } from "zustand/react/shallow";
import type { AgentSendOptions } from "../../../shared/agent-shell/use-agent-controller.js";
import {
  allReviewHunkIds,
  applyHunksToBuffer,
  buildBufferReview,
  mergedReviewText,
} from "../../../shared/agent-shell/AgentBufferReviewEditor.js";
import { mergeSelectedBody } from "../../../../lib/coauthor-hunk-merge.js";
import { revertHunksFromBuffer } from "../../../shared/agent-shell/AgentBufferReviewEditor.js";
import { buildExperienceCopilotReviewSnapshot, experienceReviewRoundId } from "../../../../lib/experience-copilot-review-snapshot.js";
import { useAgentReviewOutcomeStore } from "../../../../stores/agent-review-outcome-store.js";
import { validateVisualSource } from "../../../../lib/visual-source-validator.js";
import { toast } from "sonner";

/** Stable empty fallback avoids a fresh selector array every host render. */
const EMPTY_ACTIVITIES: readonly AgentToolActivity[] = [];

/** Cohesive host extraction: turn-local review feedback sent alongside a turn. */
export function useExperienceCopilotReviewFeedback({
  bridge,
  onCopied,
}: {
  bridge: AgentHostBridge;
  onCopied: () => void;
}) {
  // ER-14: the latest test/simulate digest the user sent back from the test
  // panel (set by `handleSendToCopilot`). Carried on EVERY subsequent copilot
  // send as `testFeedback` (survives history compaction as a system-level JSON
  // context section), so a manual follow-up also carries it.
  const [testFeedback, setTestFeedback] = useState<Record<string, unknown> | undefined>(undefined);
  // The playground reports its live launch configuration into a ref: changes
  // never re-render the pane, while every send reads the freshest context.
  const launchContextRef = useRef<ExperienceCopilotLaunchContext | undefined>(undefined);
  const handleLaunchContextChange = useCallback((context: ExperienceCopilotLaunchContext) => {
    launchContextRef.current = context;
  }, []);
  // ER-14: copy a test/simulate/playground digest into the copilot chat input.
  // UX 2026-08-16 remark 6: this must NOT dispatch the turn — the button copies
  // the digest text into the input (through the shell bridge) and the user
  // sends it themselves. The structured `feedback` is captured now so the next
  // manual send carries it.
  const handleSendToCopilot = useCallback(
    (digest: CopilotDigest) => {
      setTestFeedback(digest.feedback);
      bridge.setInputPrefill({ text: digest.text });
      onCopied();
    },
    [bridge, onCopied],
  );
  return { testFeedback, launchContextRef, handleLaunchContextChange, handleSendToCopilot };
}

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

/** Resolves a cancelled round against the actual buffer, retaining unanchored applies. */
export function cancelExperienceReviewHunks({ bufferReview, prevAccepted, prevDismissed, bufferText, setAccepted, setDismissed, onChange }: {
  bufferReview: CopilotBufferReview;
  prevAccepted: ReadonlySet<number>;
  prevDismissed: ReadonlySet<number>;
  bufferText: string;
  setAccepted: (next: Set<number>) => void;
  setDismissed: (next: Set<number>) => void;
  onChange: (text: string) => void;
}): { accepted: Set<number>; dismissed: Set<number>; skippedCount: number; cancelled: boolean } {
  const offered = allReviewHunkIds(bufferReview);
  if (!bufferReview.diff) {
    const dismissed = new Set([...prevDismissed, ...offered]);
    setAccepted(new Set());
    setDismissed(dismissed);
    return { accepted: new Set(), dismissed, skippedCount: 0, cancelled: false };
  }
  const acceptedIds = [...offered].filter((id) => prevAccepted.has(id));
  if (bufferText === mergedReviewText(bufferReview, prevAccepted)) {
    if (acceptedIds.length > 0) onChange(mergeSelectedBody(bufferReview.diff, new Set()));
    const dismissed = new Set([...prevDismissed, ...offered]);
    setAccepted(new Set());
    setDismissed(dismissed);
    return { accepted: new Set(), dismissed, skippedCount: 0, cancelled: acceptedIds.length > 0 };
  }
  const { text, skippedHunkIds } = revertHunksFromBuffer(bufferText, bufferReview.diff, bufferReview.hunks, new Set(acceptedIds));
  const reverted = acceptedIds.filter((id) => !skippedHunkIds.includes(id));
  if (reverted.length > 0) onChange(text);
  const accepted = new Set(skippedHunkIds.filter((id) => prevAccepted.has(id)));
  const dismissed = new Set([...prevDismissed, ...offered].filter((id) => !accepted.has(id)));
  setAccepted(accepted);
  setDismissed(dismissed);
  return { accepted, dismissed, skippedCount: skippedHunkIds.length, cancelled: acceptedIds.length > 0 && accepted.size === 0 };
}

/** Validates the effective review document rather than a stale live buffer. */
export function useExperienceCopilotVisualValidation(review: CopilotBufferReview | null, visualSource: string) {
  return useMemo(() => validateVisualSource(review ? review.proposed : visualSource), [review, visualSource]);
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

/** XU-6: the creation stepper in the parent mirrors the shell's current
 * authoring position. `appearance` maps to the Visual code buffer; `try` to
 * the inline sandbox tab; anything else is Rules. */
export function useExperienceCopilotStep(editorBuffer: string, codeBuffer: string, onStepChange: ((step: "rules" | "appearance" | "try") => void) | undefined) {
  const step = editorBuffer === "sandbox" ? "try" : codeBuffer === "visual" ? "appearance" : "rules";
  useEffect(() => {
    onStepChange?.(step);
  }, [step, onStepChange]);
  return step;
}

/** Retains one replaced target record so the model can identify supersession. */
export function useExperienceReviewSupersession(kind: AgentKind, threadId: string | null, target: "rules" | "visual", base: string | undefined, proposed: string | undefined) {
  useEffect(() => {
    if (!threadId || base === undefined || proposed === undefined) return;
    useAgentReviewOutcomeStore.getState().supersede(kind, threadId, target, experienceReviewRoundId(base, proposed));
  }, [kind, threadId, target, base, proposed]);
}


/**
 * Owns one experience review session's non-render lifecycle: per-thread round
 * state, stale CodeMirror callback protection, application/reversal outcomes,
 * and the bridge metadata sent with each turn. Presentation remains in the host.
 */
export function useExperienceCopilotReviewSession({
  bridge,
  codeBuffer,
  editorBuffer,
  isSending,
  kind,
  launchContextRef,
  onRulesChange,
  onVisualChange,
  rulesCode,
  rulesSaved,
  t,
  testFeedback,
  threadId,
  visualSaved,
  visualSource,
}: {
  bridge: AgentHostBridge;
  codeBuffer: "rules" | "visual";
  editorBuffer: "preview" | "code" | "sandbox";
  isSending: boolean;
  kind: AgentKind;
  launchContextRef: MutableRefObject<ExperienceCopilotLaunchContext | undefined>;
  onRulesChange: (code: string) => void;
  onVisualChange: (source: string) => void;
  rulesCode: string;
  rulesSaved: boolean | undefined;
  t: TFunc;
  testFeedback: Record<string, unknown> | undefined;
  threadId: string | null;
  visualSaved: boolean | undefined;
  visualSource: string;
}) {
  // CodeMirror owns hunk-button DOM between extension reconfigurations. A
  // button can therefore call a prior render's callback; these refs ensure its
  // local application always starts from the current controlled parent buffer.
  const rulesCodeRef = useRef(rulesCode);
  const visualSourceRef = useRef(visualSource);
  const onRulesChangeRef = useRef(onRulesChange);
  const onVisualChangeRef = useRef(onVisualChange);
  rulesCodeRef.current = rulesCode;
  visualSourceRef.current = visualSource;
  onRulesChangeRef.current = onRulesChange;
  onVisualChangeRef.current = onVisualChange;

  // ── Review state (CD-2/CD-3): freeze, snapshots, revert ────────────────
  // The live turn's activities feed the review hook (proposal aggregation);
  // the SAME store read the MessageList does — never from inside a render.
  const turnActivities = useAgentTurnStore(
    useShallow((s) => (threadId ? s.turnsByThread[agentThreadKey(kind, threadId)] ?? EMPTY_ACTIVITIES : EMPTY_ACTIVITIES)),
  );
  const handleRevertBuffers = useCallback(
    (buffers: { rules: string; visual: string }) => {
      // Only write the buffer that actually drifted — a no-op onChange would
      // mark a clean (saved) buffer dirty with its own current text.
      if (buffers.rules !== rulesCode) onRulesChange(buffers.rules);
      if (buffers.visual !== visualSource) onVisualChange(buffers.visual);
    },
    [rulesCode, visualSource, onRulesChange, onVisualChange],
  );
  const review = useCopilotReviewState({
    kind: kind,
    threadId: threadId ?? "",
    isSending,
    rulesCode,
    visualSource,
    activities: turnActivities,
    onRevert: handleRevertBuffers,
  });

  // ── Hunk accept-selection (CD-6) + dangling proposals (CD-8) ────────────
  // Accept-selection lives in the per-thread review-round STORE (not local
  // state, not the editor panel) so it survives buffer-tab switches AND shell
  // unmounts — a hanging, unaccepted diff must reappear exactly as it was
  // when the user returns from another pane (prompt tracing, tester, …).
  // Resetting on a NEW proposal is `ensureReviewKey` below: it clears a
  // buffer's sets only when the review key (base+proposed) actually changed,
  // so a remount with the same proposal keeps the progress.
  const round = useAgentReviewRoundStore(
    useShallow((s) => (threadId ? s.roundsByThread[agentThreadKey(kind, threadId)] ?? EMPTY_REVIEW_ROUND : EMPTY_REVIEW_ROUND)),
  );
  const acceptedRulesHunks = useMemo(() => new Set(round.acceptedRules), [round.acceptedRules]);
  const acceptedVisualHunks = useMemo(() => new Set(round.acceptedVisual), [round.acceptedVisual]);
  // RV-2: per-buffer dismissed sets — a dismissed hunk leaves the round (no
  // decoration, no pending count, not in accept-all) without touching the buffer.
  const dismissedRulesHunks = useMemo(() => new Set(round.dismissedRules), [round.dismissedRules]);
  const dismissedVisualHunks = useMemo(() => new Set(round.dismissedVisual), [round.dismissedVisual]);
  // Store-backed replacements for the old useState setters — same callback
  // shape the accept/cancel helpers take, writing through to the round store.
  const setAcceptedRulesHunks = useCallback(
    (next: Set<number>) => {
      if (threadId) useAgentReviewRoundStore.getState().setAcceptedHunks(kind, threadId, "rules", [...next]);
    },
    [threadId],
  );
  const setAcceptedVisualHunks = useCallback(
    (next: Set<number>) => {
      if (threadId) useAgentReviewRoundStore.getState().setAcceptedHunks(kind, threadId, "visual", [...next]);
    },
    [threadId],
  );
  const setDismissedRulesHunks = useCallback(
    (next: Set<number>) => {
      if (threadId) useAgentReviewRoundStore.getState().setDismissedHunks(kind, threadId, "rules", [...next]);
    },
    [threadId],
  );
  const setDismissedVisualHunks = useCallback(
    (next: Set<number>) => {
      if (threadId) useAgentReviewRoundStore.getState().setDismissedHunks(kind, threadId, "visual", [...next]);
    },
    [threadId],
  );

  // CD-8 dangling semantics: a new chat turn must NOT kill an unresolved
  // review. The controller clears the live turn store at send start (the
  // audit feed stays per-turn, and history cards un-hide), so the still-pending
  // proposal is captured here before the send — it keeps hanging until the
  // model revises it or the user resolves it by hand. Nothing is auto-applied.
  const dangling = round.dangling;
  const proposalRef = useRef(review.proposal);
  const proposalBaseRef = useRef(review.proposalBase);
  proposalRef.current = review.proposal;
  proposalBaseRef.current = review.proposalBase;
  const captureDangling = useCallback(() => {
    if (!threadId) return;
    if (!proposalRef.current.hasProposal) return;
    useAgentReviewRoundStore.getState().captureDangling(kind, threadId, {
      rules: proposalRef.current.proposedRules,
      visual: proposalRef.current.proposedVisual,
      baseRules: proposalBaseRef.current?.rules ?? rulesCode,
      baseVisual: proposalBaseRef.current?.visual ?? visualSource,
    });
  }, [rulesCode, visualSource, threadId]);

  // Effective per-buffer inputs: the LIVE proposal wins its buffers; a buffer
  // the live turn did not touch falls back to the dangling capture.
  const effRules = useMemo(() => {
    if (review.proposal.proposedRules !== undefined)
      return { proposed: review.proposal.proposedRules, base: review.proposalBase?.rules };
    if (dangling?.rules !== undefined) return { proposed: dangling.rules, base: dangling.baseRules };
    return {};
  }, [review.proposal.proposedRules, review.proposalBase, dangling]);
  const effVisual = useMemo(() => {
    if (review.proposal.proposedVisual !== undefined)
      return { proposed: review.proposal.proposedVisual, base: review.proposalBase?.visual };
    if (dangling?.visual !== undefined) return { proposed: dangling.visual, base: dangling.baseVisual };
    return {};
  }, [review.proposal.proposedVisual, review.proposalBase, dangling]);
  const effectiveReviewsRef = useRef({ rules: effRules, visual: effVisual });
  effectiveReviewsRef.current = { rules: effRules, visual: effVisual };
  const isSendingRef = useRef(isSending);
  isSendingRef.current = isSending;

  // RV-1: per-buffer review keys (base + proposed of THIS buffer only). The
  // old COMBINED key reset BOTH accepted sets whenever either buffer's
  // proposal changed — a visual-only follow-up turn re-lit rules hunks the
  // user had already accepted (and saved). The base is part of the key because
  // hunk ids index into the diff: a changed base changes the diff (and ids),
  // so a stale id set must not survive it.
  const rulesReviewKey = effRules.proposed !== undefined
    ? `${effRules.base ?? ""}\u0000${effRules.proposed}`
    : null;
  const visualReviewKey = effVisual.proposed !== undefined
    ? `${effVisual.base ?? ""}\u0000${effVisual.proposed}`
    : null;
  // RV-1 per-buffer key reset, store edition: a REMOUNT with the same proposal
  // keeps the accept/dismiss progress (ensureReviewKey no-ops on a matching
  // key); only a genuinely new proposal (changed base/proposed — including the
  // revert path flipping the key to null) restarts the buffer's sets. There is
  // deliberately NO mount-time reset of `dangling`: per-thread slices already
  // isolate threads, and wiping on the "" → threadId transition would destroy
  // the restored round — the exact bug this store exists to fix.
  useEffect(() => {
    if (threadId) useAgentReviewRoundStore.getState().ensureReviewKey(kind, threadId, "rules", rulesReviewKey);
  }, [threadId, rulesReviewKey]);
  useEffect(() => {
    if (threadId) useAgentReviewRoundStore.getState().ensureReviewKey(kind, threadId, "visual", visualReviewKey);
  }, [threadId, visualReviewKey]);
  // Envelope-v2 persistence (the write side of ER-10): keep the localStorage
  // draft (finalized activities + the round) in sync on every mutation. The
  // last write before an unmount/reload captures the hanging state that
  // `rehydrateExperienceCopilotDrafts` seeds both stores from on the next mount.
  useEffect(() => {
    if (!threadId) return;
    syncPersistedCopilotRound(threadId);
  }, [threadId, round, turnActivities]);

  const rulesReview = useMemo(
    () => buildBufferReview(effRules.base, effRules.proposed, acceptedRulesHunks, !isSending, dismissedRulesHunks),
    [effRules, acceptedRulesHunks, dismissedRulesHunks, isSending],
  );
  const visualReview = useMemo(
    () => buildBufferReview(effVisual.base, effVisual.proposed, acceptedVisualHunks, !isSending, dismissedVisualHunks),
    [effVisual, acceptedVisualHunks, dismissedVisualHunks, isSending],
  );
  useExperienceReviewSupersession(kind, threadId, "rules", effRules.base, effRules.proposed);
  useExperienceReviewSupersession(kind, threadId, "visual", effVisual.base, effVisual.proposed);

  const recordAppliedOutcome = useExperienceReviewOutcomeRecorder(kind, threadId);

  /** Re-read state at the local-action boundary because a CodeMirror hunk
   * callback can outlive the render that installed its decoration. */
  const currentHunkReview = useCallback(
    (target: "rules" | "visual") => {
      if (!threadId) return null;
      const current = useAgentReviewRoundStore.getState().roundsByThread[agentThreadKey(kind, threadId)];
      if (!current) return null;
      const accepted = new Set(target === "rules" ? current.acceptedRules : current.acceptedVisual);
      const dismissed = new Set(target === "rules" ? current.dismissedRules : current.dismissedVisual);
      const effective = effectiveReviewsRef.current[target];
      const bufferReview = buildBufferReview(effective.base, effective.proposed, accepted, !isSendingRef.current, dismissed);
      return bufferReview ? { bufferReview, accepted, dismissed } : null;
    },
    [threadId],
  );

  // UX 2026-08-16 remark 6 — static validation of the EFFECTIVE visual document:
  // while a review round is open that is the PROPOSED text (what accept-all
  // would land); otherwise the live buffer.
  const visualValidation = useExperienceCopilotVisualValidation(visualReview, visualSource);

  // CD-8 conflict semantics. Clean path: the buffer is exactly the hybrid the
  // accept flow expects → rebuild from the snapshot base (mergeSelectedBody).
  // Drift path (buffer changed outside the review — e.g. a template tool):
  // anchor the clicked hunks onto the CURRENT buffer; a hunk whose old text
  // no longer appears is CONFLICTING — skipped (stay pending), never blocking
  // the rest, announced with a toast. No silent rebase, ever.
  const acceptHunks = useCallback(
    (
      bufferReview: CopilotBufferReview,
      prevAccepted: ReadonlySet<number>,
      clickedIds: readonly number[],
      bufferText: string,
      setAccepted: (next: Set<number>) => void,
      onChange: (text: string) => void,
      target: "rules" | "visual",
      dismissed: ReadonlySet<number>,
    ) => {
      // tooLarge wholesale (RV-1): no hunk decomposition — accept applies the
      // whole proposal and resolves the sentinel id. (Before this branch the
      // drift path silently skipped every id and accept-all was a no-op.)
      if (!bufferReview.diff) {
        const nextWhole = new Set(prevAccepted);
        for (const id of clickedIds) nextWhole.add(id);
        if (bufferText !== bufferReview.proposed) {
          onChange(bufferReview.proposed);
        }
        setAccepted(nextWhole);
        recordAppliedOutcome(target, bufferReview, nextWhole, dismissed, nextWhole);
        return;
      }
      const expected = mergedReviewText(bufferReview, prevAccepted);
      if (bufferText !== expected) {
        const { text, skippedHunkIds } = applyHunksToBuffer(
          bufferText,
          bufferReview.diff,
          bufferReview.hunks,
          new Set(clickedIds),
        );
        const applied = clickedIds.filter((id) => !skippedHunkIds.includes(id));
        const next = new Set(prevAccepted);
        for (const id of applied) next.add(id);
        if (applied.length > 0) {
          onChange(text);
          setAccepted(next);
          recordAppliedOutcome(target, bufferReview, next, dismissed, new Set(applied));
        }
        if (skippedHunkIds.length > 0)
          toast.warning(t("copilot_review_hunks_skipped", { n: skippedHunkIds.length }));
        return;
      }
      const next = new Set(prevAccepted);
      for (const id of clickedIds) next.add(id);
      onChange(mergedReviewText(bufferReview, next));
      setAccepted(next);
      recordAppliedOutcome(target, bufferReview, next, dismissed, new Set(clickedIds));
    },
    [t, recordAppliedOutcome],
  );

  const acceptRulesHunk = useCallback(
    (hunkId: number) => {
      const current = currentHunkReview("rules");
      if (!current) return;
      acceptHunks(current.bufferReview, current.accepted, [hunkId], rulesCodeRef.current, setAcceptedRulesHunks, onRulesChangeRef.current, "rules", current.dismissed);
    },
    [currentHunkReview, acceptHunks, setAcceptedRulesHunks],
  );
  const acceptAllRules = useCallback(() => {
    const current = currentHunkReview("rules");
    if (!current) return;
    const pending = [...allReviewHunkIds(current.bufferReview)].filter((id) => !current.accepted.has(id) && !current.dismissed.has(id));
    acceptHunks(current.bufferReview, current.accepted, pending, rulesCodeRef.current, setAcceptedRulesHunks, onRulesChangeRef.current, "rules", current.dismissed);
  }, [currentHunkReview, acceptHunks, setAcceptedRulesHunks]);

  // RV-2: dismiss (✕) — the hunk leaves the round; the buffer is untouched.
  const dismissRulesHunk = useCallback(
    (hunkId: number) => {
      if (!threadId) return;
      const state = useAgentReviewRoundStore.getState();
      const current = state.roundsByThread[agentThreadKey(kind, threadId)];
      if (!current) return;
      const dismissed = new Set([...current.dismissedRules, hunkId]);
      state.setDismissedHunks(kind, threadId, "rules", [...dismissed]);
      if (rulesReview) recordExperienceReviewOutcome({ kind: kind, threadId, target: "rules", bufferReview: rulesReview, accepted: new Set(current.acceptedRules), dismissed });
    },
    [threadId, rulesReview],
  );
  const dismissVisualHunk = useCallback(
    (hunkId: number) => {
      if (!threadId) return;
      const state = useAgentReviewRoundStore.getState();
      const current = state.roundsByThread[agentThreadKey(kind, threadId)];
      if (!current) return;
      const dismissed = new Set([...current.dismissedVisual, hunkId]);
      state.setDismissedHunks(kind, threadId, "visual", [...dismissed]);
      if (visualReview) recordExperienceReviewOutcome({ kind: kind, threadId, target: "visual", bufferReview: visualReview, accepted: new Set(current.acceptedVisual), dismissed });
    },
    [threadId, visualReview],
  );
  const acceptVisualHunk = useCallback(
    (hunkId: number) => {
      const current = currentHunkReview("visual");
      if (!current) return;
      acceptHunks(current.bufferReview, current.accepted, [hunkId], visualSourceRef.current, setAcceptedVisualHunks, onVisualChangeRef.current, "visual", current.dismissed);
    },
    [currentHunkReview, acceptHunks, setAcceptedVisualHunks],
  );
  const acceptAllVisual = useCallback(() => {
    const current = currentHunkReview("visual");
    if (!current) return;
    const pending = [...allReviewHunkIds(current.bufferReview)].filter((id) => !current.accepted.has(id) && !current.dismissed.has(id));
    acceptHunks(
      current.bufferReview,
      current.accepted,
      pending,
      visualSourceRef.current,
      setAcceptedVisualHunks,
      onVisualChangeRef.current,
      "visual",
      current.dismissed,
    );
  }, [currentHunkReview, acceptHunks, setAcceptedVisualHunks]);

  // RV-3: "Cancel all unaccepted" — dismiss the PENDING hunks of THIS
  // buffer only (accepted hunks stay accepted, the other buffer and the text
  // are untouched). The round resolves once nothing is pending.
  const dismissPendingRules = useCallback(() => {
    if (!rulesReview || !threadId) return;
    const pending = [...allReviewHunkIds(rulesReview)].filter(
      (id) => !acceptedRulesHunks.has(id) && !dismissedRulesHunks.has(id),
    );
    if (pending.length === 0) return;
    const state = useAgentReviewRoundStore.getState();
    const current = state.roundsByThread[agentThreadKey(kind, threadId)];
    if (!current) return;
    const dismissed = new Set([...current.dismissedRules, ...pending]);
    state.setDismissedHunks(kind, threadId, "rules", [...dismissed]);
    recordExperienceReviewOutcome({
      kind,
      threadId,
      target: "rules",
      bufferReview: rulesReview,
      accepted: new Set(current.acceptedRules),
      dismissed,
    });
  }, [rulesReview, acceptedRulesHunks, dismissedRulesHunks, threadId]);
  const dismissPendingVisual = useCallback(() => {
    if (!visualReview || !threadId) return;
    const pending = [...allReviewHunkIds(visualReview)].filter(
      (id) => !acceptedVisualHunks.has(id) && !dismissedVisualHunks.has(id),
    );
    if (pending.length === 0) return;
    const state = useAgentReviewRoundStore.getState();
    const current = state.roundsByThread[agentThreadKey(kind, threadId)];
    if (!current) return;
    const dismissed = new Set([...current.dismissedVisual, ...pending]);
    state.setDismissedHunks(kind, threadId, "visual", [...dismissed]);
    recordExperienceReviewOutcome({
      kind,
      threadId,
      target: "visual",
      bufferReview: visualReview,
      accepted: new Set(current.acceptedVisual),
      dismissed,
    });
  }, [visualReview, acceptedVisualHunks, dismissedVisualHunks, threadId]);

  // RV-3: "Cancel all" — kill the whole round for THIS buffer: every hunk
  // (pending AND accepted) leaves the round (dismissed), and the hunks already
  // accepted into the buffer are rolled back — from the snapshot base on the
  // clean path, or by reverse-splicing their added lines off the drifted
  // buffer (non-anchoring hunks are skipped + toasted, never guessed). No
  // clearTurn, no snapshot pop, no setDangling — that is the toolbar revert's
  // job (CD-3).
  const cancelRoundRules = useCallback(() => {
    if (!rulesReview) return;
    const result = cancelExperienceReviewHunks({
      bufferReview: rulesReview,
      prevAccepted: acceptedRulesHunks,
      prevDismissed: dismissedRulesHunks,
      bufferText: rulesCode,
      setAccepted: setAcceptedRulesHunks,
      setDismissed: setDismissedRulesHunks,
      onChange: onRulesChange,
    });
    if (result.skippedCount > 0) toast.warning(t("copilot_review_hunks_skipped", { n: result.skippedCount }));
    recordAppliedOutcome("rules", rulesReview, result.accepted, result.dismissed, result.accepted, result.cancelled, true);
  }, [rulesReview, acceptedRulesHunks, dismissedRulesHunks, rulesCode, onRulesChange, recordAppliedOutcome, t]);
  const cancelRoundVisual = useCallback(() => {
    if (!visualReview) return;
    const result = cancelExperienceReviewHunks({
      bufferReview: visualReview,
      prevAccepted: acceptedVisualHunks,
      prevDismissed: dismissedVisualHunks,
      bufferText: visualSource,
      setAccepted: setAcceptedVisualHunks,
      setDismissed: setDismissedVisualHunks,
      onChange: onVisualChange,
    });
    if (result.skippedCount > 0) toast.warning(t("copilot_review_hunks_skipped", { n: result.skippedCount }));
    recordAppliedOutcome("visual", visualReview, result.accepted, result.dismissed, result.accepted, result.cancelled, true);
  }, [visualReview, acceptedVisualHunks, dismissedVisualHunks, visualSource, onVisualChange, recordAppliedOutcome, t]);

  const handleToolbarRevert = useCallback(() => {
    if (threadId && review.lastSnapshot) {
      const revertedTargets: Array<"rules" | "visual"> = [];
      if (rulesCode !== review.lastSnapshot.rules) revertedTargets.push("rules");
      if (visualSource !== review.lastSnapshot.visual) revertedTargets.push("visual");
      // The parent callback restores the snapshot synchronously. Do not commit
      // cancellation evidence until that local restoration has actually run.
      review.revertLastTurn();
      recordExperienceRevertedOutcomes(
        kind,
        threadId,
        [
          { target: "rules" as const, review: rulesReview, accepted: acceptedRulesHunks, dismissed: dismissedRulesHunks },
          { target: "visual" as const, review: visualReview, accepted: acceptedVisualHunks, dismissed: dismissedVisualHunks },
        ].filter(({ target }) => revertedTargets.includes(target)),
      );
      cancelStoredExperienceOutcomes(kind, threadId, revertedTargets);
      useAgentReviewRoundStore.getState().clearDangling(kind, threadId);
    } else {
      review.revertLastTurn();
    }
    toast.success(t("copilot_review_reverted"));
  }, [
    review,
    t,
    threadId,
    rulesReview,
    visualReview,
    acceptedRulesHunks,
    acceptedVisualHunks,
    dismissedRulesHunks,
    dismissedVisualHunks,
    rulesCode,
    visualSource,
  ]);

  // ── The bridge session handle ────────────────────────────────────────────
  // Assigned every render (the latest-callback-ref pattern the captureDangling
  // refs already use): the shell reads it AT SEND TIME, so a click always sees
  // the last committed render's closures — the same freshness the pre-split
  // shell's inline handlers had.
  const buildSendOptions = useCallback((): AgentSendOptions => {
    const liveTargets = [
      ["rules", effRules, acceptedRulesHunks, dismissedRulesHunks],
      ["visual", effVisual, acceptedVisualHunks, dismissedVisualHunks],
    ] as const;
    const targets: ReviewTargetRecord[] = liveTargets.flatMap(([target, effective, accepted, dismissed]) => {
      if (effective.base === undefined || effective.proposed === undefined) return [];
      const fullReview = buildBufferReview(effective.base, effective.proposed, new Set(), true);
      if (!fullReview) return [];
      const stored = threadId
        ? useAgentReviewOutcomeStore.getState().outcomesByThread[agentThreadKey(kind, threadId)]?.[target]
        : undefined;
      const roundId = buildExperienceCopilotReviewSnapshot([{
        target,
        base: effective.base,
        proposed: effective.proposed,
        offeredHunkIds: [...allReviewHunkIds(fullReview)],
        acceptedHunkIds: new Set(),
        dismissedHunkIds: new Set(),
      }]).targets[0]?.roundId;
      if (stored?.record.roundId === roundId && stored.record.outcome !== "awaiting") return [stored.record];
      const [record] = buildExperienceCopilotReviewSnapshot([{
        target,
        base: effective.base,
        proposed: effective.proposed,
        offeredHunkIds: [...allReviewHunkIds(fullReview)],
        acceptedHunkIds: accepted,
        dismissedHunkIds: dismissed,
        // Hunk numbers are round-local diff indexes. A new proposal can reuse
        // an index, but it must never inherit a prior round's local apply.
        appliedHunkIds: stored?.record.roundId === roundId ? new Set(stored.appliedHunkIds) : new Set(),
      }]).targets;
      return [record!];
    });
    if (threadId) {
      const stored = useAgentReviewOutcomeStore.getState().outcomesByThread[agentThreadKey(kind, threadId)] ?? {};
      for (const outcome of Object.values(stored)) {
        if (outcome && !targets.some((target) => target.target === outcome.record.target)) targets.push(outcome.record);
      }
      targets.push(...(useAgentReviewOutcomeStore.getState().supersededByThread[agentThreadKey(kind, threadId)] ?? []));
    }
    return {
      rules: rulesCode,
      visual: visualSource,
      step: editorBuffer === "sandbox" ? "test" : codeBuffer === "visual" ? "visual" : "rules",
      ...(testFeedback !== undefined ? { testFeedback } : {}),
      ...(launchContextRef.current !== undefined ? { launchContext: launchContextRef.current } : {}),
      reviewSnapshot: { targets },
      ...(rulesSaved !== undefined ? { rulesSaved } : {}),
      ...(visualSaved !== undefined ? { visualSaved } : {}),
    };
  }, [
    rulesCode,
    visualSource,
    editorBuffer,
    codeBuffer,
    testFeedback,
    effRules,
    effVisual,
    acceptedRulesHunks,
    acceptedVisualHunks,
    dismissedRulesHunks,
    dismissedVisualHunks,
    threadId,
    rulesSaved,
    visualSaved,
  ]);
  bridge.session = { onBeforeSend: captureDangling, buildSendOptions };

  return {
    acceptedRulesHunks,
    acceptedVisualHunks,
    acceptAllRules,
    acceptAllVisual,
    acceptRulesHunk,
    acceptVisualHunk,
    cancelRoundRules,
    cancelRoundVisual,
    dismissPendingRules,
    dismissPendingVisual,
    dismissedRulesHunks,
    dismissedVisualHunks,
    dismissRulesHunk,
    dismissVisualHunk,
    handleToolbarRevert,
    review,
    rulesReview,
    visualReview,
    visualValidation,
  };
}
