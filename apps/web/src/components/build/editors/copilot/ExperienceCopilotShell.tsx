import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { ExperienceCopilotMessageWire, ExperienceCopilotThreadWire } from "@vibe-tavern/api-contracts";
import { cn } from "../../../../lib/cn.js";
import { Icons } from "../../../shared/icons.js";
import { EmptyState } from "../../../shared/empty-state.js";
import { SegmentedControl } from "../../../shared/SegmentedControl.js";
import { Modal } from "../../../shared/Modal.js";
import { InteractiveTester } from "../InteractiveTester.js";
import { ExperiencePlayground } from "../ExperiencePlayground.js";
import { ExperienceFrame } from "../../../experience/ExperienceFrame.js";
import { useIsMobile } from "../../../../hooks/use-mobile.js";
import { useT } from "../../../../i18n/context.js";
import { useExperienceCopilotController } from "../../../../hooks/use-experience-copilot-controller.js";
import { useCopilotContext } from "../../../../hooks/use-copilot-context.js";
import { useCopilotReviewState } from "../../../../hooks/use-copilot-review-state.js";
import { useProviderDataStore } from "../../../../stores/provider-data-store.js";
import { useProviderModels } from "../../../../hooks/use-provider-models.js";
import { useExperienceCopilotTurnStore } from "../../../../stores/experience-copilot-turn-store.js";
import type { ExperienceCopilotToolActivity } from "../../../../stores/experience-copilot-turn-store.js";
import { useBootstrapStore, patchUiSettingsAction } from "../../../../stores/api-actions/bootstrap-actions.js";
import { rehydrateExperienceCopilotDrafts, syncPersistedCopilotRound } from "../../../../lib/experience-copilot-draft.js";
import { EMPTY_REVIEW_ROUND, useCopilotReviewRoundStore } from "../../../../stores/experience-copilot-review-store.js";
import type { CopilotDigest } from "../../../../lib/experience-copilot-digest.js";
import {
  getExperienceCopilotActive,
  listExperienceCopilotMessages,
  startExperienceCopilotSession,
  listExperienceCopilotSessions,
  activateExperienceCopilotSession,
} from "../../../../api/experience-copilot-api.js";
import { ExperienceSessionSwitcher } from "./ExperienceSessionSwitcher.js";
import { ExperienceContextMeter } from "./ExperienceContextMeter.js";
import { CopilotProfileModal } from "./CopilotProfileModal.js";
import { ExperienceCopilotMessageList } from "./ExperienceCopilotMessageList.js";
import { ExperienceCopilotInputArea } from "./ExperienceCopilotInputArea.js";
import { ExperienceCopilotMobileInputArea } from "./ExperienceCopilotMobileInputArea.js";
import {
  allReviewHunkIds,
  applyHunksToBuffer,
  buildBufferReview,
  ExperienceCopilotEditorPanel,
  mergedReviewText,
  revertHunksFromBuffer,
  type CopilotBufferReview,
} from "./ExperienceCopilotEditorPanel.js";
import { useShallow } from "zustand/react/shallow";
import { mergeSelectedBody } from "../../../../lib/coauthor-hunk-merge.js";

/**
 * ExperienceCopilotShell (ER-11d / ER-13b′) — the visible 2-pane copilot
 * editor surface: chat-left (propose rules/visual edits → review activity
 * cards → Apply) and editor-right (manually edit the two canonical buffers via
 * CodeEditor). The tester / preview / sandbox surfaces are NO LONGER a bottom
 * panel (ER-13b): they are top-of-editor toolbar buttons that open modals
 * (Tester → InteractiveTester, Preview → ExperienceFrame, Sandbox →
 * ExperiencePlayground). On mobile it collapses to a 2-tab `[Chat][Edit]` bar.
 *
 * CONTROLLED. This component owns NO canonical buffer text — `rulesCode` /
 * `visualSource` are props from the parent (ER-13 wires this into
 * `ExperienceEditor`), and every edit routes back through `onRulesChange` /
 * `onVisualChange`. The only buffers the shell holds are session state
 * (threadId / messages / loading / error), the provider/model selection, the
 * UI-only tab selection, and the toolbar modal open flags.
 *
 * Responsive pattern mirrors `CoauthorMode`: both panes stay MOUNTED across
 * mobile tab switches (only `hidden` toggles) so the CodeMirror editor and the
 * chat scroll positions survive. The editor pane reuses the same components on
 * desktop and mobile; only the chat InputArea forks (desktop →
 * `ExperienceCopilotInputArea`, mobile → `ExperienceCopilotMobileInputArea`),
 * chosen via the shared `useIsMobile` hook.
 *
 * In CREATION MODE (`creationMode`, ER-13d-1) the editor toggle becomes
 * 3-position `[Rules | Visual | Sandbox]`, the shared playground renders
 * INLINE on the `sandbox` position, and the sandbox toolbar button + modal are
 * hidden. Non-creation mode is byte-identical to the ER-13b′ surface.
 */

export interface ExperienceCopilotShellProps {
  scriptId: string;
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
  /** CREATION MODE (ER-13d-1): swaps the editor toggle for a 3-position
   *  `[Rules | Visual | Sandbox]` control, renders the playground INLINE on
   *  the `sandbox` position, and hides the sandbox toolbar button + modal.
   *  Defaults to false — the shell is byte-identical to the ER-13b′ surface
   *  (2-position toggle + tester/preview/sandbox modals). */
  creationMode?: boolean;
  /** The copilot profile currently assigned to this experience
   *  (`scripts.copilotProfileId`), or null (built-in seed). Drives the gear
   *  button's profile modal highlight + assignment (CP-8/CP-9). */
  assignedProfileId?: string | null;
}

type MobileTab = "chat" | "edit";

/** Stable empty fallback for the turn-store selector (a fresh `[]` per call
 *  would break useShallow's reference equality and re-render every keystroke). */
const EMPTY_ACTIVITIES: readonly ExperienceCopilotToolActivity[] = [];
type EditorBuffer = "rules" | "visual" | "sandbox";

export function ExperienceCopilotShell({
  scriptId,
  rulesCode,
  onRulesChange,
  visualSource,
  onVisualChange,
  rulesToolbar,
  visualToolbar,
  creationMode = false,
  assignedProfileId = null,
}: ExperienceCopilotShellProps) {
  const isMobile = useIsMobile();
  const { t } = useT();

  // ── Session lifecycle state ──────────────────────────────────────────────
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ExperienceCopilotMessageWire[]>([]);
  const [sessions, setSessions] = useState<ExperienceCopilotThreadWire[]>([]);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);

  // ── Provider / model selection (persisted binding, then controlled) ───────
  // The selection lives in server-side uiSettings (copilotProviderId /
  // copilotModelName — the Co-Author binding pattern) so it survives leaving
  // the editor and reloads. A dangling id (deleted profile) is ignored → the
  // first-available default below takes over, mirroring resolveCoauthorBinding's
  // dangling-fallback semantics.
  const savedCopilotBinding = useBootstrapStore((s) => s.data?.uiSettings);
  const profiles = useProviderDataStore((s) => s.profiles);
  const [providerProfileId, setProviderProfileId] = useState<string | null>(null);
  const [model, setModel] = useState<string | undefined>(undefined);
  const { models } = useProviderModels(providerProfileId);

  // ── UI-only tab state ────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<MobileTab>("chat");
  const [editorBuffer, setEditorBuffer] = useState<EditorBuffer>("rules");

  // ── Toolbar modal open state (tester / preview / sandbox) ────────────────
  const [testerOpen, setTesterOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [sandboxOpen, setSandboxOpen] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);

  // ER-14: the latest test/simulate digest the user sent back from the test
  // panel (set by `handleSendToCopilot`). Carried on EVERY subsequent copilot
  // send (desktop + mobile InputArea) as `testFeedback` so a manual follow-up
  // message also carries the latest test feedback (it survives history
  // compaction as a system-level JSON context section).
  const [testFeedback, setTestFeedback] = useState<Record<string, unknown> | undefined>(undefined);
  // UX 2026-08-16 remark 6 — prefill handed to the chat input on "send to
  // copilot" (see handleSendToCopilot). Object identity is the trigger.
  const [inputPrefill, setInputPrefill] = useState<{ text: string } | null>(null);

  // Resolve the provider ONCE per pass: the saved binding wins when it still
  // exists; a dangling/absent saved id falls back to the first available
  // profile. (One effect — a separate "default" effect would race the restore
  // in the same commit and the last setState would win, clobbering the saved
  // binding — exactly the bug this persistence fixes.)
  const savedProviderId = savedCopilotBinding?.copilotProviderId ?? null;
  useEffect(() => {
    if (providerProfileId !== null) return;
    if (savedProviderId && profiles.some((p) => p.id === savedProviderId)) {
      setProviderProfileId(savedProviderId);
      return;
    }
    const first = profiles[0];
    if (first) setProviderProfileId(first.id);
  }, [profiles, providerProfileId, savedProviderId]);

  // Same one-shot resolution for the model: the saved model when it is still
  // offered by the (restored) profile, else the first available model. A
  // dangling model id (deleted/renamed upstream) falls through to the default.
  const savedModelName = savedCopilotBinding?.copilotModelName ?? null;
  useEffect(() => {
    if (model !== undefined) return;
    if (savedModelName && models.some((m) => m.id === savedModelName)) {
      setModel(savedModelName);
      return;
    }
    const first = models[0];
    if (first) setModel(first.id);
  }, [models, model, savedModelName]);

  const handleProviderChange = useCallback((profileId: string, nextModel?: string) => {
    setProviderProfileId(profileId);
    setModel(nextModel);
    // Persist the explicit selection (fire-and-forget; a failure only means the
    // next entry defaults again — surfaced via toast for transparency).
    void patchUiSettingsAction({
      ...(profileId ? { copilotProviderId: profileId } : { copilotProviderId: null }),
      ...(nextModel ? { copilotModelName: nextModel } : { copilotModelName: null }),
    }).catch(() => {
      toast.error(t("experience_copilot_binding_save_error"));
    });
  }, [t]);

  // ── Session load (mount + retry) ─────────────────────────────────────────
  const loadSession = useCallback(async () => {
    setSessionLoading(true);
    setSessionError(null);
    try {
      const active = await getExperienceCopilotActive(scriptId);
      if (active) {
        setThreadId(active.id);
        const msgs = await listExperienceCopilotMessages(active.id);
        setMessages(msgs);
      } else {
        const thread = await startExperienceCopilotSession(scriptId);
        setThreadId(thread.id);
        setMessages([]);
      }
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : t("experience_copilot_load_session_error"));
    } finally {
      setSessionLoading(false);
    }
  }, [scriptId]);

  // Session list (active + archived) for the switcher. Fetched in parallel with
  // `loadSession` on mount, then refetched after every switch/new so the active
  // indicator and archived set stay current.
  const fetchSessions = useCallback(async () => {
    try {
      const list = await listExperienceCopilotSessions(scriptId);
      setSessions(list);
    } catch {
      // Best-effort session-list fetch — a transient list failure leaves the
      // switcher with its last-known sessions rather than surfacing an error.
    }
  }, [scriptId]);

  useEffect(() => {
    rehydrateExperienceCopilotDrafts();
    void loadSession();
    void fetchSessions();
  }, [loadSession, fetchSessions]);

  // ── Stream controller ────────────────────────────────────────────────────
  // Refetch persisted messages after each turn settles: the live `pendingText`
  // is cleared and the persisted assistant message takes over.
  const handleTurnSettled = useCallback(() => {
    if (!threadId) return;
    listExperienceCopilotMessages(threadId)
      .then(setMessages)
      .catch(() => {
        // Best-effort refetch — swallow so a transient list failure leaves the
        // last-known messages on screen rather than surfacing a spurious error.
      });
  }, [threadId]);

  // CM-8: context meter state per thread (metrics / auto-compact / compact).
  // `onCompacted` refetches messages so the newly appended digest message
  // renders as a card at its anchor boundary.
  const copilotContext = useCopilotContext({
    threadId,
    onCompacted: handleTurnSettled,
    compactProvider: {
      ...(providerProfileId ? { providerProfileId } : {}),
      ...(model ? { model } : {}),
    },
  });

  const ctrl = useExperienceCopilotController({
    threadId,
    providerProfileId,
    model,
    onTurnSettled: handleTurnSettled,
    onMetrics: copilotContext.applyMetrics,
  });

  // ── Review state (CD-2/CD-3): freeze, snapshots, revert ────────────────
  // The live turn's activities feed the review hook (proposal aggregation);
  // the SAME store read the MessageList does, subscribed here so the shell
  // doesn't reach into the store from inside the toolbar render.
  const turnActivities = useExperienceCopilotTurnStore(
    useShallow((s) => (threadId ? s.turnsByThread[threadId] ?? EMPTY_ACTIVITIES : EMPTY_ACTIVITIES)),
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
    threadId: threadId ?? "",
    isSending: ctrl.isSending,
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
    useShallow((s) => (threadId ? s.roundsByThread[threadId] ?? EMPTY_REVIEW_ROUND : EMPTY_REVIEW_ROUND)),
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
      if (threadId) useCopilotReviewRoundStore.getState().setAcceptedHunks(threadId, "rules", [...next]);
    },
    [threadId],
  );
  const setAcceptedVisualHunks = useCallback(
    (next: Set<number>) => {
      if (threadId) useCopilotReviewRoundStore.getState().setAcceptedHunks(threadId, "visual", [...next]);
    },
    [threadId],
  );
  const setDismissedRulesHunks = useCallback(
    (next: Set<number>) => {
      if (threadId) useCopilotReviewRoundStore.getState().setDismissedHunks(threadId, "rules", [...next]);
    },
    [threadId],
  );
  const setDismissedVisualHunks = useCallback(
    (next: Set<number>) => {
      if (threadId) useCopilotReviewRoundStore.getState().setDismissedHunks(threadId, "visual", [...next]);
    },
    [threadId],
  );

  // CD-8 dangling semantics: a new chat turn must NOT kill an unresolved
  // review. The controller clears the live turn store at send start (the
  // audit feed stays per-turn, and history cards un-hide), so the still-pending
  // proposal is captured here before the send — it keeps hanging until the
  // model revises it (the live proposal wins per buffer, last-wins) or the
  // user resolves it by hand (accept / revert). Nothing is auto-applied.
  const dangling = round.dangling;
  const proposalRef = useRef(review.proposal);
  const proposalBaseRef = useRef(review.proposalBase);
  proposalRef.current = review.proposal;
  proposalBaseRef.current = review.proposalBase;
  const captureDangling = useCallback(() => {
    if (!threadId) return;
    if (!proposalRef.current.hasProposal) return;
    useCopilotReviewRoundStore.getState().captureDangling(threadId, {
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
    if (threadId) useCopilotReviewRoundStore.getState().ensureReviewKey(threadId, "rules", rulesReviewKey);
  }, [threadId, rulesReviewKey]);
  useEffect(() => {
    if (threadId) useCopilotReviewRoundStore.getState().ensureReviewKey(threadId, "visual", visualReviewKey);
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
    () => buildBufferReview(effRules.base, effRules.proposed, acceptedRulesHunks, !ctrl.isSending, dismissedRulesHunks),
    [effRules, acceptedRulesHunks, dismissedRulesHunks, ctrl.isSending],
  );
  const visualReview = useMemo(
    () => buildBufferReview(effVisual.base, effVisual.proposed, acceptedVisualHunks, !ctrl.isSending, dismissedVisualHunks),
    [effVisual, acceptedVisualHunks, dismissedVisualHunks, ctrl.isSending],
  );

  // CD-8 conflict semantics. Clean path: the buffer is exactly the hybrid the
  // accept flow expects → rebuild from the snapshot base (mergeSelectedBody).
  // Drift path (the buffer changed outside the review — e.g. a template tool):
  // anchor the clicked hunks onto the CURRENT buffer; hunks whose old text no
  // longer appears are CONFLICTING — skipped (stay pending), never blocking
  // the rest, announced with a toast. No silent rebase, ever.
  const acceptHunks = useCallback(
    (
      bufferReview: CopilotBufferReview,
      prevAccepted: ReadonlySet<number>,
      clickedIds: readonly number[],
      bufferText: string,
      setAccepted: (next: Set<number>) => void,
      onChange: (text: string) => void,
    ) => {
      // tooLarge wholesale (RV-1): no hunk decomposition — accept applies the
      // whole proposal and resolves the sentinel id. (Before this branch the
      // drift path silently skipped every id and accept-all was a no-op.)
      if (!bufferReview.diff) {
        const nextWhole = new Set(prevAccepted);
        for (const id of clickedIds) nextWhole.add(id);
        setAccepted(nextWhole);
        if (bufferText !== bufferReview.proposed) onChange(bufferReview.proposed);
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
        setAccepted(next);
        if (applied.length > 0) onChange(text);
        if (skippedHunkIds.length > 0)
          toast.warning(t("copilot_review_hunks_skipped", { n: skippedHunkIds.length }));
        return;
      }
      const next = new Set(prevAccepted);
      for (const id of clickedIds) next.add(id);
      setAccepted(next);
      onChange(mergedReviewText(bufferReview, next));
    },
    [t],
  );

  const acceptRulesHunk = useCallback(
    (hunkId: number) => {
      if (!rulesReview) return;
      acceptHunks(rulesReview, acceptedRulesHunks, [hunkId], rulesCode, setAcceptedRulesHunks, onRulesChange);
    },
    [rulesReview, acceptedRulesHunks, rulesCode, onRulesChange, acceptHunks],
  );
  const acceptAllRules = useCallback(() => {
    if (!rulesReview) return;
    const pending = [...allReviewHunkIds(rulesReview)].filter((id) => !acceptedRulesHunks.has(id));
    acceptHunks(rulesReview, acceptedRulesHunks, pending, rulesCode, setAcceptedRulesHunks, onRulesChange);
  }, [rulesReview, acceptedRulesHunks, rulesCode, onRulesChange, acceptHunks]);

  // RV-2: dismiss (✕) — the hunk leaves the round; the buffer is untouched.
  const dismissRulesHunk = useCallback(
    (hunkId: number) => {
      if (!threadId) return;
      const state = useCopilotReviewRoundStore.getState();
      const current = state.roundsByThread[threadId];
      if (!current) return;
      state.setDismissedHunks(threadId, "rules", [...new Set([...current.dismissedRules, hunkId])]);
    },
    [threadId],
  );
  const dismissVisualHunk = useCallback(
    (hunkId: number) => {
      if (!threadId) return;
      const state = useCopilotReviewRoundStore.getState();
      const current = state.roundsByThread[threadId];
      if (!current) return;
      state.setDismissedHunks(threadId, "visual", [...new Set([...current.dismissedVisual, hunkId])]);
    },
    [threadId],
  );
  const acceptVisualHunk = useCallback(
    (hunkId: number) => {
      if (!visualReview) return;
      acceptHunks(visualReview, acceptedVisualHunks, [hunkId], visualSource, setAcceptedVisualHunks, onVisualChange);
    },
    [visualReview, acceptedVisualHunks, visualSource, onVisualChange, acceptHunks],
  );
  const acceptAllVisual = useCallback(() => {
    if (!visualReview) return;
    const pending = [...allReviewHunkIds(visualReview)].filter((id) => !acceptedVisualHunks.has(id));
    acceptHunks(visualReview, acceptedVisualHunks, pending, visualSource, setAcceptedVisualHunks, onVisualChange);
  }, [visualReview, acceptedVisualHunks, visualSource, onVisualChange, acceptHunks]);

  // RV-3: «Отменить все непринятые» — dismiss the PENDING hunks of THIS
  // buffer only (accepted hunks stay accepted, the other buffer and the text
  // are untouched). The round resolves once nothing is pending.
  const dismissPendingRules = useCallback(() => {
    if (!rulesReview || !threadId) return;
    const pending = [...allReviewHunkIds(rulesReview)].filter(
      (id) => !acceptedRulesHunks.has(id) && !dismissedRulesHunks.has(id),
    );
    if (pending.length === 0) return;
    const state = useCopilotReviewRoundStore.getState();
    const current = state.roundsByThread[threadId];
    if (!current) return;
    state.setDismissedHunks(threadId, "rules", [...new Set([...current.dismissedRules, ...pending])]);
  }, [rulesReview, acceptedRulesHunks, dismissedRulesHunks, threadId]);
  const dismissPendingVisual = useCallback(() => {
    if (!visualReview || !threadId) return;
    const pending = [...allReviewHunkIds(visualReview)].filter(
      (id) => !acceptedVisualHunks.has(id) && !dismissedVisualHunks.has(id),
    );
    if (pending.length === 0) return;
    const state = useCopilotReviewRoundStore.getState();
    const current = state.roundsByThread[threadId];
    if (!current) return;
    state.setDismissedHunks(threadId, "visual", [...new Set([...current.dismissedVisual, ...pending])]);
  }, [visualReview, acceptedVisualHunks, dismissedVisualHunks, threadId]);

  // RV-3: «Отменить все» — kill the whole round for THIS buffer: every hunk
  // (pending AND accepted) leaves the round (dismissed), and the hunks already
  // accepted into the buffer are rolled back — from the snapshot base on the
  // clean path, or by reverse-splicing their added lines off the drifted
  // buffer (non-anchoring hunks are skipped + toasted, never guessed). No
  // clearTurn, no snapshot pop, no setDangling — that is the toolbar revert's
  // job (CD-3).
  const cancelRoundHunks = useCallback(
    (
      bufferReview: CopilotBufferReview,
      prevAccepted: ReadonlySet<number>,
      prevDismissed: ReadonlySet<number>,
      bufferText: string,
      setDismissed: (next: Set<number>) => void,
      onChange: (text: string) => void,
    ) => {
      // tooLarge wholesale (RV-1): the round is only reachable while the
      // sentinel is PENDING (an accepted sentinel resolves the round and the
      // bar disappears), so cancelling just dismisses it — the buffer was
      // never touched by a pending proposal.
      if (!bufferReview.diff) {
        setDismissed(new Set([...prevDismissed, ...allReviewHunkIds(bufferReview)]));
        return;
      }
      const acceptedIds = [...allReviewHunkIds(bufferReview)].filter((id) => prevAccepted.has(id));
      const expected = mergedReviewText(bufferReview, prevAccepted);
      if (bufferText === expected) {
        // Clean path: rebuild from the snapshot base (no accepted hunks left).
        if (acceptedIds.length > 0) onChange(mergeSelectedBody(bufferReview.diff, new Set()));
      } else {
        const { text, skippedHunkIds } = revertHunksFromBuffer(
          bufferText,
          bufferReview.diff,
          bufferReview.hunks,
          new Set(acceptedIds),
        );
        const reverted = acceptedIds.filter((id) => !skippedHunkIds.includes(id));
        if (reverted.length > 0) onChange(text);
        if (skippedHunkIds.length > 0)
          toast.warning(t("copilot_review_hunks_skipped", { n: skippedHunkIds.length }));
      }
      setDismissed(new Set([...prevDismissed, ...allReviewHunkIds(bufferReview)]));
    },
    [t],
  );

  const cancelRoundRules = useCallback(() => {
    if (!rulesReview) return;
    cancelRoundHunks(rulesReview, acceptedRulesHunks, dismissedRulesHunks, rulesCode, setDismissedRulesHunks, onRulesChange);
  }, [rulesReview, acceptedRulesHunks, dismissedRulesHunks, rulesCode, onRulesChange, cancelRoundHunks]);
  const cancelRoundVisual = useCallback(() => {
    if (!visualReview) return;
    cancelRoundHunks(visualReview, acceptedVisualHunks, dismissedVisualHunks, visualSource, setDismissedVisualHunks, onVisualChange);
  }, [visualReview, acceptedVisualHunks, dismissedVisualHunks, visualSource, onVisualChange, cancelRoundHunks]);

  const handleToolbarRevert = useCallback(() => {
    if (threadId) useCopilotReviewRoundStore.getState().clearDangling(threadId);
    review.revertLastTurn();
    toast.success(t("copilot_review_reverted"));
  }, [review, t, threadId]);

  // ER-14: copy a test/simulate/playground digest into the copilot chat input.
  // UX 2026-08-16 remark 6: this must NOT dispatch the turn — the button copies
  // the digest text into the input and the user sends it themselves. The
  // structured `feedback` is still captured now so the next manual send carries
  // it (testFeedback survives until overwritten, per ER-14).
  const handleSendToCopilot = useCallback(
    (digest: CopilotDigest) => {
      setTestFeedback(digest.feedback);
      setInputPrefill({ text: digest.text });
      toast.success(t("experience_copilot_result_copied"));
    },
    [t],
  );

  // ── Session switch / new (ER-12b) ────────────────────────────────────────
  // Both are NO-OP while a turn is streaming (the switcher is also visually
  // disabled via `disabled={ctrl.isSending}`): switching `threadId` mid-stream
  // would race the in-flight stream's settle-closure. On failure, `threadId` /
  // `messages` are left UNCHANGED (no half-switch) and an error toast surfaces.
  const handleActivate = useCallback(
    async (targetThreadId: string) => {
      if (ctrl.isSending) return;
      try {
        const activated = await activateExperienceCopilotSession(targetThreadId);
        if (!activated) {
          toast.error(t("experience_copilot_switch_error"));
          return;
        }
        setThreadId(targetThreadId);
        const msgs = await listExperienceCopilotMessages(targetThreadId);
        setMessages(msgs);
        await fetchSessions();
      } catch {
        // Best-effort — leave threadId/messages unchanged and surface the error.
        toast.error(t("experience_copilot_switch_error"));
      }
    },
    [ctrl.isSending, fetchSessions, t],
  );

  const handleNewSession = useCallback(async () => {
    if (ctrl.isSending) return;
    try {
      const thread = await startExperienceCopilotSession(scriptId);
      setThreadId(thread.id);
      setMessages([]);
      await fetchSessions();
    } catch {
      // Best-effort — leave threadId/messages unchanged and surface the error.
      toast.error(t("experience_copilot_new_session_error"));
    }
  }, [ctrl.isSending, scriptId, fetchSessions, t]);

  // ── Mobile auto-switch on proposal ───────────────────────────────────────
  // A proposal becomes reviewable in the Chat pane (activity cards + Apply), so
  // when one lands on mobile the surface jumps there. Ref-guarded edge mirroring
  // CoauthorMode's `useCoauthorMobileTab`, without the pulse polish.
  const hasProposal = useExperienceCopilotTurnStore((s) => {
    if (!threadId) return false;
    const activities = s.turnsByThread[threadId] ?? [];
    return activities.some(
      (a) => a.status === "done" && a.target !== undefined && a.proposed !== undefined,
    );
  });
  const prevHasProposal = useRef(hasProposal);
  useEffect(() => {
    const was = prevHasProposal.current;
    prevHasProposal.current = hasProposal;
    if (!was && hasProposal && isMobile) {
      setActiveTab("chat");
    }
  }, [hasProposal, isMobile]);

  // ── Creation-mode editor toggle options ──────────────────────────────────
  // Non-creation keeps the original inline-English 2-option constant; creation
  // adds the i18n-labelled `sandbox` position (ER-13d-1). Built here because
  // the creation labels resolve through `t`.
  // Buffer-tab labels with the pending-review dot (CD-6): a tab whose buffer
  // has unaccepted hunks carries an accent dot (per the settled vision: the
  // OTHER tab must signal pending diffs; showing it on both tabs is harmless
  // and simpler than hiding the active one's).
  const tabLabel = (value: "rules" | "visual", label: string) => {
    const pending = value === "rules" ? rulesReview !== null : visualReview !== null;
    if (!pending) return label;
    return (
      <span className="inline-flex items-center gap-1.5">
        {label}
        <span
          data-testid={`copilot-buffer-dot-${value}`}
          title={t("copilot_review_pending_badge")}
          className="h-1.5 w-1.5 rounded-full bg-accent"
        />
      </span>
    );
  };

  const bufferOptions = creationMode
    ? [
        { value: "rules", label: tabLabel("rules", t("experience_copilot_rules")) },
        { value: "visual", label: tabLabel("visual", t("experience_copilot_visual")) },
        { value: "sandbox", label: t("experience_copilot_sandbox") },
      ]
    : [
        { value: "rules", label: tabLabel("rules", t("experience_copilot_rules")) },
        { value: "visual", label: tabLabel("visual", t("experience_copilot_visual")) },
      ];

  // IR-90A: exactly one ExperiencePlayground element is shared by the two
  // surfaces. In creation mode it renders INLINE on the `sandbox` position;
  // otherwise it renders inside the sandbox modal. The branches are mutually
  // exclusive, so a single instance ever mounts.
  const playground = <ExperiencePlayground code={rulesCode} visualSource={visualSource || null} scriptId={scriptId} onSendToCopilot={handleSendToCopilot} />;

  // ── Pane content (shared between desktop/mobile, mounted by branch) ──────
  const chatPane = (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      {sessionLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<Icons.Sparkles className="h-6 w-6 animate-pulse text-t3" />}
            title={t("experience_copilot_loading")}
          />
        </div>
      ) : sessionError ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<Icons.Close className="h-6 w-6 text-danger-text" />}
            title={t("experience_copilot_load_error")}
            sub={sessionError}
            cta={<span>{t("experience_copilot_retry")}</span>}
            onCta={() => void loadSession()}
          />
        </div>
      ) : threadId ? (
        <>
          <div className="flex shrink-0 items-center border-b border-border bg-surface px-2 py-1.5">
            <ExperienceSessionSwitcher
              sessions={sessions}
              activeThreadId={threadId}
              disabled={ctrl.isSending}
              onActivate={handleActivate}
              onNew={handleNewSession}
            />
            <button
              type="button"
              data-testid="copilot-profile-gear-btn"
              aria-label={t("copilot_profile_title")}
              title={t("copilot_profile_title")}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-t3 transition-colors hover:bg-s2 hover:text-t1"
              onClick={() => setProfileModalOpen(true)}
            >
              <Icons.Settings className="h-3.5 w-3.5" />
            </button>
          </div>
          <ExperienceContextMeter
            metrics={copilotContext.metrics}
            autoCompact={copilotContext.autoCompact}
            isCompacting={copilotContext.isCompacting}
            isSending={ctrl.isSending}
            onCompact={() =>
              void copilotContext.compact().catch((err: unknown) => {
                // Surface the server's reason (typed 400s carry a meaningful
                // message, e.g. "Nothing to compact…") instead of a generic label.
                const message = err instanceof Error && err.message ? err.message : "";
                toast.error(message || t("copilot_context_compact_error"));
              })
            }
            onToggleAutoCompact={(enabled) =>
              void copilotContext.setAutoCompact(enabled).catch(() => {
                toast.error(t("copilot_context_auto_toggle_error"));
              })
            }
          />
          <ExperienceCopilotMessageList
            threadId={threadId}
            messages={messages}
            pendingText={ctrl.pendingText}
            pendingReasoning={ctrl.pendingReasoning}
            pendingUserContent={ctrl.pendingUserContent}
          />
          {isMobile ? (
            <ExperienceCopilotMobileInputArea
              isSending={ctrl.isSending}
              prefill={inputPrefill ?? undefined}
              onSend={(content) => {
                captureDangling();
                void ctrl.handleSend(content, {
                  rules: rulesCode,
                  visual: visualSource,
                  step: editorBuffer === "visual" ? "visual" : editorBuffer === "sandbox" ? "test" : "rules",
                  ...(testFeedback !== undefined ? { testFeedback } : {}),
                });
              }}
              onCancel={ctrl.handleCancel}
              providerProfileId={providerProfileId}
              model={model}
              onProviderChange={handleProviderChange}
            />
          ) : (
            <ExperienceCopilotInputArea
              isSending={ctrl.isSending}
              prefill={inputPrefill ?? undefined}
              onSend={(content) => {
                captureDangling();
                void ctrl.handleSend(content, {
                  rules: rulesCode,
                  visual: visualSource,
                  step: editorBuffer === "visual" ? "visual" : editorBuffer === "sandbox" ? "test" : "rules",
                  ...(testFeedback !== undefined ? { testFeedback } : {}),
                });
              }}
              onCancel={ctrl.handleCancel}
              providerProfileId={providerProfileId}
              model={model}
              onProviderChange={handleProviderChange}
            />
          )}
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<Icons.Sparkles className="h-6 w-6 text-t3" />}
            title={t("experience_copilot_title")}
            sub={t("experience_copilot_subtitle")}
          />
        </div>
      )}
    </div>
  );

  const editorPane = (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2">
        <SegmentedControl
          value={editorBuffer}
          options={bufferOptions}
          onChange={(value) =>
            setEditorBuffer(value === "sandbox" ? "sandbox" : value === "visual" ? "visual" : "rules")
          }
          compact
        />
        {editorBuffer !== "sandbox" && (
          <div className="flex items-center gap-1.5">
            {review.canRevert && (
              <ToolbarButton
                label={t("copilot_review_revert")}
                icon={<Icons.Undo />}
                onClick={handleToolbarRevert}
                testId="copilot-toolbar-revert"
              />
            )}
            <ToolbarButton
              label={t("experience_copilot_tester")}
              icon={<Icons.Terminal />}
              onClick={() => setTesterOpen(true)}
              testId="copilot-toolbar-tester"
            />
            <ToolbarButton
              label={t("experience_copilot_preview")}
              icon={<Icons.Eye />}
              onClick={() => setPreviewOpen(true)}
              testId="copilot-toolbar-preview"
            />
            {!creationMode && (
              <ToolbarButton
                label={t("experience_copilot_sandbox")}
                icon={<Icons.Dice />}
                onClick={() => setSandboxOpen(true)}
                testId="copilot-toolbar-sandbox"
              />
            )}
          </div>
        )}
      </div>
      {editorBuffer === "sandbox" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">{playground}</div>
      ) : (
        <>
          {editorBuffer === "rules" ? rulesToolbar : visualToolbar}
          {/* CD-6: the review-mode editor (inline diff + review bar). The
              accept-selection state lives here in the shell so it survives
              buffer-tab switches (the panel remounts per tab). */}
          <ExperienceCopilotEditorPanel
            value={editorBuffer === "rules" ? rulesCode : visualSource}
            onChange={editorBuffer === "rules" ? onRulesChange : onVisualChange}
            isSending={ctrl.isSending}
            review={editorBuffer === "rules" ? rulesReview : visualReview}
            acceptedHunkIds={editorBuffer === "rules" ? acceptedRulesHunks : acceptedVisualHunks}
            dismissedHunkIds={editorBuffer === "rules" ? dismissedRulesHunks : dismissedVisualHunks}
            onAcceptHunk={editorBuffer === "rules" ? acceptRulesHunk : acceptVisualHunk}
            onAcceptAll={editorBuffer === "rules" ? acceptAllRules : acceptAllVisual}
            onDismissHunk={editorBuffer === "rules" ? dismissRulesHunk : dismissVisualHunk}
            onDismissPending={editorBuffer === "rules" ? dismissPendingRules : dismissPendingVisual}
            onCancelRound={editorBuffer === "rules" ? cancelRoundRules : cancelRoundVisual}
          />
        </>
      )}
    </div>
  );

  // ── Toolbar modals (tester / preview / sandbox) ──────────────────────────
  // The tester/preview/sandbox surfaces moved OUT of a bottom panel (ER-13b)
  // into top-of-editor toolbar buttons that open these modals. The sandbox
  // modal hosts the shared `playground` element only in non-creation mode; in
  // creation mode that same element renders INLINE on the `sandbox` toggle
  // position instead (mutually exclusive — IR-90A single-instance). Exactly one
  // ExperienceFrame is mounted (the preview modal); the sandbox's own frame is
  // nested inside ExperiencePlayground, not rendered directly by this shell.
  const modals = (
    <>
      <ShellModal
        open={testerOpen}
        onClose={() => setTesterOpen(false)}
        title={t("experience_copilot_tester_title")}
        testId="copilot-tester-modal"
      >
        <InteractiveTester code={rulesCode} onSendToCopilot={handleSendToCopilot} />
      </ShellModal>

      <ShellModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={t("experience_copilot_preview_title")}
        testId="copilot-preview-modal"
      >
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
      </ShellModal>

      {!creationMode && (
        <ShellModal
          open={sandboxOpen}
          onClose={() => setSandboxOpen(false)}
          title={t("experience_copilot_sandbox_title")}
          testId="copilot-sandbox-modal"
        >
          {playground}
        </ShellModal>
      )}

      <CopilotProfileModal
        scriptId={scriptId}
        assignedProfileId={assignedProfileId}
        isOpen={profileModalOpen}
        onClose={() => setProfileModalOpen(false)}
      />
    </>
  );

  if (isMobile) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className="flex shrink-0 border-b border-border bg-surface"
          role="tablist"
          aria-label={t("experience_copilot_editor_aria")}
        >
          <TabButton label={t("experience_copilot_tab_chat")} active={activeTab === "chat"} onClick={() => setActiveTab("chat")} />
          <TabButton label={t("experience_copilot_tab_edit")} active={activeTab === "edit"} onClick={() => setActiveTab("edit")} />
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className={cn("flex min-h-0 flex-1 flex-col", activeTab !== "chat" && "hidden")} data-testid="copilot-pane-chat">
            {chatPane}
          </div>
          <div className={cn("flex min-h-0 flex-1 flex-col", activeTab !== "edit" && "hidden")} data-testid="copilot-pane-edit">
            {editorPane}
          </div>
        </div>
        {modals}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 w-[440px] shrink-0 flex-col border-r border-border">{chatPane}</div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{editorPane}</div>
      {modals}
    </div>
  );
}

interface TabButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

function TabButton({ label, active, onClick }: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "relative flex flex-1 items-center justify-center gap-1.5 py-2.5 font-ui text-[0.9rem] font-medium transition-colors",
        active ? "border-b-2 border-accent text-t1" : "border-b-2 border-transparent text-t3",
      )}
    >
      {label}
    </button>
  );
}

interface ToolbarButtonProps {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  testId: string;
}

function ToolbarButton({ label, icon, onClick, testId }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 py-1.5 font-ui text-[12px] font-medium text-t2 transition-colors hover:bg-s2 hover:text-t1"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

interface ShellModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  testId: string;
  children: ReactNode;
}

/** Shared modal chrome for the three toolbar surfaces (tester / preview /
 *  sandbox). Reuses the app's shared {@link Modal} shell; the panel mirrors the
 *  ExperienceSetupModal header/body pattern (title + close header, scrollable
 *  body). Full-screen on mobile via the shared Modal. */
function ShellModal({ open, onClose, title, testId, children }: ShellModalProps) {
  const isMobile = useIsMobile();
  const { t } = useT();
  return (
    <Modal open={open} onClose={onClose} title={title} description={title}>
      <div
        className={cn(
          isMobile
            ? "flex h-full w-full flex-col bg-surface"
            : "flex max-h-[88vh] w-[min(760px,94vw)] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-xl",
        )}
        data-testid={testId}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
          <h2 className="min-w-0 flex-1 truncate font-ui text-sm font-semibold text-t1">{title}</h2>
          <button
            type="button"
            className="rounded p-1 text-t4 hover:bg-s3 hover:text-t2"
            onClick={onClose}
            aria-label={t("experience_setup_close")}
          >
            <Icons.Close />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
      </div>
    </Modal>
  );
}
