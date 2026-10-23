import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import type { Extension } from "@codemirror/state";
import { SCRIPT_AGENT_TOOL_KEYS } from "@vibe-tavern/api-contracts";
import { agentThreadKey, registerAgentHost, scriptOwnerId, type AgentHostBridge, type AgentKind, type AgentSendOptions } from "../../../lib/agent-host-registry.js";
import type { TFunc } from "../../../i18n/locale-helpers.js";
import { useT } from "../../../i18n/context.js";
import type { ScriptLinkRecord, ScriptRecord } from "../../../api/types.js";
import type { ScriptDraftValues } from "../../../stores/script-draft-store.js";
import type { LinkTarget } from "../../shared/LinkBindingPopover.js";
import {
  allReviewHunkIds,
  applyHunksToBuffer,
  buildBufferReview,
  mergedReviewText,
  revertHunksFromBuffer,
  type CopilotBufferReview,
} from "../../shared/agent-shell/AgentBufferReviewEditor.js";
import { agentDiffExtensions, computeDiffDecorationSpecs } from "../../shared/agent-shell/AgentDiffDecorations.js";
import { useAgentTurnStore, type AgentToolActivity } from "../../../stores/agent-turn-store.js";
import { EMPTY_REVIEW_ROUND, useAgentReviewRoundStore } from "../../../stores/agent-review-store.js";
import { mergeSelectedBody } from "../../../lib/coauthor-hunk-merge.js";
import { parseAgentToolOutput } from "../../../lib/agent-tool-output.js";
import {
  activateScriptAgentSession,
  answerScriptAgentAsk,
  deleteScriptAgentTurn,
  getScriptAgentActive,
  listScriptAgentMessages,
  listScriptAgentSessions,
  renameScriptAgentSession,
  setScriptAgentContextLinks,
  startScriptAgentSession,
  streamScriptAgent,
} from "../../../api/script-agent-api.js";
import { ScriptAgentEditorTabs, type ScriptEditorTab } from "./script-agent-editor-pane.js";
import { useAgentPendingReviewPublish } from "../../shared/agent-shell/use-agent-pending-review-publish.js";

/**
 * The `script` agent host (AGENT_SHELL_PLAN, Wave 4 / AS-8b) — the script
 * editor's AI assistant as the SECOND registered host of the generic
 * `AgentShell` (the experience host is the structural template). Everything
 * the shell deliberately does not know lives here: the single `code` buffer's
 * hunk review (decorations JOIN the AS-8a `scriptSafetyExtensions` seam — the
 * tabbed editor pane freezes via its `codeReadOnly` prop while a review round
 * shows the proposed document), the per-turn send options
 * (`{ code, scriptKind, codeSaved }` — the LIVE merged draft, never a stale
 * DB read), and the transport (the script client).
 *
 * The wrapper (`useScriptPanel`, ScriptEditor.tsx) builds the host props from
 * the SAME state the management bar reads — the tabbed `ScriptAgentEditorTabs`
 * pane (Code/Test) renders them, and the review session reads the live draft
 * through them. `renderEditorPane` narrows the opaque `ctx.hostProps` here
 * (wrapper and host are a pair).
 *
 * REVIEW-ROUND STORE MAPPING (interim, documented): the round store's slots
 * are experience-flavored (`rules`/`visual`); the script kind rides its ONE
 * buffer in the `rules` slot of its KIND-NAMESPACED slice
 * (`script:<threadId>` — no experience thread can collide). The snapshot's
 * `rules` field carries the code buffer's turn-start text. AS-10's store
 * generalization over buffer ids replaces this mapping.
 */

/** The kind this host registers under — the single spelling for every store
 *  key in this module (`agentThreadKey(SCRIPT_KIND, threadId)`). */
const SCRIPT_KIND: AgentKind = "script";

/** Stable empty fallback avoids a fresh selector array every host render. */
const EMPTY_ACTIVITIES: readonly AgentToolActivity[] = [];

/**
 * AS-8e5: the `run_script_test` caption — the result envelope is a machine
 * shape (`{ok, kind, ...}` / the `script_not_trusted` refusal) that must
 * never render as a raw JSON title (live `summarizeToolOutput` or the
 * persisted tool-result text on reload). Parses `activity.summary` safely
 * (unwrapping the persisted `{toolName, output}` wrapper); unparseable or a
 * non-`run_script_test` tool returns undefined and keeps today's fallback.
 * `ok === true` → the passed caption; otherwise the failed caption with the
 * first of `errors[0].error` / `errorMessage` / `discoveryError` / the first
 * failed sample roll (`<checkId>: <error>` — since AS-8e6 a dice roll that
 * fails validation makes the whole test fail with no other detail source;
 * existing order stays first) as detail.
 */
function scriptTestCaption(activity: AgentToolActivity): { titleKey: "agent_script_test_ok" | "agent_script_test_failed"; detail?: string } | undefined {
  if (activity.toolName !== "run_script_test") return undefined;
  const record = parseAgentToolOutput(activity);
  if (record === undefined) return undefined;
  if (record.ok === true) return { titleKey: "agent_script_test_ok" };
  let detail: string | undefined;
  const errors = (record as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as Record<string, unknown> | undefined;
    if (first !== undefined && typeof first.error === "string") detail = first.error;
  }
  if (detail === undefined && typeof record.errorMessage === "string") detail = record.errorMessage;
  if (detail === undefined) {
    const discovery = (record as { discoveryError?: unknown }).discoveryError;
    if (typeof discovery === "string") detail = discovery;
  }
  // AS-8e6: the dice envelope's LAST detail source — the first sample roll
  // whose result failed (a dice test can fail with no errors, no errorMessage
  // and a null discoveryError; the failed roll's error is the fix target).
  if (detail === undefined) {
    const rolls = (record as { sampleRolls?: unknown }).sampleRolls;
    if (Array.isArray(rolls)) {
      for (const roll of rolls) {
        if (typeof roll !== "object" || roll === null) continue;
        const r = roll as { checkId?: unknown; result?: unknown };
        if (typeof r.result !== "object" || r.result === null) continue;
        const res = r.result as { ok?: unknown; error?: unknown };
        if (res.ok === false && typeof res.error === "string" && typeof r.checkId === "string") {
          detail = `${r.checkId}: ${res.error}`;
          break;
        }
      }
    }
  }
  return detail !== undefined ? { titleKey: "agent_script_test_failed", detail } : { titleKey: "agent_script_test_failed" };
}

/** The wrapper's host-specific props: exactly what the tabbed editor pane
 *  and the review session read (nothing the management bar keeps for
 *  itself). No back control — the lore editor's own editorHeader caret is
 *  the script view's back control on both viewports (AS-8c3b). */
export interface ScriptAgentHostProps {
  isMobile: boolean;
  activeScript: ScriptRecord;
  activeScriptId: string;
  draftDirty: boolean;
  apiRefOpen: boolean;
  /** The wrapper's lint + reveal extensions; the hunk-review
   *  decorations join these (the AS-8a seam). */
  scriptSafetyExtensions: Extension[];
  characterName: string | undefined;
  /** AS-8e3 — the build panel's current character (the old modal's
   *  scopeContext parity); sent on every turn so the backend renders its
   *  full card. */
  contextCharacterId: string | undefined;
  /** AS-8e3 — the build panel's current persona (undefined when the panel
   *  has none); omitted from the body then. */
  contextPersonaId: string | undefined;
  /** Bound links + pick-list targets — the editor pane's toolbar strip reads
   *  them (re-added by AS-8c4e; AS-8c4c had removed them while unread). */
  scriptLinks: ScriptLinkRecord[];
  linkCharacters: LinkTarget[];
  linkPersonas: LinkTarget[];
  onSetScriptLinks: (
    next: Array<{ targetType: "character" | "persona"; targetId: string }>,
  ) => void;
  onUpdateDraft: (patch: Partial<ScriptDraftValues>) => void;
  onToggleApiRef: () => void;
  onAddFromTemplate: (key: string) => void;
  onRevealLine: (line: number) => void;
}

// ─── Review session (single `code` buffer) ───────────────────────────────────

/** Owns the script host's review round: the turn-start snapshot (the diff's
 *  "before" side), the last-wins pending proposal (live turn first, the
 *  dangling capture after a new turn starts — CD-8 semantics), and the
 *  accept/dismiss selection (the round store's `rules` slot — see the module
 *  comment). The pure diff engine (hunk merge, drift apply, revert) is the
 *  shared `AgentBufferReviewEditor` module's — single-buffer use of the same
 *  primitives the experience host drives. */
function useScriptAgentReviewSession({
  bridge,
  code,
  codeSaved,
  contextCharacterId,
  contextPersonaId,
  isSending,
  onUpdateDraft,
  openReview,
  scriptKind,
  t,
  threadId,
}: {
  bridge: AgentHostBridge;
  code: string;
  codeSaved: boolean | undefined;
  contextCharacterId: string | undefined;
  contextPersonaId: string | undefined;
  isSending: boolean;
  onUpdateDraft: (patch: Partial<ScriptDraftValues>) => void;
  /** AP-15: the pending-review summary's `open` callable source — the host
   *  pane owns the editor tab, so IT defines what "open the review" means
   *  (switch to the Code tab, where the review bar + decorations live).
   *  Published verbatim into the store; the session only carries it. */
  openReview: () => void;
  scriptKind: "prompt" | "dice";
  t: TFunc;
  threadId: string | null;
}) {
  // Latest-render refs: a CodeMirror hunk button can outlive the render that
  // installed its decoration — its callback must read the CURRENT buffer and
  // writer, not the closure it was created in.
  const codeRef = useRef(code);
  const onUpdateDraftRef = useRef(onUpdateDraft);
  codeRef.current = code;
  onUpdateDraftRef.current = onUpdateDraft;

  const turnActivities = useAgentTurnStore(
    useShallow((s) => (threadId ? s.turnsByThread[agentThreadKey(SCRIPT_KIND, threadId)] ?? EMPTY_ACTIVITIES : EMPTY_ACTIVITIES)),
  );
  const round = useAgentReviewRoundStore(
    useShallow((s) => (threadId ? s.roundsByThread[agentThreadKey(SCRIPT_KIND, threadId)] ?? EMPTY_REVIEW_ROUND : EMPTY_REVIEW_ROUND)),
  );

  // CD-2: snapshot the code buffer on the RISING edge of the turn — the diff
  // "before" side and the revert target. The snapshot rides the round store
  // (survives pane unmounts: switching to another script or leaving the
  // editor mid-review must not lose the round).
  const prevSending = useRef(isSending);
  useEffect(() => {
    if (threadId === null) return;
    if (!prevSending.current && isSending) {
      useAgentReviewRoundStore.getState().pushSnapshot(SCRIPT_KIND, threadId, {
        rules: codeRef.current,
        visual: "",
      });
    }
    prevSending.current = isSending;
  }, [isSending, threadId]);

  // Last-wins proposal over the live turn's `code`-target activities (each
  // write_buffer/edit_buffer result is the complete cumulative buffer).
  const proposedLive = useMemo(() => {
    let last: string | undefined;
    for (const activity of turnActivities) {
      if (activity.status === "done" && activity.target === "code" && activity.proposed !== undefined) {
        last = activity.proposed;
      }
    }
    return last;
  }, [turnActivities]);

  // Effective proposal: the live turn's first; the dangling capture (frozen
  // right before a newer turn cleared the live store) when the live turn
  // proposed nothing for `code`.
  const effective = useMemo(() => {
    if (proposedLive !== undefined) {
      const snapshot = round.snapshots[round.snapshots.length - 1];
      return { proposed: proposedLive, base: snapshot?.rules };
    }
    if (round.dangling?.rules !== undefined) {
      return { proposed: round.dangling.rules, base: round.dangling.baseRules };
    }
    return null;
  }, [proposedLive, round.snapshots, round.dangling]);
  const effectiveRef = useRef(effective);
  effectiveRef.current = effective;
  const isSendingRef = useRef(isSending);
  isSendingRef.current = isSending;

  const acceptedHunkIds = useMemo(() => new Set(round.acceptedRules), [round.acceptedRules]);
  const dismissedHunkIds = useMemo(() => new Set(round.dismissedRules), [round.dismissedRules]);

  // RV-1: reset the buffer's selection sets ONLY when the proposal key
  // (base+proposed) changed — a remount with the same proposal keeps the
  // accept/dismiss progress (this is also what keeps a RESOLVED round
  // resolved after its proposal becomes dangling).
  const reviewKey = effective !== null ? `${effective.base ?? ""}\u0000${effective.proposed}` : null;
  useEffect(() => {
    if (threadId) useAgentReviewRoundStore.getState().ensureReviewKey(SCRIPT_KIND, threadId, "rules", reviewKey);
  }, [threadId, reviewKey]);

  const review = useMemo(
    () => buildBufferReview(effective?.base, effective?.proposed, acceptedHunkIds, !isSending, dismissedHunkIds),
    [effective, acceptedHunkIds, dismissedHunkIds, isSending],
  );

  const setAccepted = useCallback(
    (next: Set<number>) => {
      if (threadId) useAgentReviewRoundStore.getState().setAcceptedHunks(SCRIPT_KIND, threadId, "rules", [...next]);
    },
    [threadId],
  );
  const setDismissed = useCallback(
    (next: Set<number>) => {
      if (threadId) useAgentReviewRoundStore.getState().setDismissedHunks(SCRIPT_KIND, threadId, "rules", [...next]);
    },
    [threadId],
  );

  /** Re-read the round at the click boundary (stale-callback protection). */
  const currentReview = useCallback((): {
    bufferReview: CopilotBufferReview;
    accepted: ReadonlySet<number>;
    dismissed: ReadonlySet<number>;
  } | null => {
    if (threadId === null) return null;
    const current = useAgentReviewRoundStore.getState().roundsByThread[agentThreadKey(SCRIPT_KIND, threadId)];
    if (!current) return null;
    const accepted = new Set(current.acceptedRules);
    const dismissed = new Set(current.dismissedRules);
    const eff = effectiveRef.current;
    const bufferReview = buildBufferReview(eff?.base, eff?.proposed, accepted, !isSendingRef.current, dismissed);
    return bufferReview ? { bufferReview, accepted, dismissed } : null;
  }, [threadId]);

  /** CD-8: apply the clicked hunks onto the CURRENT buffer. Clean path (the
   *  buffer is the expected hybrid) rebuilds from the snapshot base; drift
   *  path anchors each hunk's removed lines onto the live text — a hunk that
   *  no longer anchors is skipped (stays pending) and toasted, never guessed. */
  const acceptHunks = useCallback(
    (current: NonNullable<ReturnType<typeof currentReview>>, clickedIds: readonly number[]) => {
      const { bufferReview, accepted } = current;
      const bufferText = codeRef.current;
      if (bufferReview.diff === null) {
        // tooLarge wholesale (RV-1): accept resolves the sentinel id.
        const next = new Set(accepted);
        for (const id of clickedIds) next.add(id);
        if (bufferText !== bufferReview.proposed) onUpdateDraftRef.current({ code: bufferReview.proposed });
        setAccepted(next);
        return;
      }
      const expected = mergedReviewText(bufferReview, accepted);
      if (bufferText !== expected) {
        const { text, skippedHunkIds } = applyHunksToBuffer(bufferText, bufferReview.diff, bufferReview.hunks, new Set(clickedIds));
        const applied = clickedIds.filter((id) => !skippedHunkIds.includes(id));
        const next = new Set(accepted);
        for (const id of applied) next.add(id);
        if (applied.length > 0) {
          onUpdateDraftRef.current({ code: text });
          setAccepted(next);
        }
        if (skippedHunkIds.length > 0) toast.warning(t("copilot_review_hunks_skipped", { n: skippedHunkIds.length }));
        return;
      }
      const next = new Set(accepted);
      for (const id of clickedIds) next.add(id);
      onUpdateDraftRef.current({ code: mergedReviewText(bufferReview, next) });
      setAccepted(next);
    },
    [setAccepted, t],
  );

  const acceptHunk = useCallback(
    (hunkId: number) => {
      const current = currentReview();
      if (current) acceptHunks(current, [hunkId]);
    },
    [currentReview, acceptHunks],
  );
  const acceptAll = useCallback(() => {
    const current = currentReview();
    if (!current) return;
    const pending = [...allReviewHunkIds(current.bufferReview)].filter(
      (id) => !current.accepted.has(id) && !current.dismissed.has(id),
    );
    acceptHunks(current, pending);
  }, [currentReview, acceptHunks]);

  // RV-2: dismiss (✕) — the hunk leaves the round; the buffer is untouched.
  const dismissHunk = useCallback(
    (hunkId: number) => {
      if (threadId === null) return;
      const state = useAgentReviewRoundStore.getState();
      const current = state.roundsByThread[agentThreadKey(SCRIPT_KIND, threadId)];
      if (!current) return;
      state.setDismissedHunks(SCRIPT_KIND, threadId, "rules", [...new Set([...current.dismissedRules, hunkId])]);
    },
    [threadId],
  );

  // RV-3: "Cancel all unaccepted" — dismiss the PENDING hunks (accepted stay,
  // buffer untouched); the round resolves once nothing is pending.
  const dismissPending = useCallback(() => {
    if (review === null || threadId === null) return;
    const pending = [...allReviewHunkIds(review)].filter((id) => !acceptedHunkIds.has(id) && !dismissedHunkIds.has(id));
    if (pending.length === 0) return;
    const state = useAgentReviewRoundStore.getState();
    const current = state.roundsByThread[agentThreadKey(SCRIPT_KIND, threadId)];
    if (!current) return;
    state.setDismissedHunks(SCRIPT_KIND, threadId, "rules", [...new Set([...current.dismissedRules, ...pending])]);
  }, [review, acceptedHunkIds, dismissedHunkIds, threadId]);

  // RV-3: "Cancel all" — kill the whole round: every hunk leaves, and hunks
  // already accepted into the buffer roll back (clean path: rebuild from the
  // snapshot base; drift path: reverse-splice the added lines — non-anchoring
  // hunks are skipped + toasted, never guessed). Single-buffer twin of the
  // experience session's cancel (kept local: the shared helper lives in the
  // experience host's module; importing it would couple the kinds).
  const cancelRound = useCallback(() => {
    if (review === null) return;
    const offered = allReviewHunkIds(review);
    if (review.diff === null) {
      // tooLarge wholesale: the sentinel resolves by dismissal only.
      setAccepted(new Set());
      setDismissed(new Set([...dismissedHunkIds, ...offered]));
      return;
    }
    const acceptedIds = [...offered].filter((id) => acceptedHunkIds.has(id));
    const bufferText = codeRef.current;
    if (bufferText === mergedReviewText(review, acceptedHunkIds)) {
      if (acceptedIds.length > 0) onUpdateDraftRef.current({ code: mergeSelectedBody(review.diff, new Set()) });
      setAccepted(new Set());
      setDismissed(new Set([...dismissedHunkIds, ...offered]));
      return;
    }
    const { text, skippedHunkIds } = revertHunksFromBuffer(bufferText, review.diff, review.hunks, new Set(acceptedIds));
    const reverted = acceptedIds.filter((id) => !skippedHunkIds.includes(id));
    if (reverted.length > 0) onUpdateDraftRef.current({ code: text });
    const surviving = new Set(skippedHunkIds.filter((id) => acceptedHunkIds.has(id)));
    setAccepted(surviving);
    setDismissed(new Set([...dismissedHunkIds, ...offered].filter((id) => !surviving.has(id))));
    if (skippedHunkIds.length > 0) toast.warning(t("copilot_review_hunks_skipped", { n: skippedHunkIds.length }));
  }, [review, acceptedHunkIds, dismissedHunkIds, setAccepted, setDismissed, t]);

  // ── AP-15: pending-review summary seam ──────────────────────────────
  // Mirror this thread's pending state into the ONE plain store the shell's
  // pending-changes strip will read (the shared publish hook owns the
  // lifecycle contract: publish on count change, clear on zero/unmount, no
  // stale callables). Pure side effect — every review behavior above is
  // untouched. `open` comes from the host pane (it owns the Code/Test tab).
  useAgentPendingReviewPublish({
    kind: SCRIPT_KIND,
    threadId,
    pendingByBuffer: [{ id: "code", pending: review?.pendingCount ?? 0 }],
    acceptAll,
    open: openReview,
  });

  // CD-8: freeze the still-pending proposal right before a new turn's send
  // clears the live turn store — it keeps hanging until the model revises it
  // or the user resolves it. Nothing is auto-applied.
  const captureDangling = useCallback(() => {
    if (threadId === null) return;
    const pending = effectiveRef.current;
    if (pending === null) return;
    useAgentReviewRoundStore.getState().captureDangling(SCRIPT_KIND, threadId, {
      rules: pending.proposed,
      baseRules: pending.base ?? codeRef.current,
      baseVisual: "",
    });
  }, [threadId]);

  // The per-turn send options: the LIVE merged draft (what the user sees —
  // unsaved edits included; never a stale DB read), the runtime kind, the
  // buffer's save state, and the panel's current character/persona (AS-8e3 —
  // the backend renders their full cards; the persona is absent when the
  // panel has none).
  const buildSendOptions = useCallback((): AgentSendOptions => ({
    code: codeRef.current,
    scriptKind,
    ...(codeSaved !== undefined ? { codeSaved } : {}),
    ...(contextCharacterId !== undefined ? { contextCharacterId } : {}),
    ...(contextPersonaId !== undefined ? { contextPersonaId } : {}),
  }), [scriptKind, codeSaved, contextCharacterId, contextPersonaId]);
  bridge.session = { onBeforeSend: captureDangling, buildSendOptions };

  return {
    acceptedHunkIds,
    acceptAll,
    acceptHunk,
    cancelRound,
    dismissHunk,
    dismissPending,
    dismissedHunkIds,
    review,
  };
}

// ─── Editor pane ─────────────────────────────────────────────────────────────

function ScriptAgentEditorPane({
  bridge,
  hostProps,
  isSending,
  threadId,
}: {
  bridge: AgentHostBridge;
  hostProps: ScriptAgentHostProps;
  isSending: boolean;
  threadId: string | null;
}) {
  const { t } = useT();
  const scriptKind = hostProps.activeScript.scriptKind === "dice" ? "dice" : "prompt";
  // AP-15: the pane owns the Code/Test tab (lifted out of the presentational
  // tabs so the pending-review seam can switch back to the review surface) —
  // `open` means "show the Code tab", where the review bar + decorations
  // live (the single spelling of this pane's review surface).
  const [tab, setTab] = useState<ScriptEditorTab>("code");
  const openReview = useCallback(() => setTab("code"), []);
  const {
    acceptedHunkIds,
    acceptAll,
    acceptHunk,
    cancelRound,
    dismissHunk,
    dismissPending,
    dismissedHunkIds,
    review,
  } = useScriptAgentReviewSession({
    bridge,
    code: hostProps.activeScript.code,
    codeSaved: !hostProps.draftDirty,
    contextCharacterId: hostProps.contextCharacterId,
    contextPersonaId: hostProps.contextPersonaId,
    isSending,
    onUpdateDraft: hostProps.onUpdateDraft,
    openReview,
    scriptKind,
    t,
    threadId,
  });

  // Resolved (accepted OR dismissed) hunks decorate as plain text (RV-2).
  const resolvedHunkIds = useMemo(() => {
    const resolved = new Set(acceptedHunkIds);
    for (const id of dismissedHunkIds) resolved.add(id);
    return resolved;
  }, [acceptedHunkIds, dismissedHunkIds]);
  const specs = useMemo(
    () => (review?.diff ? computeDiffDecorationSpecs(review.diff, review.hunks, resolvedHunkIds) : []),
    [review, resolvedHunkIds],
  );
  // Fresh identity per (specs, resolved) change so CodeEditor's compartment
  // (CD-4) reconfigures — the only way an accept/dismiss repaints without a
  // document change. These extensions JOIN the wrapper's lint + reveal ones
  // (the AS-8a `scriptSafetyExtensions` seam).
  const reviewExtensions = useMemo(
    () =>
      review !== null && specs.length > 0
        ? agentDiffExtensions({
            specs,
            buttonLabel: t("copilot_review_accept_hunk"),
            buttonAriaLabel: t("copilot_review_accept_hunk"),
            onAcceptHunk: acceptHunk,
            dismissLabel: t("copilot_review_dismiss_hunk"),
            dismissAriaLabel: t("copilot_review_dismiss_hunk"),
            onDismissHunk: dismissHunk,
          })
        : [],
    [review, specs, resolvedHunkIds, acceptHunk, dismissHunk, t],
  );
  const surfaceExtensions = useMemo(
    () => [...hostProps.scriptSafetyExtensions, ...reviewExtensions],
    [hostProps.scriptSafetyExtensions, reviewExtensions],
  );

  // While a review round is open the editor shows the PROPOSED document
  // (frozen — hand-editing during review is the conflict path, CD-8); the
  // agent pane is the tabbed Code/Test clone (AS-8c2) — its toolbar holds
  // only templates + the API reference (no AI-helper button: already active).
  const reviewedScript = review !== null ? { ...hostProps.activeScript, code: review.proposed } : hostProps.activeScript;

  /* Layout cloned from the experience host pane: the tab strip + toolbar stay
     pinned as shrink-0 rows while the code area is the inner-scroll flex
     remainder on desktop; on mobile the pane root is the single scroll
     document (the code container goes natural-height max-md:flex-none) —
     the same single-document contract the model pane keeps. */
  const reviewBar = review !== null ? (
    <div
      data-testid="copilot-review-bar"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-1.5"
    >
      <span data-testid="copilot-review-count" className="font-ui text-xs text-t2">
        {t("copilot_review_hunks_count", { n: review.pendingCount })}
      </span>
      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          data-testid="copilot-accept-all"
          onClick={acceptAll}
          className="min-h-9 cursor-pointer rounded-[5px] bg-accent px-3 font-ui text-xs font-medium text-on-accent transition-all duration-100 hover:brightness-110"
        >
          {t("copilot_review_accept_all")}
        </button>
        <button
          type="button"
          data-testid="copilot-dismiss-pending"
          onClick={dismissPending}
          className="min-h-9 cursor-pointer rounded-[5px] border border-border bg-s2 px-3 font-ui text-xs font-medium text-t2 transition-colors duration-100 hover:text-t1"
        >
          {t("copilot_review_dismiss_pending")}
        </button>
        <button
          type="button"
          data-testid="copilot-cancel-all"
          onClick={cancelRound}
          className="min-h-9 cursor-pointer rounded-[5px] border border-border bg-s2 px-3 font-ui text-xs font-medium text-t2 transition-colors duration-100 hover:text-t1"
        >
          {t("copilot_review_cancel_all")}
        </button>
      </div>
    </div>
  ) : null;
  return (
    <ScriptAgentEditorTabs
      isMobile={hostProps.isMobile}
      script={reviewedScript}
      scriptId={hostProps.activeScriptId}
      apiRefOpen={hostProps.apiRefOpen}
      extensions={surfaceExtensions}
      codeReadOnly={review !== null}
      isSending={isSending}
      reviewOpen={review !== null}
      tab={tab}
      onTabChange={setTab}
      reviewBar={reviewBar}
      characterName={hostProps.characterName}
      links={hostProps.scriptLinks}
      linkCharacters={hostProps.linkCharacters}
      linkPersonas={hostProps.linkPersonas}
      onSetScriptLinks={hostProps.onSetScriptLinks}
      onUpdateDraft={hostProps.onUpdateDraft}
      onToggleApiRef={hostProps.onToggleApiRef}
      onAddFromTemplate={hostProps.onAddFromTemplate}
      onRevealLine={hostProps.onRevealLine}
    />
  );
}

// ─── The host descriptor ─────────────────────────────────────────────────────

/**
 * The `script` host descriptor. `renderEditorPane` narrows the opaque
 * `hostProps`; `buildSendOptions` forwards to the pane's live bridge session
 * — the descriptor is a module constant and cannot close over component
 * state. i18n keys reuse the shell's existing agent wording (the RU values
 * are byte-identical to the former AI assistant modal's title, placeholder
 * and loading strings); the script kind carries its own subtitle line —
 * the experience one is rules/visual-flavored, so the script chat's
 * empty state asks to write or fix the script instead. `toolKeys` is this
 * kind's toggleable tool set — the shared profile modal reads it from here
 * instead of branching on the kind.
 */
registerAgentHost({
  kind: SCRIPT_KIND,
  i18n: {
    title: "agent_title",
    // AP-17: the kind heading for the strip/modal (mockup section 3, the RU
    // scripts kind label).
    kindLabel: "agent_kind_script",
    subtitle: "agent_script_subtitle",
    placeholder: "agent_input_placeholder",
    loading: "agent_loading",
    emptyTitle: "agent_title",
    emptySub: "agent_script_subtitle",
    mobileBackLabelKey: "import_back",
  },
  // AP-17: the empty-session starter prompts (mockup section 3, the scripts
  // row) — rendered by AP-18 as click-to-fill composer chips, never sent
  // directly.
  starterPromptKeys: [
    "agent_starter_script_explain",
    "agent_starter_script_fix_bugs",
    "agent_starter_script_comment",
    "agent_starter_script_simplify",
  ],
  // The toggleable tool keys of the script assistant profiles — the shared
  // profile modal reads them from here (no kind literal in the shell).
  toolKeys: SCRIPT_AGENT_TOOL_KEYS,
  // SC-0g: the script assistant's profile choice is script-owned (the
  // modal's single "use profile" action writes scripts.copilot_profile_id).
  profileAssignment: { target: "script" },
  bufferSpecs: [
    { id: "code", labelKey: "script_code_label", language: "javascript" },
  ],
  // The transport seam — the script client's own fns (the registry's
  // typeof-mirrored member types keep this delegation compiler-checked).
  transport: {
    sendStream: streamScriptAgent,
    answerAsk: answerScriptAgentAsk,
    // AP-10: the turn-delete REST call (required member — the script twin,
    // structurally identical to the experience `typeof` the registry pins).
    deleteTurn: deleteScriptAgentTurn,
    // SC-0c: the owner-scoped lifecycle takes the typed owner and maps it
    // back to the script id in one line — the thread-scoped members stay
    // owner-agnostic (the same per-thread routes serve both owners).
    getActiveThread: (owner) => getScriptAgentActive(scriptOwnerId(owner)),
    listMessages: listScriptAgentMessages,
    startSession: (owner, title?) => startScriptAgentSession(scriptOwnerId(owner), title),
    listSessions: (owner) => listScriptAgentSessions(scriptOwnerId(owner)),
    activateSession: activateScriptAgentSession,
    renameSession: renameScriptAgentSession,
    setContextLinks: setScriptAgentContextLinks,
  },
  renderEditorPane: (ctx) => (
    <ScriptAgentEditorPane
      threadId={ctx.threadId}
      isSending={ctx.isSending}
      bridge={ctx.bridge}
      hostProps={ctx.hostProps as ScriptAgentHostProps}
    />
  ),
  buildSendOptions: (ctx) => ctx.bridge.session?.buildSendOptions() ?? {},
  // SC-0i: the script assistant's plan is script-owned (the shell's plan
  // section renders exactly as before this seam existed).
  planOwner: (ctx) => ({ kind: "script", scriptId: scriptOwnerId(ctx.owner) }),
  toolCaption: (activity) => scriptTestCaption(activity),
  // AP-2: plain typography for the script assistant's bubbles.
  messageMarkup: "plain",
  // No record-proposal renderers yet — the AS-5 fallback card covers every
  // recordType until a host registers one.
  recordProposalRenderers: {},
});
