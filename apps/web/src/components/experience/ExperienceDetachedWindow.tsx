/**
 * ExperienceDetachedWindow — the same-origin trusted wrapper for the "Open in
 * separate window" surface (IR-62; persisted-store reconnect wired in IR-71).
 *
 * A detached window is NOT the user visual running as the top-level document —
 * that would demolish the isolation boundary. Instead `window.open` loads the
 * SAME Vibe Tavern bundle at a same-origin hash URL (`#experience=<sessionId>`),
 * the app shell (main.tsx Root) detects that hash and renders
 * {@link ExperienceDetachedHost}, a TRUSTED wrapper that embeds the SAME
 * sandboxed {@link ExperienceFrame} the modal uses. The user visual is still
 * inside `sandbox="allow-scripts"` with no `allow-same-origin`; only the trusted
 * chrome around it is now a real OS window instead of a modal.
 *
 * Persisted reconnect (IR-71, completing the IR-62→IR-71 handoff): the detached
 * host no longer depends on `window.opener` callbacks (which die when the opener
 * closes). It reads the exact scope (`chatId`+`branchId`) + a safe bootstrap
 * snapshot from the descriptor, sets the Experience store scope, rehydrates the
 * branch's active session, and from then on uses ONLY the store's
 * server-authoritative session — pinned visual source, revision, and projected
 * view. It submits actions through the store, acks the frame with the result,
 * pushes later authoritative views + pending phases, and runs durable pending
 * model effects. The descriptor is the immediate safe bootstrap only (the frame
 * can mount before the rehydrate resolves); the store is the authority.
 *
 * Popup-blocked fallback: `window.open` returns `null` when the browser blocks
 * the popup (common with strict blockers or a non-user-gesture trigger). The
 * caller MUST handle `null` — typically by keeping the modal open and showing a
 * notice. `openExperienceDetachedWindow` does not pretend success.
 */
import { Icons } from "../shared/icons.js";
import { useT } from "../../i18n/context.js";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExperienceFrame,
  type ExperienceFrameHandle,
  type ExperienceModelSeatRequest,
  type ExperienceRoundCommitClaim,
} from "./ExperienceFrame.js";
import { ExperienceReportControls } from "./ExperienceReportControls.js";
import {
  experienceActionOutcome,
  ExperienceRoundFinishedPanel,
  type ExperienceModelSeam,
} from "./ExperienceModal.js";
import type { ExperienceLoopConfig } from "../../lib/experience-loop-host.js";
import { useExperienceTimerResync } from "../../hooks/use-experience-timer-resync.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import type { BridgeErrorCode } from "../../lib/experience-bridge-schema.js";
import { EXPERIENCE_EFFECT_STATUS } from "@vibe-tavern/domain";
import { visualPendingFromEffects } from "../../lib/experience-pending.js";
import type { ExperienceActionDto } from "@vibe-tavern/api-contracts";
import {
  useExperienceEffects,
  useExperienceQueuedAttachment,
  useExperienceReportStatus,
  useExperienceSession,
  useExperienceStore,
  type ExperienceActionIntent,
} from "../../stores/experience-store.js";
import type { ExperienceSessionResponse } from "../../api/types.js";

/** The global property the opener stashes the descriptor on (same-origin only). */
const DESCRIPTOR_KEY = "__experienceDetachDescriptor";

/** Window features for the detached popup (compact phone-like panel). */
export const DETACHED_WINDOW_FEATURES =
  "width=420,height=640,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes";

/**
 * The detach-aware window surface the bridge functions need. Injected for tests
 * (happy-dom's window.location/opener are readonly and cannot be reassigned);
 * production callers omit it and the default `globalThis` is used.
 */
export interface DetachWindow {
  open(url?: string, target?: string, features?: string): Window | null;
  readonly location: { pathname: string; search: string; hash: string };
  readonly opener: { readonly [DESCRIPTOR_KEY]?: DetachedExperienceDescriptor } | null;
  [DESCRIPTOR_KEY]?: DetachedExperienceDescriptor;
}

function defaultWindow(): DetachWindow {
  return globalThis as unknown as DetachWindow;
}

/** The projected-view type the frame/host pushes. */
type ProjectedView = Parameters<ExperienceFrameHandle["sendState"]>[0];

/**
 * The session props the detached host needs to mount the frame + reconnect the
 * persisted store. Carries the exact scope (`chatId`+`branchId`) so the host
 * can `setScope` and rehydrate, plus a pinned bootstrap snapshot (visual source,
 * revision, view) so the frame renders immediately before the rehydrate settles.
 * After rehydrate the store session is the authority; the descriptor fields are
 * only the safe bootstrap.
 */
export interface DetachedExperienceDescriptor {
  readonly chatId: string;
  readonly branchId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly visualSource: string;
  readonly initialRevision: number;
  readonly initialView?: ProjectedView;
  /** Realtime round configuration (RM-6); absent ⇒ the turn-based frame doc. */
  readonly realtimeConfig?: ExperienceLoopConfig;
}

/**
 * Open the detached window. Stashes `descriptor` for the popup to read and
 * navigates the popup to the same-origin hash URL. Returns the popup handle, or
 * `null` if the browser blocked the popup — the caller must handle `null`.
 */
export function openExperienceDetachedWindow(
  descriptor: DetachedExperienceDescriptor,
  win: DetachWindow = defaultWindow(),
): Window | null {
  // Stash on the OPENER so the popup (a fresh bundle instance with its own
  // module state) can read it via window.opener (same-origin) as a bootstrap.
  // The popup rehydrates from the store after reading this — it does not depend
  // on the opener staying alive.
  win[DESCRIPTOR_KEY] = descriptor;
  const url = `${win.location.pathname}${win.location.search}#experience=${encodeURIComponent(descriptor.sessionId)}`;
  return win.open(url, `xp-detach-${descriptor.sessionId}`, DETACHED_WINDOW_FEATURES);
}

/** Required string fields validated by {@link readDetachedDescriptor}. */
const DESCRIPTOR_REQUIRED_STRINGS: readonly (keyof DetachedExperienceDescriptor)[] = [
  "chatId",
  "branchId",
  "sessionId",
  "title",
  "visualSource",
];

/**
 * Read the descriptor the opener stashed. Called from inside the detached
 * window's bundle. Returns null if there is no opener (opened directly/not via
 * Detach), no descriptor, or a malformed descriptor (missing required scope +
 * bootstrap fields) — the shell fork falls back to the normal app.
 */
export function readDetachedDescriptor(win: DetachWindow = defaultWindow()): DetachedExperienceDescriptor | null {
  const desc = win.opener?.[DESCRIPTOR_KEY];
  if (!desc || typeof desc !== "object") return null;
  for (const key of DESCRIPTOR_REQUIRED_STRINGS) {
    const v = desc[key];
    if (typeof v !== "string" || v === "") return null;
  }
  if (typeof desc.initialRevision !== "number" || !Number.isFinite(desc.initialRevision)) return null;
  // Optional realtime config (RM-6): trusted host data — checked for shape
  // only (a non-null object); the loop validates the contents itself.
  if (desc.realtimeConfig !== undefined && (typeof desc.realtimeConfig !== "object" || desc.realtimeConfig === null)) {
    return null;
  }
  return desc;
}

/** True when the current window is a detached-experience popup (hash present). */
export function isDetachedExperienceWindow(win: Pick<DetachWindow, "location"> = defaultWindow()): boolean {
  return win.location.hash.startsWith("#experience=");
}

export interface ExperienceDetachedHostProps {
  /** Override the descriptor source (tests); defaults to readDetachedDescriptor(). */
  readonly descriptor?: DetachedExperienceDescriptor;
  /** Realtime (RM-6): the model seam (stub until the wave-4 endpoint lands). */
  readonly onModelRequest?: ExperienceModelSeam;
  /** Realtime (RM-6): fired exactly once when the loop commits the round. */
  readonly onRoundCommit?: (claim: ExperienceRoundCommitClaim) => void;
}

/** Read the current scope-keyed store error synchronously (callback-safe). */
function readScopeError(chatId: string, branchId: string) {
  const state = useExperienceStore.getState();
  const key = JSON.stringify([chatId, branchId]);
  const scope = state.byScope[key];
  return { lastApiError: scope?.lastApiError ?? null, session: scope?.session ?? null };
}

/**
 * The trusted wrapper rendered inside the detached window. Reads its descriptor
 * from the opener (safe bootstrap), sets the Experience store scope, rehydrates
 * the branch's active session, and from then on uses ONLY the store's
 * server-authoritative session: pinned visual source, revision, projected view.
 * Submits actions through the store (acks the frame), pushes later views +
 * pending phases, and runs durable pending model effects one at a time. Never
 * executes user HTML as the top-level document.
 */
export function ExperienceDetachedHost(props: ExperienceDetachedHostProps) {
  const { t } = useT();
  const [descriptor, setDescriptor] = useState<DetachedExperienceDescriptor | null>(
    () => props.descriptor ?? readDetachedDescriptor(),
  );
  const frameRef = useRef<ExperienceFrameHandle>(null);
  const [frameReady, setFrameReady] = useState(false);
  const lastPushedRevision = useRef<number | null>(null);
  /** In-flight effect run (prevents a duplicate/running repeat). */
  const effectRunRef = useRef<AbortController | null>(null);
  /** The finalized realtime round claim (RM-6), latched once. */
  const [roundFinished, setRoundFinished] = useState<ExperienceRoundCommitClaim | null>(null);
  const roundFinishedRef = useRef(false);

  // Latest-prop ref: the session-scoped bridge captures the frame callbacks
  // once at creation — route the realtime callbacks through here so a changed
  // prop identity never strands them (same discipline as the modal's cbRef).
  const realtimeCbRef = useRef({ onModelRequest: props.onModelRequest, onRoundCommit: props.onRoundCommit });
  realtimeCbRef.current = { onModelRequest: props.onModelRequest, onRoundCommit: props.onRoundCommit };

  /** Realtime (RM-6): forward a model seat's request to the seam and deliver
   *  the reply into the round. Absent/failed seam → warn + send nothing (the
   *  round lives; no reply is a valid outcome). No onError prop exists here —
   *  observability goes to the console, mirroring handleFinishExperience. */
  const handleModelRequest = useCallback((req: ExperienceModelSeatRequest): void => {
    const seam = realtimeCbRef.current.onModelRequest;
    if (!seam) {
      if (typeof console !== "undefined") console.warn("[experience] model seam unavailable", req.seatId);
      return;
    }
    void (async (): Promise<void> => {
      try {
        const result = await seam(req);
        if (result !== null && result !== undefined) {
          frameRef.current?.sendModelResult(req.seatId, result, req.requestId);
        }
      } catch (err) {
        if (typeof console !== "undefined") console.warn("[experience] model seam failed", err);
      }
    })();
  }, []);

  /** Realtime (RM-6): the loop committed the round — latch once, then the
   *  trusted finished panel replaces interaction (the loop is dead). */
  const handleRoundCommit = useCallback((claim: ExperienceRoundCommitClaim): void => {
    if (roundFinishedRef.current) return;
    roundFinishedRef.current = true;
    setRoundFinished(claim);
    realtimeCbRef.current.onRoundCommit?.(claim);
  }, []);

  useEffect(() => {
    if (!props.descriptor && !descriptor) {
      const d = readDetachedDescriptor();
      if (d) setDescriptor(d);
    }
  }, [props.descriptor, descriptor]);

  const chatId = descriptor?.chatId ?? null;
  const branchId = descriptor?.branchId ?? null;

  // ── Set the store scope + rehydrate once the descriptor is known ─────────
  useEffect(() => {
    if (!descriptor) return;
    useExperienceStore.getState().setScope(descriptor.chatId, descriptor.branchId);
  }, [descriptor]);

  // The authoritative store session/effects for THIS scope (the descriptor is
  // only the bootstrap before the rehydrate settles).
  const storeSession = useExperienceSession(chatId, branchId);
  const storeEffects = useExperienceEffects(chatId, branchId);
  const queuedAttachment = useExperienceQueuedAttachment(chatId, branchId);
  const reportStatus = useExperienceReportStatus(chatId, branchId);

  // Authoritative values: store > descriptor bootstrap.
  const session: ExperienceSessionResponse | null = storeSession;
  const visualSource = session?.visualSource ?? descriptor?.visualSource ?? "";
  const sessionId = session?.sessionId ?? descriptor?.sessionId ?? "";
  const revision = session?.revision ?? descriptor?.initialRevision ?? 0;
  const view: ProjectedView | undefined = session?.view ?? descriptor?.initialView;
  const title = descriptor?.title ?? session?.manifest.name ?? "";

  /** Localized bridge-error message for the fail-closed outcome. `t` from the
   *  i18n context is stable, so this plain function is safe to capture. */
  function localizeError(code: BridgeErrorCode): string {
    return code === "stale_revision" ? t("experience_action_stale") : t("experience_action_invalid");
  }

  /** Frame action handler: strip CAS/idempotency, submit via store, ack the
   *  frame with the outcome (visual requestId retained). Captured once per
   *  session by the session-scoped bridge; reads fresh store state at call.
   *  Fail-closed: a thrown store action never strands the bridge lock — the
   *  frame always gets a sendError with a generic localized message. */
  function handleAction(action: ExperienceActionDto): void {
    const visualRequestId = action.requestId;
    const intent: ExperienceActionIntent = {
      type: action.type,
      ...(action.participantId !== undefined ? { participantId: action.participantId } : {}),
      ...(action.payload !== undefined ? { payload: action.payload } : {}),
    };
    void (async (): Promise<void> => {
      let response;
      try {
        response = await useExperienceStore.getState().submitAction(intent);
      } catch {
        // A thrown store action must still clear the bridge lock. Send a
        // generic fail-closed error — no raw exception to the visual.
        frameRef.current?.sendError("invalid_action", localizeError("invalid_action"), {
          requestId: visualRequestId,
          ...(revision !== undefined ? { revision } : {}),
        });
        return;
      }
      if (!descriptor) return;
      const { lastApiError, session: current } = readScopeError(descriptor.chatId, descriptor.branchId);
      const outcome = experienceActionOutcome(response, lastApiError, current?.revision, localizeError);
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
    })();
  }

  // Reset push frontier on a session change.
  useEffect(() => {
    setFrameReady(false);
    lastPushedRevision.current = null;
    roundFinishedRef.current = false;
    setRoundFinished(null);
  }, [sessionId]);

  // ── Push the authoritative view to the ready frame (seam #2) ──────────────
  useEffect(() => {
    if (!frameReady || view === undefined || roundFinished !== null) return;
    if (lastPushedRevision.current === view.revision) return;
    frameRef.current?.sendState(view);
    lastPushedRevision.current = view.revision;
  }, [frameReady, view, roundFinished]);

  // ── Push the pending phase to the visual protocol (seam #5) ─────────────
  // ONLY model-kind work gates the visual: a live timer is the resting state
  // of a timer-driven session, not host work — forwarding it would disable the
  // visual's controls for the whole session (timer-freedom fix; see
  // lib/experience-pending.ts).
  const pendingPhase = visualPendingFromEffects(storeEffects);
  useEffect(() => {
    if (!frameReady || roundFinished !== null) return;
    frameRef.current?.sendPending(pendingPhase);
  }, [frameReady, pendingPhase, roundFinished]);

  // ── Timer tick pickup (fix step 2d) ────────────────────────────────────────
  // Host-fired ticks land server-side while this window may sit idle; while a
  // timer is live, slowly rehydrate so the applied tick and the terminal
  // effect row arrive without user interaction. Self-disarms when no live
  // timer remains.
  useExperienceTimerResync({ chatId, branchId, effects: storeEffects, view: storeSession?.view ?? null, active: session !== null });

  // ── Run durable pending model effects one at a time (IR-73B) ─
  // Only `pending` MODEL rows auto-run (timer effects are host-scheduled,
  // fix step 2c — the server answers 202 without running them, so they MUST
  // be skipped here or this loop would re-call the route forever);
  // `running`/`unknown`/`failed`/`succeeded` never repeat. An in-flight run
  // blocks a new start; the store rehydrates after each run, re-triggering
  // this effect for the next pending row. A genuine session change aborts
  // the in-flight run.
  useEffect(() => {
    if (!session) return;
    if (effectRunRef.current) return; // one at a time
    const pending = storeEffects.find((e) => e.status === EXPERIENCE_EFFECT_STATUS.pending && e.kind === "model");
    if (!pending) return;
    const controller = new AbortController();
    effectRunRef.current = controller;
    void useExperienceStore
      .getState()
      .runEffect(pending.id, controller.signal)
      .finally(() => {
        if (effectRunRef.current === controller) effectRunRef.current = null;
      });
  }, [session, storeEffects]);

  // Abort the in-flight effect ONLY on a genuine session change.
  useEffect(() => {
    return () => {
      effectRunRef.current?.abort();
      effectRunRef.current = null;
    };
  }, [sessionId]);

  // ── Trusted Finish + report controls (IR-73C) ─────────────────────────────
  // The detached surface owns the SAME privileged end path as the modal: a
  // trusted Finish button that opens a shared DestructiveConfirmModal (never a
  // hand-rolled shell), and the SAME report-control surface wired to
  // store.queueReport. Finish ends only after confirmation — never from the
  // user frame directly. endSession's server-returned terminal attachment is
  // consumed only by the store rehydrate; the UI never fabricates/mutates it.
  const [confirmingFinish, setConfirmingFinish] = useState(false);

  const handleQueueReport = useCallback(async (): Promise<void> => {
    const result = await useExperienceStore.getState().queueReport();
    if (result === null) throw new Error("experience queue failed");
  }, []);

  async function handleFinishExperience(): Promise<void> {
    setConfirmingFinish(false);
    try {
      // endSession returns the terminal queued attachment on success, or null
      // on a server failure (after the store resync surfaces lastError). A
      // missing session (pre-hydration edge) throws — caught here. In BOTH
      // fail-closed cases the surface stays open (no close/destroy) so the
      // user can see the error and retry; the store is the authority.
      await useExperienceStore.getState().endSession();
    } catch (err) {
      // No active session (pre-hydration) or a thrown store action — fail
      // closed without an unhandled rejection or closing/destroying the
      // surface. The store rehydrate/hydration re-establishes state.
      if (typeof console !== "undefined") console.warn("[experience] finish rejected", err);
    }
  }

  if (!descriptor) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-neutral-900 text-neutral-400">
        <p className="text-sm">{t("experience_detach_unavailable")}</p>
      </div>
    );
  }

  if (!visualSource) {
    // The session has no pinned visual source (or the rehydrate has not yet
    // settled). Surface an incompatible state rather than fetching live source.
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-neutral-900 text-neutral-400">
        <p className="text-sm">{t("experience_incompatible")}</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-neutral-900">
      <header className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-100">
          {title}
        </h1>
        <span className="rounded bg-neutral-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400">
          {t("experience_detached_badge")}
        </span>
        {/* Trusted Finish — opens the shared confirmation (never auto-finishes).
            The same privileged end path as the modal; the user visual cannot
            forge this button. Disabled until the exact store session is
            hydrated — the descriptor bootstrap alone is not authority for a
            privileged mutation (IR-73C acceptance fix). */}
        <button
          type="button"
          className="rounded px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40 max-md:min-h-9"
          disabled={!session}
          onClick={() => setConfirmingFinish(true)}
          data-testid="experience-detached-finish"
        >
          {t("experience_finish")}
        </button>
        <button
          type="button"
          className="rounded px-2 py-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 max-md:min-h-9 max-md:min-w-9"
          onClick={() => window.close()}
          aria-label={t("experience_close")}
          data-testid="experience-detached-close"
        >
          <Icons.Close className="h-4 w-4" />
        </button>
      </header>
      <div className="relative flex-1 overflow-auto">
        <ExperienceFrame
          ref={frameRef}
          visualSource={visualSource}
          sessionId={sessionId}
          initialRevision={revision}
          initialView={view}
          realtime={
            descriptor.realtimeConfig !== undefined
              ? { config: descriptor.realtimeConfig }
              : undefined
          }
          onReady={() => setFrameReady(true)}
          onAction={handleAction}
          onModelRequest={handleModelRequest}
          onRoundCommit={handleRoundCommit}
        />
        {roundFinished !== null && (
          // The loop is dead and the round claim is in — trusted chrome; the
          // header (Close) stays reachable above it.
          <ExperienceRoundFinishedPanel
            claim={roundFinished}
            onClose={() => window.close()}
            testId="experience-detached-round-finished"
          />
        )}
      </div>
      {/* Trusted report-control footer — OUTSIDE the sandboxed frame (IR-73C).
          The same surface the modal owns, with exact scope selectors. The
          component handles null/no-session props gracefully (disabled
          no-events state) so it stays reachable while the rehydrate settles. */}
      <footer
        className="border-t border-neutral-800 px-3 py-2 max-md:pb-[calc(env(safe-area-inset-bottom,0px)+8px)]"
        data-testid="experience-detached-report-footer"
      >
        <ExperienceReportControls
          queuedAttachment={queuedAttachment}
          reportStatus={reportStatus}
          onQueue={handleQueueReport}
        />
      </footer>
      {confirmingFinish && (
        <DestructiveConfirmModal
          title={t("experience_finish")}
          body={t("experience_finish_confirm")}
          confirmLabel={t("experience_finish")}
          onConfirm={() => void handleFinishExperience()}
          onCancel={() => setConfirmingFinish(false)}
        />
      )}
    </div>
  );
}
