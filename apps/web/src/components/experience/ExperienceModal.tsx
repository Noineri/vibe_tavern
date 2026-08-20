/**
 * ExperienceModal — the trusted host chrome around the sandboxed visual frame
 * (IR-62). This is the DEFAULT host surface for an interactive experience: a
 * shared Vibe Tavern {@link Modal} that embeds an {@link ExperienceFrame} and
 * adds the privileged controls the visual itself must NEVER own — status,
 * close, detach (open in separate window), and finish (with a system
 * confirmation that lives in the MODAL chrome, outside the user frame).
 *
 * Session-preservation invariant: closing the modal hides the surface and
 * disposes the bridge, but does NOT end the server-authoritative session —
 * there is intentionally no `onDestroy` prop. Reopening (or the detached
 * window) reconnects to the same persisted session (IR-71 wires the persisted
 * reconnect; IR-62 provides the surface + the close-without-destroy contract).
 *
 * Why the finish confirmation is in the chrome, not the frame: finishing is a
 * privileged host op (the design: "The host controls privileged operations such
 * as session start/end ... the visual may request those operations only through
 * explicitly supported bridge messages"). The visual may REQUEST finish via the
 * bridge; the host confirms and executes. Putting the confirm in the chrome
 * keeps a compromised/malicious visual from finishing without a trusted prompt.
 *
 * Action-outcome contract (IR-73B seam #3): the frame bridge locks ONE action
 * until the host sends `sendResult` or `sendError`. A bare `void` submit
 * callback is insufficient — the host must translate the store mutation result
 * into a bridge ack. {@link ExperienceModalProps.onAction} is therefore an
 * async contract: the parent (launcher) strips the visual's client
 * `requestId`/`expectedRevision` (the store owns those), submits the intent,
 * and returns the committed revision/status/view on success or a valid bridge
 * error on failure. The modal's trusted chrome then acks the frame via
 * `frameRef.sendResult` + `sendState` (success) or `sendError` (failure),
 * keyed to the ORIGINAL visual requestId so the bridge lock clears.
 *
 * Live state push (IR-73B seams #2 + #5): once the frame completes the
 * handshake, every subsequent authoritative {@link ExperienceModalProps.view}
 * revision is pushed through `sendState`, and the pending phase reaches BOTH
 * the trusted chrome label AND the visual protocol (`sendPending`) — never the
 * label alone.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Modal } from "../shared/Modal.js";
import { Icons } from "../shared/icons.js";
import { useT } from "../../i18n/context.js";
import {
  ExperienceFrame,
  type ExperienceFrameHandle,
} from "./ExperienceFrame.js";
import type { BridgeResize } from "../../lib/experience-bridge.js";
import type { ExperienceActionDto } from "@vibe-tavern/api-contracts";
import type { ExperienceSessionStatus } from "@vibe-tavern/domain";
import type { BridgeErrorCode } from "../../lib/experience-bridge-schema.js";
import type { ExperienceActionResponse } from "../../api/types.js";
import type { ExperienceApiError } from "../../api/experience-api.js";
import { visualPendingFromPhase } from "../../lib/experience-pending.js";

/** The projected-view type the frame/host pushes (mirrors ExperienceFrame). */
type ProjectedView = Parameters<ExperienceFrameHandle["sendState"]>[0];

/**
 * The async action-outcome contract (seam #3). The parent strips the visual's
 * client CAS/idempotency fields and submits the bare intent to the store;
 * success carries the committed revision/status/view; failure carries a valid
 * {@link BridgeErrorCode} + localized message (+ the authoritative revision
 * when known, so the SDK can resync). The modal acks the frame with these.
 */
export type ExperienceActionOutcome =
  | { ok: true; revision: number; status: ExperienceSessionStatus; view: ProjectedView }
  | { ok: false; code: BridgeErrorCode; message: string; revision?: number };

/**
 * Pure mapping from a store action result to the bridge action-outcome contract
 * (IR-73B seam #3). Shared by the launcher and the detached host so both
 * surfaces produce identical fail-closed outcomes. A null response (store
 * surfaced a structured error after resync) maps to a valid bridge error code:
 * `stale_revision` when the store error code says so, otherwise
 * `invalid_action`. The revision comes from the current server session (the
 * store rehydrated before surfacing the error), letting the SDK resync.
 */
export function experienceActionOutcome(
  response: Pick<ExperienceActionResponse, "revision" | "status" | "view"> | null,
  apiError: ExperienceApiError | null,
  currentRevision: number | undefined,
  localizeMessage: (code: BridgeErrorCode) => string,
): ExperienceActionOutcome {
  if (response) {
    return { ok: true, revision: response.revision, status: response.status, view: response.view };
  }
  const code: BridgeErrorCode = apiError?.code === "stale_revision" ? "stale_revision" : "invalid_action";
  return {
    ok: false,
    code,
    message: localizeMessage(code),
    ...(currentRevision !== undefined ? { revision: currentRevision } : {}),
  };
}

export interface ExperienceModalProps {
  /** Controls modal visibility. */
  readonly open: boolean;
  /** Hide the surface (does NOT end the session — see the invariant above). */
  readonly onClose: () => void;
  /** Trusted title shown in the chrome. */
  readonly title: string;
  /** Optional status line (e.g. "Your turn", "Waiting for model"). */
  readonly statusLabel?: string;
  /** Optional pending phase for a typing/effect indicator in the chrome AND
   *  the visual protocol (`sendPending`). */
  /** Trusted-chrome pending phase. "timer" is a host-scheduled timer wait
   *  (fix step 2d): badge copy distinguishes it, but the frame bridge still
   *  receives "effect" — the visual protocol has no "timer" phase. */
  readonly pendingPhase?: "idle" | "typing" | "effect" | "timer";
  /** Open the detached window. If absent, the Detach control is hidden. */
  readonly onDetach?: () => void;
  /**
   * Privileged finish. When provided, a Finish button is shown; clicking it
   * opens a system confirmation in the chrome (NOT the frame) and only then
   * calls this. The visual's bridge `finish` request is forwarded here too.
   */
  readonly onFinishExperience?: () => void;
  /** Privileged QUIET end (pos 2 quiet close): ends the session WITHOUT any
   *  public report card. Shown as a secondary option inside the same finish
   *  confirmation overlay (trusted chrome, NOT the frame). When both finish &
   *  quiet are provided the overlay offers «Завершить» (with report) and
   *  «Завершить без отчёта» (quiet). */
  readonly onEndSessionQuiet?: () => void;
  /** Privileged in-session settings entry (lobby Б4). When provided, a
   *  Settings button is shown in the chrome; clicking it opens a system
   *  confirmation that lives OUTSIDE the sandboxed frame (same trust rule as
   *  finish — a compromised visual must not be able to trigger a privileged
   *  restart-with-new-settings without a trusted prompt) and only then calls
   *  this. Rendered only for ACTIVE matches by the parent. */
  readonly onOpenSessionSettings?: () => void;
  /** Trusted report-control surface rendered in a stable footer OUTSIDE the
   *  sandboxed frame (IR-73C). The parent (launcher) builds the element from
   *  server-authoritative store selectors and supplies it here so the controls
   *  are reachable while playing. Omit when the modal is closed (the launcher
   *  renders the same controls in its popover/sheet instead — never both). */
  readonly reportControls?: ReactNode;
  /** Trusted-chrome effect-diagnostics surface rendered in a stable block
   *  OUTSIDE the sandboxed frame (lobby effect diagnostics + retry). The
   *  parent (launcher) builds the element from server-authoritative effect
   *  rows and the store retry action; the component itself renders nothing
   *  when no row is retryable. Omitted while the modal is closed. */
  readonly effectDiagnostics?: ReactNode;
  // ── ExperienceFrame pass-through ──────────────────────────────────────────
  readonly visualSource: string;
  readonly sessionId: string;
  readonly initialRevision: number;
  /** Bootstrap view pushed on the frame handshake (defaults to {@link view}). */
  readonly initialView?: ProjectedView;
  /**
   * The authoritative projected view. Pushed on ready (as the bootstrap) and on
   * every subsequent revision change once the frame is ready (seam #2).
   */
  readonly view?: ProjectedView;
  readonly onReady?: () => void;
  /**
   * Async action-outcome contract (seam #3). Receives the full validated frame
   * action (including the visual `requestId`/`expectedRevision`); the parent
   * strips those before submitting to the store (the store owns them) and
   * returns the committed result or a valid bridge error. The modal acks the
   * frame using the ORIGINAL visual `requestId`.
   */
  readonly onAction: (action: ExperienceActionDto) => Promise<ExperienceActionOutcome>;
  readonly onResize?: (size: BridgeResize) => void;
  readonly onError?: (reason: string) => void;
}

export function ExperienceModal(props: ExperienceModalProps) {
  const {
    open,
    onClose,
    title,
    statusLabel,
    pendingPhase,
    onDetach,
    onFinishExperience,
    onEndSessionQuiet,
    onOpenSessionSettings,
    reportControls,
    effectDiagnostics,
    visualSource,
    sessionId,
    initialRevision,
    initialView,
    view,
    onReady,
    onAction,
    onResize,
    onError,
  } = props;
  const { t } = useT();
  const [confirmingFinish, setConfirmingFinish] = useState(false);
  const [confirmingSettings, setConfirmingSettings] = useState(false);
  const [frameReady, setFrameReady] = useState(false);
  const frameRef = useRef<ExperienceFrameHandle>(null);
  /** Last revision pushed to the ready frame (prevents a redundant re-push of
   *  the bootstrap revision the frame already sent itself on handshake). */
  const lastPushedRevision = useRef<number | null>(null);

  // Latest-prop ref so the stable frame callbacks (captured once per session by
  // the session-scoped bridge) always delegate to the current parent callbacks
  // — a changing onAction/onReady identity does NOT strand the bridge.
  const cbRef = useRef({ onReady, onAction, onResize, onFinishExperience, onError });
  cbRef.current = { onReady, onAction, onResize, onFinishExperience, onError };

  // Reset the confirmation steps whenever the modal closes so a reopen
  // does not inherit a stale "are you sure?" state.
  useEffect(() => {
    if (!open) {
      setConfirmingFinish(false);
      setConfirmingSettings(false);
    }
  }, [open]);

  // Reset the ready/push-tracking state on a session change so a fresh
  // handshake re-establishes the push frontier.
  useEffect(() => {
    setFrameReady(false);
    lastPushedRevision.current = null;
  }, [sessionId]);

  /** Stable frame ready handler: marks the frame ready, then forwards. */
  const handleReady = useCallback(() => {
    setFrameReady(true);
    cbRef.current.onReady?.();
  }, []);

  /**
   * Stable frame action handler (seam #3). The frame calls this with the full
   * validated action (visual requestId/expectedRevision included). The parent's
   * onAction strips those and submits the bare intent; we then ack the frame:
   * success → sendResult (clears the bridge lock) + sendState (new view);
   * failure → sendError (valid code/message, keyed to the visual requestId).
   *
   * Fail-closed rejection handling: if the async onAction callback rejects
   * unexpectedly (a thrown store action, a runtime error), the bridge lock
   * must STILL clear. We catch the rejection, report it through the optional
   * observability callback (no raw exception text to the visual), and always
   * sendError with `invalid_action`, a localized generic message, the original
   * visual requestId, and the current authoritative revision when available.
   */
  const handleAction = useCallback(async (action: ExperienceActionDto) => {
    const visualRequestId = action.requestId;
    let outcome: ExperienceActionOutcome;
    try {
      outcome = await cbRef.current.onAction(action);
    } catch (err) {
      // Report to the host observability seam only — never expose the raw
      // exception to the visual. The frame gets a fail-closed generic error.
      cbRef.current.onError?.(err instanceof Error ? err.message : "action rejected");
      const revision = lastPushedRevision.current ?? undefined;
      frameRef.current?.sendError("invalid_action", t("experience_action_invalid"), {
        requestId: visualRequestId,
        ...(revision !== undefined ? { revision } : {}),
      });
      return;
    }
    if (outcome.ok) {
      frameRef.current?.sendResult(visualRequestId, outcome.revision, outcome.status);
      frameRef.current?.sendState(outcome.view);
      lastPushedRevision.current = outcome.revision;
    } else {
      frameRef.current?.sendError(outcome.code, outcome.message, {
        requestId: visualRequestId,
        ...(outcome.revision !== undefined ? { revision: outcome.revision } : {}),
      });
    }
  }, [t]);

  const handleResize = useCallback((size: BridgeResize) => {
    cbRef.current.onResize?.(size);
  }, []);

  /** The visual may REQUEST finish via the bridge; route it to the same chrome
   *  confirmation so a frame-driven finish is never auto-executed. */
  const handleFrameFinishRequest = useCallback((_revision: number) => {
    if (cbRef.current.onFinishExperience) setConfirmingFinish(true);
  }, []);

  const handleError = useCallback((reason: string) => {
    cbRef.current.onError?.(reason);
  }, []);

  // ── Push the authoritative view to the ready frame (seam #2) ──────────────
  // The frame pushes `initialView` itself on handshake; this effect covers the
  // subsequent revisions that arrive as the store projects a new view. Skipping
  // the already-pushed revision avoids a redundant re-push of the bootstrap.
  useEffect(() => {
    if (!frameReady || !open || view === undefined) return;
    if (lastPushedRevision.current === view.revision) return;
    frameRef.current?.sendState(view);
    lastPushedRevision.current = view.revision;
  }, [frameReady, open, view]);

  // ── Push the pending phase to BOTH chrome AND the visual (seam #5) ────────
  // The chrome indicator is rendered below; this forwards the phase to the
  // frame's `sendPending` so the visual protocol mirrors the trusted label —
  // EXCEPT timer waits: a live timer is the resting state of a timer-driven
  // experience, not host work, so it must reach the visual as `idle` (the
  // visual's pending contract means "avoid double-submitting", which would
  // lock the player out for the whole session). See lib/experience-pending.ts.
  useEffect(() => {
    if (!frameReady || !open) return;
    frameRef.current?.sendPending(visualPendingFromPhase(pendingPhase));
  }, [frameReady, open, pendingPhase]);

  const confirmFinish = () => {
    setConfirmingFinish(false);
    onFinishExperience?.();
  };

  const confirmQuietFinish = () => {
    setConfirmingFinish(false);
    onEndSessionQuiet?.();
  };

  const confirmSettings = () => {
    setConfirmingSettings(false);
    onOpenSessionSettings?.();
  };

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="flex h-full max-h-[85vh] w-[min(720px,92vw)] flex-col rounded-lg border border-neutral-700 bg-neutral-900 shadow-xl">
        {/* Trusted chrome — never rendered by the visual. */}
        <header className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-100">
            {title}
          </h2>
          {pendingPhase && pendingPhase !== "idle" && (
            <span
              className="inline-flex items-center gap-1 rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300"
              data-testid="experience-pending"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
              {/* Mobile (4a phase e): the badge TEXT yields its width to the
                  truncated title on a 360px header (the pulse dot alone still
                  signals activity); desktop keeps the full label. */}
              <span className="max-md:hidden">
                {pendingPhase === "typing"
                  ? t("experience_pending_typing")
                  : pendingPhase === "timer"
                    ? t("experience_pending_timer")
                    : t("experience_pending_effect")}
              </span>
            </span>
          )}
          {statusLabel && (
            <span className="truncate text-xs text-neutral-400" data-testid="experience-status">
              {statusLabel}
            </span>
          )}
          {onDetach && (
            <button
              type="button"
              className="rounded px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 max-md:min-h-9 max-md:min-w-9"
              onClick={onDetach}
              data-testid="experience-detach"
              title={t("experience_detach_title")}
            >
              <Icons.Expand className="h-4 w-4" />
            </button>
          )}
          {onFinishExperience && !confirmingFinish && (
            <button
              type="button"
              className="rounded px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 max-md:min-h-9"
              onClick={() => setConfirmingFinish(true)}
              data-testid="experience-finish"
            >
              {t("experience_finish")}
            </button>
          )}
          {onOpenSessionSettings && !confirmingSettings && (
            <button
              type="button"
              className="rounded px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 max-md:min-h-9"
              onClick={() => setConfirmingSettings(true)}
              data-testid="experience-session-settings"
            >
              {t("experience_session_settings")}
            </button>
          )}
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 max-md:min-h-9 max-md:min-w-9"
            onClick={onClose}
            aria-label={t("experience_close")}
            data-testid="experience-close"
          >
            <Icons.Close className="h-4 w-4" />
          </button>
        </header>

        {/* The sandboxed visual surface. The chrome confirmation overlays this. */}
        <div className="relative flex-1 overflow-auto">
          <ExperienceFrame
            ref={frameRef}
            visualSource={visualSource}
            sessionId={sessionId}
            initialRevision={initialRevision}
            initialView={initialView ?? view}
            onReady={handleReady}
            onAction={handleAction}
            onResize={handleResize}
            onFinish={handleFrameFinishRequest}
            onError={handleError}
          />
          {confirmingFinish && (
            // System confirmation lives in the MODAL chrome (trusted), outside
            // the user frame — a compromised visual cannot forge this prompt.
            <div
              className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 p-4"
              data-testid="experience-finish-confirm"
            >
              <div className="w-full max-w-sm rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-lg">
                <p className="mb-4 text-sm text-neutral-200">{t("experience_finish_confirm")}</p>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    className="rounded px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 max-md:min-h-9"
                    onClick={() => setConfirmingFinish(false)}
                    data-testid="experience-finish-cancel"
                  >
                    {t("experience_cancel")}
                  </button>
                  {onEndSessionQuiet && (
                    <button
                      type="button"
                      className="rounded px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 max-md:min-h-9"
                      onClick={confirmQuietFinish}
                      data-testid="experience-finish-quiet"
                    >
                      {t("experience_finish_quiet")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 max-md:min-h-9"
                    onClick={confirmFinish}
                    data-testid="experience-finish-confirm-btn"
                  >
                    {t("experience_finish")}
                  </button>
                </div>
              </div>
            </div>
          )}
          {confirmingSettings && (
            // System confirmation lives in the MODAL chrome (trusted), outside
            // the user frame — same trust rule as the finish confirm: a
            // compromised visual cannot forge this privileged prompt.
            <div
              className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 p-4"
              data-testid="experience-settings-confirm"
            >
              <div className="w-full max-w-sm rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-lg">
                <p className="mb-4 text-sm text-neutral-200">{t("experience_session_settings_confirm")}</p>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    className="rounded px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 max-md:min-h-9"
                    onClick={() => setConfirmingSettings(false)}
                    data-testid="experience-settings-cancel"
                  >
                    {t("experience_cancel")}
                  </button>
                  <button
                    type="button"
                    className="rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 max-md:min-h-9"
                    onClick={confirmSettings}
                    data-testid="experience-settings-confirm-btn"
                  >
                    {t("experience_session_settings")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
        {effectDiagnostics && (
          <div
            className="border-t border-neutral-800 px-4 py-2"
            data-testid="experience-effect-diagnostics-slot"
          >
            {effectDiagnostics}
          </div>
        )}
        {/* Trusted report-control footer — OUTSIDE the sandboxed frame
            (IR-73C). Rendered only when the parent supplies controls; the
            launcher omits this prop while the modal is closed so the same
            controls live in the popover/sheet instead (never both at once). */}
        {reportControls && (
          <footer
            className="border-t border-neutral-800 px-4 py-2 max-md:pb-[calc(env(safe-area-inset-bottom,0px)+8px)]"
            data-testid="experience-report-footer"
          >
            {reportControls}
          </footer>
        )}
      </div>
    </Modal>
  );
}
