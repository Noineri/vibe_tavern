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
 */
import { useEffect, useRef, useState } from "react";
import { Modal } from "../shared/Modal.js";
import { Icons } from "../shared/icons.js";
import { useT } from "../../i18n/context.js";
import {
  ExperienceFrame,
  type ExperienceFrameHandle,
} from "./ExperienceFrame.js";
import type { BridgeResize } from "../../lib/experience-bridge.js";
import type { ExperienceActionDto } from "@vibe-tavern/api-contracts";

/** The projected-view type the frame/host pushes (mirrors ExperienceFrame). */
type ProjectedView = Parameters<ExperienceFrameHandle["sendState"]>[0];

export interface ExperienceModalProps {
  /** Controls modal visibility. */
  readonly open: boolean;
  /** Hide the surface (does NOT end the session — see the invariant above). */
  readonly onClose: () => void;
  /** Trusted title shown in the chrome. */
  readonly title: string;
  /** Optional status line (e.g. "Your turn", "Waiting for model"). */
  readonly statusLabel?: string;
  /** Optional pending phase for a typing/effect indicator in the chrome. */
  readonly pendingPhase?: "idle" | "typing" | "effect";
  /** Open the detached window. If absent, the Detach control is hidden. */
  readonly onDetach?: () => void;
  /**
   * Privileged finish. When provided, a Finish button is shown; clicking it
   * opens a system confirmation in the chrome (NOT the frame) and only then
   * calls this. The visual's bridge `finish` request is forwarded here too.
   */
  readonly onFinishExperience?: () => void;
  // ── ExperienceFrame pass-through ──────────────────────────────────────────
  readonly visualSource: string;
  readonly sessionId: string;
  readonly initialRevision: number;
  readonly initialView?: ProjectedView;
  readonly onReady?: () => void;
  readonly onAction: (action: ExperienceActionDto) => void;
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
    visualSource,
    sessionId,
    initialRevision,
    initialView,
    onReady,
    onAction,
    onResize,
    onError,
  } = props;
  const { t } = useT();
  const [confirmingFinish, setConfirmingFinish] = useState(false);
  const frameRef = useRef<ExperienceFrameHandle>(null);

  // Reset the finish-confirmation step whenever the modal closes so a reopen
  // does not inherit a stale "are you sure?" state.
  useEffect(() => {
    if (!open) setConfirmingFinish(false);
  }, [open]);

  // The visual may REQUEST finish via the bridge; route it to the same chrome
  // confirmation so a frame-driven finish is never auto-executed.
  const handleFrameFinishRequest = () => {
    if (onFinishExperience) setConfirmingFinish(true);
  };

  const confirmFinish = () => {
    setConfirmingFinish(false);
    onFinishExperience?.();
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
              {pendingPhase === "typing" ? t("experience_pending_typing") : t("experience_pending_effect")}
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
              className="rounded px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
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
              className="rounded px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
              onClick={() => setConfirmingFinish(true)}
              data-testid="experience-finish"
            >
              {t("experience_finish")}
            </button>
          )}
          <button
            type="button"
            className="rounded px-2 py-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
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
            initialView={initialView}
            onReady={onReady}
            onAction={onAction}
            onResize={onResize}
            onFinish={handleFrameFinishRequest}
            onError={onError}
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
                    className="rounded px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
                    onClick={() => setConfirmingFinish(false)}
                    data-testid="experience-finish-cancel"
                  >
                    {t("experience_cancel")}
                  </button>
                  <button
                    type="button"
                    className="rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500"
                    onClick={confirmFinish}
                    data-testid="experience-finish-confirm-btn"
                  >
                    {t("experience_finish")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
