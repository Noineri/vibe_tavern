import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { ExperienceCopilotLaunchContext, ReviewTargetRecord } from "@vibe-tavern/api-contracts";
import { Icons } from "../../../shared/icons.js";
import { EmptyState } from "../../../shared/empty-state.js";
import { SegmentedControl } from "../../../shared/SegmentedControl.js";
import { ExperiencePlayground } from "../ExperiencePlayground.js";
import { ExperienceFrame } from "../../../experience/ExperienceFrame.js";
import { useT } from "../../../../i18n/context.js";
import type { ScriptRecord } from "../../../../api/types.js";
import { useCopilotReviewState } from "../../../../hooks/use-copilot-review-state.js";
import { useExperienceCopilotTurnStore, type ExperienceCopilotToolActivity } from "../../../../stores/experience-copilot-turn-store.js";
import { rehydrateExperienceCopilotDrafts, syncPersistedCopilotRound } from "../../../../lib/experience-copilot-draft.js";
import { EMPTY_REVIEW_ROUND, useCopilotReviewRoundStore } from "../../../../stores/experience-copilot-review-store.js";
import type { CopilotDigest } from "../../../../lib/experience-copilot-digest.js";
import { useShallow } from "zustand/react/shallow";
import { ToolbarButton } from "./experience-copilot-buttons.js";
import { agentThreadKey, registerAgentHost, type AgentHostBridge, type AgentKind } from "../../../../lib/agent-host-registry.js";
import {
  activateExperienceCopilotSession,
  answerCopilotAsk,
  getExperienceCopilotActive,
  listExperienceCopilotMessages,
  listExperienceCopilotSessions,
  renameExperienceCopilotSession,
  setExperienceCopilotContextLinks,
  startExperienceCopilotSession,
  streamExperienceCopilot,
} from "../../../../api/experience-copilot-api.js";
import {
  allReviewHunkIds,
  applyHunksToBuffer,
  buildBufferReview,
  AgentBufferReviewEditor,
  mergedReviewText,
  type CopilotBufferReview,
} from "../../../shared/agent-shell/AgentBufferReviewEditor.js";
import type { AgentSendOptions } from "../../../shared/agent-shell/use-agent-controller.js";
import { buildExperienceCopilotReviewSnapshot } from "../../../../lib/experience-copilot-review-snapshot.js";
import { useAgentReviewOutcomeStore } from "../../../../stores/agent-review-outcome-store.js";
import { cancelExperienceReviewHunks, cancelStoredExperienceOutcomes, recordExperienceReviewOutcome, recordExperienceRevertedOutcomes, useExperienceCopilotReviewFeedback, useExperienceCopilotReviewTabs, useExperienceCopilotStep, useExperienceCopilotVisualValidation, useExperienceReviewOutcomeRecorder, useExperienceReviewSupersession } from "./use-experience-copilot-review.js";

/**
 * The `experience` agent host (AGENT_SHELL_PLAN AS-6b2) — the mini-app
 * AI assistant as the FIRST registered host of the generic `AgentShell`. This
 * file holds everything the shell deliberately does not know: the two
 * canonical buffers (rules + visual), the editor pane composition
 * (`[Preview | Code | Try]` outer toggle, `[Rules | Visual]` sub-toggle,
 * inline `ExperienceFrame` / `ExperiencePlayground`, the visual validator, the
 * per-buffer hunk review through `AgentBufferReviewEditor`, the creation
 * stepper reporting), the per-turn send options, and the buffer-review session
 * state (snapshots, rounds, dangling capture) registered with the shell
 * through the bridge.
 *
 * The descriptor is a module constant and self-registers at module init — the
 * composition root (`ExperienceCopilotShell.tsx`) side-effect-imports THIS
 * file exactly once. Everything LIVE flows through `AgentHostContext`: the
 * pane receives `threadId` / `isSending` / the wrapper's host props, and hands
 * its session handle (dangling capture + send options) back via the bridge.
 *
 * Behavior is byte-identical to the pre-split `ExperienceCopilotShell` —
 * this is the AS-6b2 extraction, not a redesign.
 */

/** The wrapper's host-specific props (AS-6b2): everything only this host
 *  understands. `ExperienceCopilotShell` builds the object; the shell carries
 *  it opaquely; `renderEditorPane` narrows it here (wrapper and host are a
 *  pair, so the cast is boundary-narrowing, not a guess). */
export interface ExperienceCopilotHostProps {
  /** SS-7B2: the selected rules script's trust data (origin/firstEnabledAt),
   *  threaded from the editor to the inline playground so its debounced
   *  AUTOMATIC discovery can route through the script execution guard.
   *  Optional — the pre-threading behavior applies when absent. */
  script?: Pick<ScriptRecord, "origin" | "firstEnabledAt"> | null;
  /** Canonical rules buffer (the active script's code). Controlled. */
  rulesCode: string;
  onRulesChange: (code: string) => void;
  /** Canonical visual buffer (the active visual's source). Controlled. */
  visualSource: string;
  onVisualChange: (source: string) => void;
  /** Contextual toolbar rendered BELOW the editor toolbar when the Rules
   *  buffer is active. Optional — undefined renders nothing (no gap). */
  rulesToolbar?: ReactNode;
  /** Contextual toolbar rendered BELOW the editor toolbar when the Visual
   *  buffer is active. Optional — undefined renders nothing (no gap). */
  visualToolbar?: ReactNode;
  /** Reports the shell's current authoring position for the creation stepper
   *  (`rules` / `appearance` / `try`). Optional — unused when the parent
   *  renders no stepper. Fired on mount (initial default) and on every tab
   *  switch. */
  onStepChange?: (step: ExperienceCopilotStep) => void;
  /** SS-7: «Show in code» — reveal a finding line in the RULES editor
   *  (fresh object per request; switches to Rules when Visual is active). */
  revealRulesLine?: { line: number } | null;
  rulesSaved?: boolean;
  visualSaved?: boolean;
}

/** Authoring position reported to the parent's creation stepper (XU-6).
 *  Re-exported by the `ExperienceCopilotShell` wrapper for its public props. */
export type ExperienceCopilotStep = "rules" | "appearance" | "try";

/** The kind this host registers under (AS-6c-ii) — the single spelling for
 *  every store key in this module (`agentThreadKey(EXPERIENCE_KIND,
 *  threadId)`); the descriptor registration below uses the same const. */
const EXPERIENCE_KIND: AgentKind = "experience";

/** Stable empty fallback for the turn-store selector (a fresh `[]` per call
 *  would break useShallow's reference equality and re-render every keystroke). */
const EMPTY_ACTIVITIES: readonly ExperienceCopilotToolActivity[] = [];
/** Outer editor tab (XU-5): live preview / code / inline sandbox. */
type EditorBuffer = "preview" | "code" | "sandbox";
/** Inner code sub-toggle — the two canonical buffers. */
type CodeBuffer = "rules" | "visual";

function ExperienceEditorPane({
  ownerId,
  threadId,
  isSending,
  bridge,
  hostProps,
}: {
  ownerId: string;
  threadId: string | null;
  isSending: boolean;
  bridge: AgentHostBridge;
  hostProps: ExperienceCopilotHostProps;
}) {
  const {
    script = null,
    rulesCode,
    onRulesChange,
    visualSource,
    onVisualChange,
    rulesToolbar,
    visualToolbar,
    onStepChange,
    revealRulesLine = null,
    rulesSaved,
    visualSaved,
  } = hostProps;
  const { t } = useT();

  // ── UI-only editor tab state ─────────────────────────────────────────────
  // XU-5: the editor pane defaults to the live preview when a visual exists,
  // else to the code pane. Seeded ONCE at mount — a later manual switch wins.
  const [editorBuffer, setEditorBuffer] = useState<EditorBuffer>(
    () => (visualSource.trim() !== "" ? "preview" : "code"),
  );
  const [codeBuffer, setCodeBuffer] = useState<CodeBuffer>("rules");
  const [rulesRevealLine, setRulesRevealLine] = useState(revealRulesLine);

  // SS-7B4: reveal requests from either the editor or the inline Try surface
  // land on the RULES editor, so leave Preview/Try and switch the code buffer.
  useEffect(() => {
    if (!revealRulesLine) return;
    setRulesRevealLine(revealRulesLine);
  }, [revealRulesLine]);
  useEffect(() => {
    if (!rulesRevealLine) return;
    setEditorBuffer("code");
    setCodeBuffer("rules");
  }, [rulesRevealLine]);

  // ER-14: the latest test/simulate digest the user sent back from the test
  // panel (set by `handleSendToCopilot`). Carried on EVERY subsequent copilot
  // send as `testFeedback` (survives history compaction as a system-level JSON
  // context section), so a manual follow-up also carries it.
  const { testFeedback, launchContextRef, handleLaunchContextChange, handleSendToCopilot } = useExperienceCopilotReviewFeedback({
    bridge,
    onCopied: () => toast.success(t("agent_result_copied")),
  });

  // Draft envelope rehydration (ER-10): seeds BOTH stores (turn + review
  // round) from the localStorage envelope on mount. Runs BEFORE the shell's
  // own mount effect loads the session (child effects run first), preserving
  // the pre-split guarantee that the stores are seeded before threadId lands.
  useEffect(() => {
    rehydrateExperienceCopilotDrafts();
  }, []);

  // ── Review state (CD-2/CD-3): freeze, snapshots, revert ────────────────
  // The live turn's activities feed the review hook (proposal aggregation);
  // the SAME store read the MessageList does — never from inside a render.
  const turnActivities = useExperienceCopilotTurnStore(
    useShallow((s) => (threadId ? s.turnsByThread[agentThreadKey(EXPERIENCE_KIND, threadId)] ?? EMPTY_ACTIVITIES : EMPTY_ACTIVITIES)),
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
    kind: EXPERIENCE_KIND,
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
  const round = useCopilotReviewRoundStore(
    useShallow((s) => (threadId ? s.roundsByThread[agentThreadKey(EXPERIENCE_KIND, threadId)] ?? EMPTY_REVIEW_ROUND : EMPTY_REVIEW_ROUND)),
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
      if (threadId) useCopilotReviewRoundStore.getState().setAcceptedHunks(EXPERIENCE_KIND, threadId, "rules", [...next]);
    },
    [threadId],
  );
  const setAcceptedVisualHunks = useCallback(
    (next: Set<number>) => {
      if (threadId) useCopilotReviewRoundStore.getState().setAcceptedHunks(EXPERIENCE_KIND, threadId, "visual", [...next]);
    },
    [threadId],
  );
  const setDismissedRulesHunks = useCallback(
    (next: Set<number>) => {
      if (threadId) useCopilotReviewRoundStore.getState().setDismissedHunks(EXPERIENCE_KIND, threadId, "rules", [...next]);
    },
    [threadId],
  );
  const setDismissedVisualHunks = useCallback(
    (next: Set<number>) => {
      if (threadId) useCopilotReviewRoundStore.getState().setDismissedHunks(EXPERIENCE_KIND, threadId, "visual", [...next]);
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
    useCopilotReviewRoundStore.getState().captureDangling(EXPERIENCE_KIND, threadId, {
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
    if (threadId) useCopilotReviewRoundStore.getState().ensureReviewKey(EXPERIENCE_KIND, threadId, "rules", rulesReviewKey);
  }, [threadId, rulesReviewKey]);
  useEffect(() => {
    if (threadId) useCopilotReviewRoundStore.getState().ensureReviewKey(EXPERIENCE_KIND, threadId, "visual", visualReviewKey);
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
  useExperienceReviewSupersession(EXPERIENCE_KIND, threadId, "rules", effRules.base, effRules.proposed);
  useExperienceReviewSupersession(EXPERIENCE_KIND, threadId, "visual", effVisual.base, effVisual.proposed);

  const recordAppliedOutcome = useExperienceReviewOutcomeRecorder(EXPERIENCE_KIND, threadId);

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
      if (!rulesReview) return;
      acceptHunks(rulesReview, acceptedRulesHunks, [hunkId], rulesCode, setAcceptedRulesHunks, onRulesChange, "rules", dismissedRulesHunks);
    },
    [rulesReview, acceptedRulesHunks, rulesCode, onRulesChange, acceptHunks, dismissedRulesHunks],
  );
  const acceptAllRules = useCallback(() => {
    if (!rulesReview) return;
    const pending = [...allReviewHunkIds(rulesReview)].filter((id) => !acceptedRulesHunks.has(id));
    acceptHunks(rulesReview, acceptedRulesHunks, pending, rulesCode, setAcceptedRulesHunks, onRulesChange, "rules", dismissedRulesHunks);
  }, [rulesReview, acceptedRulesHunks, rulesCode, onRulesChange, acceptHunks, dismissedRulesHunks]);

  // RV-2: dismiss (✕) — the hunk leaves the round; the buffer is untouched.
  const dismissRulesHunk = useCallback(
    (hunkId: number) => {
      if (!threadId) return;
      const state = useCopilotReviewRoundStore.getState();
      const current = state.roundsByThread[agentThreadKey(EXPERIENCE_KIND, threadId)];
      if (!current) return;
      const dismissed = new Set([...current.dismissedRules, hunkId]);
      state.setDismissedHunks(EXPERIENCE_KIND, threadId, "rules", [...dismissed]);
      if (rulesReview) recordExperienceReviewOutcome({ kind: EXPERIENCE_KIND, threadId, target: "rules", bufferReview: rulesReview, accepted: new Set(current.acceptedRules), dismissed });
    },
    [threadId, rulesReview],
  );
  const dismissVisualHunk = useCallback(
    (hunkId: number) => {
      if (!threadId) return;
      const state = useCopilotReviewRoundStore.getState();
      const current = state.roundsByThread[agentThreadKey(EXPERIENCE_KIND, threadId)];
      if (!current) return;
      const dismissed = new Set([...current.dismissedVisual, hunkId]);
      state.setDismissedHunks(EXPERIENCE_KIND, threadId, "visual", [...dismissed]);
      if (visualReview) recordExperienceReviewOutcome({ kind: EXPERIENCE_KIND, threadId, target: "visual", bufferReview: visualReview, accepted: new Set(current.acceptedVisual), dismissed });
    },
    [threadId, visualReview],
  );
  const acceptVisualHunk = useCallback(
    (hunkId: number) => {
      if (!visualReview) return;
      acceptHunks(visualReview, acceptedVisualHunks, [hunkId], visualSource, setAcceptedVisualHunks, onVisualChange, "visual", dismissedVisualHunks);
    },
    [visualReview, acceptedVisualHunks, visualSource, onVisualChange, acceptHunks, dismissedVisualHunks],
  );
  const acceptAllVisual = useCallback(() => {
    if (!visualReview) return;
    const pending = [...allReviewHunkIds(visualReview)].filter((id) => !acceptedVisualHunks.has(id));
    acceptHunks(visualReview, acceptedVisualHunks, pending, visualSource, setAcceptedVisualHunks, onVisualChange, "visual", dismissedVisualHunks);
  }, [visualReview, acceptedVisualHunks, visualSource, onVisualChange, acceptHunks, dismissedVisualHunks]);

  // RV-3: "Cancel all unaccepted" — dismiss the PENDING hunks of THIS
  // buffer only (accepted hunks stay accepted, the other buffer and the text
  // are untouched). The round resolves once nothing is pending.
  const dismissPendingRules = useCallback(() => {
    if (!rulesReview || !threadId) return;
    const pending = [...allReviewHunkIds(rulesReview)].filter(
      (id) => !acceptedRulesHunks.has(id) && !dismissedRulesHunks.has(id),
    );
    if (pending.length === 0) return;
    const state = useCopilotReviewRoundStore.getState();
    const current = state.roundsByThread[agentThreadKey(EXPERIENCE_KIND, threadId)];
    if (!current) return;
    const dismissed = new Set([...current.dismissedRules, ...pending]);
    state.setDismissedHunks(EXPERIENCE_KIND, threadId, "rules", [...dismissed]);
    recordExperienceReviewOutcome({ kind: EXPERIENCE_KIND, threadId, target: "rules", bufferReview: rulesReview, accepted: new Set(current.acceptedRules), dismissed });
  }, [rulesReview, acceptedRulesHunks, dismissedRulesHunks, threadId]);
  const dismissPendingVisual = useCallback(() => {
    if (!visualReview || !threadId) return;
    const pending = [...allReviewHunkIds(visualReview)].filter(
      (id) => !acceptedVisualHunks.has(id) && !dismissedVisualHunks.has(id),
    );
    if (pending.length === 0) return;
    const state = useCopilotReviewRoundStore.getState();
    const current = state.roundsByThread[agentThreadKey(EXPERIENCE_KIND, threadId)];
    if (!current) return;
    const dismissed = new Set([...current.dismissedVisual, ...pending]);
    state.setDismissedHunks(EXPERIENCE_KIND, threadId, "visual", [...dismissed]);
    recordExperienceReviewOutcome({ kind: EXPERIENCE_KIND, threadId, target: "visual", bufferReview: visualReview, accepted: new Set(current.acceptedVisual), dismissed });
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
    const result = cancelExperienceReviewHunks({ bufferReview: rulesReview, prevAccepted: acceptedRulesHunks, prevDismissed: dismissedRulesHunks, bufferText: rulesCode, setAccepted: setAcceptedRulesHunks, setDismissed: setDismissedRulesHunks, onChange: onRulesChange });
    if (result.skippedCount > 0) toast.warning(t("copilot_review_hunks_skipped", { n: result.skippedCount }));
    recordAppliedOutcome("rules", rulesReview, result.accepted, result.dismissed, result.accepted, result.cancelled, true);
  }, [rulesReview, acceptedRulesHunks, dismissedRulesHunks, rulesCode, onRulesChange, recordAppliedOutcome, t]);
  const cancelRoundVisual = useCallback(() => {
    if (!visualReview) return;
    const result = cancelExperienceReviewHunks({ bufferReview: visualReview, prevAccepted: acceptedVisualHunks, prevDismissed: dismissedVisualHunks, bufferText: visualSource, setAccepted: setAcceptedVisualHunks, setDismissed: setDismissedVisualHunks, onChange: onVisualChange });
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
      recordExperienceRevertedOutcomes(EXPERIENCE_KIND, threadId, ([{ target: "rules" as const, review: rulesReview, accepted: acceptedRulesHunks, dismissed: dismissedRulesHunks }, { target: "visual" as const, review: visualReview, accepted: acceptedVisualHunks, dismissed: dismissedVisualHunks }]).filter(({ target }) => revertedTargets.includes(target)));
      cancelStoredExperienceOutcomes(EXPERIENCE_KIND, threadId, revertedTargets);
      useCopilotReviewRoundStore.getState().clearDangling(EXPERIENCE_KIND, threadId);
    } else {
      review.revertLastTurn();
    }
    toast.success(t("copilot_review_reverted"));
  }, [review, t, threadId, rulesReview, visualReview, acceptedRulesHunks, acceptedVisualHunks, dismissedRulesHunks, dismissedVisualHunks, rulesCode, visualSource]);

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
        ? useAgentReviewOutcomeStore.getState().outcomesByThread[agentThreadKey(EXPERIENCE_KIND, threadId)]?.[target]
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
      const stored = useAgentReviewOutcomeStore.getState().outcomesByThread[agentThreadKey(EXPERIENCE_KIND, threadId)] ?? {};
      for (const outcome of Object.values(stored)) {
        if (outcome && !targets.some((target) => target.target === outcome.record.target)) targets.push(outcome.record);
      }
      targets.push(...(useAgentReviewOutcomeStore.getState().supersededByThread[agentThreadKey(EXPERIENCE_KIND, threadId)] ?? []));
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
  }, [rulesCode, visualSource, editorBuffer, codeBuffer, testFeedback, effRules, effVisual, acceptedRulesHunks, acceptedVisualHunks, dismissedRulesHunks, dismissedVisualHunks, threadId, rulesSaved, visualSaved]);
  bridge.session = { onBeforeSend: captureDangling, buildSendOptions };

  const { outerBufferOptions, codeBufferOptions } = useExperienceCopilotReviewTabs({ rulesReview, visualReview, t });

  const activeStep = useExperienceCopilotStep(editorBuffer, codeBuffer, onStepChange);

  // IR-90A: exactly one ExperiencePlayground element is shared by the inline
  // Try tab in both modes (the old sandbox modal is gone, XU-6). A single
  // instance ever mounts.
  const playground = <ExperiencePlayground code={rulesCode} visualSource={visualSource || null} scriptId={ownerId} script={script} onSendToCopilot={handleSendToCopilot} onShowInCode={(line) => setRulesRevealLine({ line })} onLaunchContextChange={handleLaunchContextChange} />;

  /* 4a follow-up round 2: on mobile the code branch is ONE scroll document
     — the pane root itself scrolls (max-md:overflow-y-auto) and every fixed
     row above the editor (buffer radios, sub-toggle, the visual toolbar wall,
     validator) scrolls away with it. Previously the toolbar stack (measured
     322px for the visual buffer) stayed pinned as shrink-0 rows and the
     editor's inner scroll window got only the flex remainder (~72px on a
     360×740 phone) — the "tiny window with a huge scroll" defect. The single
     scroll works together with the panel's max-md:flex-none container (see
     AgentBufferReviewEditor): a flex-1 min-h-0 child would keep snapping
     to the remainder and the root would never overflow. The preview/sandbox
     branches keep their inner scroll (their containers stay flex-1 min-h-0,
     so the root never overflows there — no double scrollbar). Desktop (>=md)
     is untouched. */
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg max-md:overflow-y-auto">
      {/* XU-5 outer tabs: [Preview | Code | Try] — preview is the default
          layer; the Try tab renders the shared playground inline in BOTH modes
          (XU-6, quote 10 — the old sandbox "Test it" button + modal are gone). */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2">
        <SegmentedControl
          value={editorBuffer}
          options={outerBufferOptions}
          onChange={(value) =>
            setEditorBuffer(value === "sandbox" ? "sandbox" : value === "code" ? "code" : "preview")
          }
          compact
        />
      </div>

      {editorBuffer === "preview" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {visualSource.trim() !== "" ? (
            // Disconnected visual render: no session. An EMPTY initial view is
            // pushed on ready so the visual's render() fires + reports its height
            // (otherwise auto-resize never runs and the iframe stalls at the
            // 120px fallback). Actions/errors are no-ops.
            <ExperienceFrame
              visualSource={visualSource}
              sessionId="preview"
              initialRevision={0}
              initialView={{ state: {}, actions: [], revision: 0, status: "active" }}
              onAction={() => {}}
              onError={() => {}}
            />
          ) : (
            <EmptyState
              icon={<Icons.Eye />}
              title={t("experience_playground_no_visual")}
            />
          )}
        </div>
      ) : editorBuffer === "sandbox" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">{playground}</div>
      ) : (
        <>
          {/* XU-5 code sub-toggle: [Rules | Visual] + the review revert. */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2">
            <SegmentedControl
              value={codeBuffer}
              options={codeBufferOptions}
              onChange={(value) => setCodeBuffer(value === "visual" ? "visual" : "rules")}
              compact
            />
            {review.canRevert && (
              <ToolbarButton
                label={t("copilot_review_revert")}
                icon={<Icons.Undo />}
                onClick={handleToolbarRevert}
                testId="copilot-toolbar-revert"
              />
            )}
          </div>
          {codeBuffer === "rules" ? rulesToolbar : visualToolbar}
          {/* UX 2026-08-16 remark 6 — visual validator status row. Validates
              the EFFECTIVE document: during a review round the proposed text
              (what accept would land), otherwise the live buffer. Static
              checks only (script-block compile + block closure) — see
              lib/visual-source-validator.ts; runtime behavior stays the
              sandbox's job. */}
          {codeBuffer === "visual" && (
            <div data-testid="copilot-visual-validator" className="px-3 pb-1.5 pt-2">
              {visualValidation.ok ? (
                <div className="flex items-center gap-1.5 font-ui text-[11px] text-success-text">
                  <Icons.Check className="h-3 w-3 shrink-0" />
                  <span>{t("agent_visual_valid")}</span>
                </div>
              ) : (
                <div className="rounded-md border border-danger bg-danger-dim px-2.5 py-1.5">
                  <div className="flex items-center gap-1.5 font-ui text-[11px] font-medium text-danger-text">
                    <Icons.Alert className="h-3.5 w-3.5 shrink-0" />
                    <span>{t("agent_visual_problems")}</span>
                  </div>
                  <ul className="mt-1 space-y-0.5">
                    {visualValidation.problems.map((p, i) => (
                      <li key={i} className="font-mono text-[11px] leading-[1.5] text-danger-text">
                        {p.line !== null ? `L${p.line}: ` : ""}{p.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {/* CD-6: the review-mode editor (inline diff + review bar). The
              accept-selection state lives here in the pane so it survives
              buffer-tab switches (the panel remounts per tab). */}
          <AgentBufferReviewEditor
            value={codeBuffer === "rules" ? rulesCode : visualSource}
            onChange={codeBuffer === "rules" ? onRulesChange : onVisualChange}
            isSending={isSending}
            review={codeBuffer === "rules" ? rulesReview : visualReview}
            acceptedHunkIds={codeBuffer === "rules" ? acceptedRulesHunks : acceptedVisualHunks}
            dismissedHunkIds={codeBuffer === "rules" ? dismissedRulesHunks : dismissedVisualHunks}
            onAcceptHunk={codeBuffer === "rules" ? acceptRulesHunk : acceptVisualHunk}
            onAcceptAll={codeBuffer === "rules" ? acceptAllRules : acceptAllVisual}
            onDismissHunk={codeBuffer === "rules" ? dismissRulesHunk : dismissVisualHunk}
            onDismissPending={codeBuffer === "rules" ? dismissPendingRules : dismissPendingVisual}
            onCancelRound={codeBuffer === "rules" ? cancelRoundRules : cancelRoundVisual}
            fullscreenLabel={codeBuffer === "rules" ? t("agent_rules") : t("agent_visual")}
            scriptKind={codeBuffer === "rules" ? "interactive" : undefined}
            revealLine={codeBuffer === "rules" ? rulesRevealLine : undefined}
          />
        </>
      )}
    </div>
  );
}

/**
 * The `experience` host descriptor. `renderEditorPane` narrows the opaque
 * `hostProps` (the wrapper and this host are a pair); `buildSendOptions`
 * forwards to the pane's live bridge session — the descriptor is a module
 * constant and cannot close over component state.
 */
registerAgentHost({
  kind: EXPERIENCE_KIND,
  i18n: {
    // AS-6b2a renamed the copilot_* keys to agent_*; `experience_editor_back`
    // stays host-flavored — it is the EDITOR's shared back label, and the
    // shell test pins its aria-label byte-exactly.
    title: "agent_title",
    subtitle: "agent_subtitle",
    placeholder: "agent_input_placeholder",
    loading: "agent_loading",
    emptyTitle: "agent_title",
    emptySub: "agent_subtitle",
    mobileBackLabelKey: "experience_editor_back",
  },
  bufferSpecs: [
    { id: "rules", labelKey: "agent_rules", language: "javascript" },
    { id: "visual", labelKey: "agent_visual", language: "xml" },
  ],
  // AS-6c-i: the transport seam — the exact experience client fns the
  // pre-seam shell/controller called directly (behavior byte-identical, just
  // re-homed behind the descriptor; the registry's typeof-mirrored member
  // types keep this delegation compiler-checked).
  transport: {
    sendStream: streamExperienceCopilot,
    answerAsk: answerCopilotAsk,
    getActiveThread: getExperienceCopilotActive,
    listMessages: listExperienceCopilotMessages,
    startSession: startExperienceCopilotSession,
    listSessions: listExperienceCopilotSessions,
    activateSession: activateExperienceCopilotSession,
    renameSession: renameExperienceCopilotSession,
    setContextLinks: setExperienceCopilotContextLinks,
  },
  renderEditorPane: (ctx) => (
    <ExperienceEditorPane
      ownerId={ctx.ownerId}
      threadId={ctx.threadId}
      isSending={ctx.isSending}
      bridge={ctx.bridge}
      hostProps={ctx.hostProps as ExperienceCopilotHostProps}
    />
  ),
  buildSendOptions: (ctx) => ctx.bridge.session?.buildSendOptions() ?? {},
  // No record-proposal renderers yet — the AS-5 fallback card covers every
  // recordType until a host registers one.
  recordProposalRenderers: {},
});
