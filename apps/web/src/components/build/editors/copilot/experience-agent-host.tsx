import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { ExperienceCopilotLaunchContext } from "@vibe-tavern/api-contracts";
import { Icons } from "../../../shared/icons.js";
import { EmptyState } from "../../../shared/empty-state.js";
import { SegmentedControl } from "../../../shared/SegmentedControl.js";
import { ExperiencePlayground } from "../ExperiencePlayground.js";
import { ExperienceFrame } from "../../../experience/ExperienceFrame.js";
import { useT } from "../../../../i18n/context.js";
import type { ScriptRecord } from "../../../../api/types.js";
import { rehydrateExperienceCopilotDrafts } from "../../../../lib/experience-copilot-draft.js";
import { ToolbarButton } from "./experience-copilot-buttons.js";
import { registerAgentHost, type AgentHostBridge, type AgentKind } from "../../../../lib/agent-host-registry.js";
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
import { AgentBufferReviewEditor } from "../../../shared/agent-shell/AgentBufferReviewEditor.js";
import {
  useExperienceCopilotReviewFeedback,
  useExperienceCopilotReviewSession,
  useExperienceCopilotStep,
} from "./use-experience-copilot-review.js";

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

  const {
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
  } = useExperienceCopilotReviewSession({
    bridge,
    codeBuffer,
    editorBuffer,
    isSending,
    kind: EXPERIENCE_KIND,
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
  });

  // ── Editor toggle options (XU-5) ────────────────────────────────────────
  // The editor pane is now `[Preview | Code (| Try)]` — preview is the default
  // layer; code is the second layer holding the inner `[Rules | Visual]`
  // sub-toggle. Creation mode adds the inline `sandbox` position (ER-13d-1),
  // relabelled "Try". Built here because the creation labels resolve through
  // `t`.
  // Buffer-tab labels with the pending-review dot (CD-6): a tab whose buffer
  // has unaccepted hunks carries an accent dot (per the settled vision: the
  // OTHER tab must signal pending diffs; showing it on both tabs is harmless
  // and simpler than hiding the active one's).
  const tabLabel = (value: "rules" | "visual", label: string): ReactNode => {
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

  // The OUTER "Code" tab carries a dot when EITHER buffer has pending hunks
  // (CD-6): the preview layer can't show diffs, so the code layer signals them.
  const codeTabLabel = rulesReview !== null || visualReview !== null
    ? (
      <span className="inline-flex items-center gap-1.5">
        {t("agent_code")}
        <span
          data-testid="copilot-outer-dot-code"
          title={t("copilot_review_pending_badge")}
          className="h-1.5 w-1.5 rounded-full bg-accent"
        />
      </span>
    )
    : t("agent_code");

  const outerBufferOptions = [
    { value: "preview", label: t("agent_preview") },
    { value: "code", label: codeTabLabel },
    { value: "sandbox", label: t("agent_try_it") },
  ];
  const codeBufferOptions = [
    { value: "rules", label: tabLabel("rules", t("agent_rules")) },
    { value: "visual", label: tabLabel("visual", t("agent_visual")) },
  ];

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
