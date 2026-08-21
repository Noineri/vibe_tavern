/**
 * ExperienceLauncher — the compact per-active-chat interactive-experience entry
 * point mounted beside Dice in PlayMode (INTERACTIVE_RUNTIME_FOUNDATION_PLAN,
 * Wave 7 / IR-73B_launcher). It starts a branch session through the committed
 * {@link ExperienceSetupModal}, resumes the exact persisted session through the
 * Experience store, renders the immutable session-pinned visual source in the
 * Wave 6 sandboxed host, submits visual actions through the authoritative
 * store, runs durable pending model effects, surfaces failed-effect
 * diagnostics + retry in the trusted modal chrome, supports trusted finish/detach,
 * and keeps every closing UI non-destructive (close never ends the session).
 *
 * Non-goals (IR-73D): composer/send binding, authoring, API/backend/store
 * changes, live visual resource re-fetch. Report/queue/add-later controls are
 * now wired (IR-73C) through the server-authoritative store.
 *
 * Session-preservation invariant: closing the modal calls ONLY
 * `store.closeModal` — never `endSession`. Reopening resumes the same persisted
 * session. The detached surface and the modal are mutually exclusive; only one
 * runs durable effects at a time. Effect ownership (LB-10, Option C): the
 * runner lives while the CHAT PAGE is open — closing the modal keeps draining
 * the queue; leaving the chat unmounts the launcher and stops the runner
 * (durable pending rows stay frozen client-side, resumed on return).
 *
 * Visual source: an active session MUST have a non-null pinned `visualSource`
 * (IR-70G). The launcher surfaces a localized incompatible state when it is
 * null — it NEVER calls `getExperienceVisual(visualId)` to fetch live source.
 */
import * as Popover from "@radix-ui/react-popover";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EXPERIENCE_CONTROLLER, EXPERIENCE_EFFECT_KIND, EXPERIENCE_EFFECT_STATUS } from "@vibe-tavern/domain";
import type { ExperienceActionDto } from "@vibe-tavern/api-contracts";
import { cn } from "../../lib/cn.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useExperienceTimerResync } from "../../hooks/use-experience-timer-resync.js";
import { useT } from "../../i18n/context.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import {
  useExperienceConfig,
  useExperienceDetached,
  useExperienceEffects,
  useExperienceLastError,
  getExperienceLastError,
  useExperienceLoading,
  useExperienceModalOpen,
  useExperienceQueuedAttachment,
  useExperienceReportStatus,
  useExperienceSession,
  useExperienceStore,
  type ExperienceActionIntent,
} from "../../stores/experience-store.js";
import { BottomSheet } from "../shared/BottomSheet.js";
import { Icons } from "../shared/icons.js";
import { getModalPortal } from "../shared/modal-helpers.js";
import {
  ExperienceModal,
  experienceActionOutcome,
  type ExperienceActionOutcome,
} from "./ExperienceModal.js";
import { ExperienceReportControls } from "./ExperienceReportControls.js";
import { ExperienceEffectDiagnostics, RETRYABLE_EFFECT_STATUSES } from "./ExperienceEffectDiagnostics.js";
import { ExperienceSetupModal } from "./ExperienceSetupModal.js";
import {
  ExperienceApiError,
  getExperienceRoundConfig,
  runExperienceRoundModel,
} from "../../api/experience-api.js";
import { buildRealtimeLoopConfig, createPlaygroundModelSeam } from "../../lib/experience-realtime.js";
import type { ExperienceLoopConfig } from "../../lib/experience-loop-host.js";
import {
  openExperienceDetachedWindow,
  type DetachedExperienceDescriptor,
} from "./ExperienceDetachedWindow.js";
import type { BridgeErrorCode } from "../../lib/experience-bridge-schema.js";
import type { ExperienceSessionResponse } from "../../api/types.js";

/** The projected-view type the frame/host pushes. */
type ProjectedView = Parameters<import("./ExperienceFrame.js").ExperienceFrameHandle["sendState"]>[0];

export interface ExperienceLauncherProps {
  /** When true, render statically inside a shared flex bar (no absolute
   *  centering wrapper) — matches the DicePanel `docked` contract. */
  readonly docked?: boolean;
}

export function ExperienceLauncher({ docked = false }: ExperienceLauncherProps): ReactNode {
  const { t } = useT();
  const isMobile = useIsMobile();

  // ── Exact scope from the snapshot store ──────────────────────────────────
  const activeChat = useSnapshotStore((s) => s.activeChat);
  const activeBranch = useSnapshotStore((s) => s.activeBranch);
  const chatId = activeChat?.id ?? null;
  const branchId = activeBranch?.id ?? null;

  // ── Hydrate the Experience store scope for the exact chat/branch ─────────
  // setScope is idempotent for the same scope; it rehydrates on a change and
  // invalidates the previous scope's in-flight reads.
  useEffect(() => {
    if (!chatId || !branchId) return;
    useExperienceStore.getState().setScope(chatId, branchId);
  }, [chatId, branchId]);

  // ── Narrow store selectors (server-authoritative) ────────────────────────
  const config = useExperienceConfig(chatId, branchId);
  const session = useExperienceSession(chatId, branchId);
  const effects = useExperienceEffects(chatId, branchId);
  const queuedAttachment = useExperienceQueuedAttachment(chatId, branchId);
  const reportStatus = useExperienceReportStatus(chatId, branchId);
  const loading = useExperienceLoading(chatId, branchId);
  const lastError = useExperienceLastError(chatId, branchId);
  const modalOpen = useExperienceModalOpen(chatId, branchId);
  const detached = useExperienceDetached(chatId, branchId);

  // ── Local UI state (reset on scope/config changes) ───────────────────────
  const [setupOpen, setSetupOpen] = useState(false);
  // The source session whose snapshots prefill the setup modal when it is
  // opened in restart mode (lobby LB-5); null for a plain Start.
  const [setupRestartSource, setSetupRestartSource] = useState<ExperienceSessionResponse | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popupError, setPopupError] = useState(false);
  const scopeKey = chatId && branchId ? JSON.stringify([chatId, branchId]) : null;
  // Stable configuration surface key (value identity, NOT object identity) so
  // setup/popover/popup errors reset when the authoritative config changes —
  // not only on a scope switch. Uses enabled/launcherVisible/scriptId/visualId.
  const configKey = config
    ? JSON.stringify([config.enabled, config.launcherVisible, config.scriptId, config.visualId])
    : null;
  const lastSurfaceKey = useRef<string | null>(null);
  const surfaceKey = scopeKey === null ? null : `${scopeKey}\n${configKey ?? ""}`;
  useEffect(() => {
    if (lastSurfaceKey.current !== surfaceKey) {
      lastSurfaceKey.current = surfaceKey;
      setSetupOpen(false);
      setSetupRestartSource(null);
      setPopoverOpen(false);
      setPopupError(false);
    }
  }, [surfaceKey]);

  // ── Realtime round state (RM-10) ─────────────────────────────────────────
  // The round-config probe IS the realtime detector: the session response
  // carries no mode flag (the session row persists only the manifest id/name),
  // so a 200 from GET round/config means realtime and a typed `not_realtime`
  // 422 means turn. The config is LATCHED once per sessionId — NEVER derived
  // per render: the serialized config is the frame document key, so an
  // unstable config would restart the loop on every render.
  const [realtimeRound, setRealtimeRound] = useState<{ sessionId: string; config: ExperienceLoopConfig } | null>(null);
  const [realtimeError, setRealtimeError] = useState<string | null>(null);
  /** Per-session probe cache: a turn session's Resume never re-probes, and a
   *  latched realtime session reuses its config across modal close/reopen. */
  const roundProbeRef = useRef<{ sessionId: string } | null>(null);
  /** Latest-session ref so the stable model seam reads the live roster. */
  const sessionRef = useRef(session);
  sessionRef.current = session;

  /** Probe + latch the realtime round config for a session about to open.
   *  Awaits BEFORE openModal so the frame mounts with the loop in ONE
   *  document build. Failures degrade gracefully: the modal still opens
   *  (loop-less frame) and the status line carries the failure. */
  async function ensureRealtimeRound(s: ExperienceSessionResponse): Promise<void> {
    if (roundProbeRef.current?.sessionId === s.sessionId) return;
    try {
      const cfg = await getExperienceRoundConfig(s.sessionId);
      roundProbeRef.current = { sessionId: s.sessionId };
      const built = buildRealtimeLoopConfig({
        rulesSource: cfg.rulesSource,
        tickMs: cfg.tickMs,
        initialState: cfg.initialState,
        initialSettings: cfg.initialSettings,
        seed: cfg.seed,
        seats: cfg.participants.map((p) => ({
          id: p.id,
          label: p.label,
          controller: p.controller,
          ...(p.providerProfileId !== undefined ? { providerProfileId: p.providerProfileId } : {}),
          ...(p.modelId !== undefined ? { modelId: p.modelId } : {}),
        })),
        humanSeatId: "", // first human seat; observer when the roster has none
      });
      if (built.ok) {
        setRealtimeRound({ sessionId: s.sessionId, config: built.config });
        setRealtimeError(null);
      } else {
        if (typeof console !== "undefined") console.warn("[experience] realtime config invalid:", built.message);
        setRealtimeRound(null);
        setRealtimeError(t("experience_realtime_config_failed"));
      }
    } catch (err) {
      if (err instanceof ExperienceApiError && err.code === "not_realtime") {
        // Turn session — the negative probe is cached; never an error.
        roundProbeRef.current = { sessionId: s.sessionId };
        setRealtimeRound(null);
        setRealtimeError(null);
        return;
      }
      // A realtime session whose config failed to load: NOT cached, so the
      // next open retries; the modal opens without the loop and says why.
      setRealtimeRound(null);
      setRealtimeError(t("experience_realtime_config_failed"));
    }
  }

  // A new session identity = a new round: drop the latch, the error, and the
  // probe cache so the next open re-probes. A modal close/reopen keeps the
  // SAME sessionId — the latch survives and Resume remounts a FRESH round
  // from the same pinned snapshot (round-lost-on-close is by design: the loop
  // dies with the frame, progress is gone, no ghost resume — but the round
  // restarts deterministically on the session's pinned seed, so an eventual
  // commit still passes RM-8 replay verification).
  const sessionIdentity = session?.sessionId ?? null;
  useEffect(() => {
    setRealtimeRound(null);
    setRealtimeError(null);
    roundProbeRef.current = null;
  }, [sessionIdentity]);

  /** The live model seam (RM-10): stable identity (refs + console only) so
   *  the bridge closure never strands; the roster is read live through
   *  sessionRef. Mirrors the RM-6 fail-closed contract via the shared helper. */
  const modelSeam = useMemo(
    () =>
      createPlaygroundModelSeam({
        roundModel: runExperienceRoundModel,
        seatProfile: (seatId) => {
          const seat = sessionRef.current?.participants.find(
            (p) => p.id === seatId && p.controller === EXPERIENCE_CONTROLLER.model,
          );
          if (seat === undefined || seat.providerProfileId === undefined || seat.modelId === undefined) {
            return null;
          }
          return { providerProfileId: seat.providerProfileId, modelId: seat.modelId };
        },
        onError: (message) => {
          if (typeof console !== "undefined") console.warn("[experience]", message);
        },
      }),
    [],
  );

  // ── Visibility computed before the effect-runner hooks (Rules of Hooks) ───
  // `visible` is part of effect ownership: a launcher whose config became
  // invisible must NOT keep owning/running model effects while no surface is
  // rendered — the modal is force-closed below.
  const configReady = config !== null;
  const visible =
    chatId !== null
    && branchId !== null
    && configReady
    && config!.enabled
    && config!.launcherVisible
    && config!.scriptId !== null
    && config!.visualId !== null;

  // When the config becomes invisible while the local modal is open, close it
  // non-destructively (store closeModal only — never endSession).
  useEffect(() => {
    if (!visible && modalOpen) {
      useExperienceStore.getState().closeModal();
    }
  }, [visible, modalOpen]);

  // ── In-flight effect run registry (one at a time, no running/unknown repeat) ─
  const effectRunRef = useRef<AbortController | null>(null);

  // These are computed BEFORE the visibility gate so the effect-runner and
  // session-abort hooks below always run in the same order (Rules of Hooks).
  // Effect ownership (LB-10, Option C): the chat page being open owns the
  // effects — the launcher chip renders while the chat page is open, so the
  // queue drains with the modal closed too. A hidden/invisible launcher and a
  // detached surface never own them; the detached window runs its own runner.
  const hasSession = session !== null;
  const surfaceOwnsEffects = visible && !detached && hasSession;
  const sessionId = session?.sessionId ?? null;

  // ── Durable model effect runner (while the chat-page surface owns effects) ─
  // LB-10 Option C: the runner lives while the chat page is open — the modal
  // state is irrelevant. Runs only `pending` MODEL rows, one at a time, through an abortable
  // store.runEffect. Timer effects are host-scheduled (fix step 2c): the
  // server answers 202 without running them, so they MUST be skipped here or
  // this loop would re-call the route forever. Never auto-repeats
  // running/unknown/failed. The store rehydrates after each run, re-triggering
  // for the next pending row. A genuine session change aborts the in-flight
  // run.
  useEffect(() => {
    if (!surfaceOwnsEffects) return;
    if (effectRunRef.current) return; // one at a time
    const pending = effects.find((e) => e.status === EXPERIENCE_EFFECT_STATUS.pending && e.kind === "model");
    if (!pending) return;
    const controller = new AbortController();
    effectRunRef.current = controller;
    void useExperienceStore
      .getState()
      .runEffect(pending.id, controller.signal)
      .finally(() => {
        if (effectRunRef.current === controller) effectRunRef.current = null;
      });
  }, [effects, surfaceOwnsEffects]);

  // Abort the in-flight effect on a genuine session change.
  useEffect(() => {
    return () => {
      effectRunRef.current?.abort();
      effectRunRef.current = null;
    };
  }, [sessionId]);

  // ── Visibility gate ──────────────────────────────────────────────────────
  // Return null unless: exact scope exists, config loaded, enabled,
  // launcherVisible, scriptId non-null, visualId non-null. An active session
  // must additionally have non-null pinned visualSource; otherwise surface an
  // incompatible/error state rather than fetching live source.
  // `visible` was already computed before the effect-runner hooks above.
  // ── Timer tick pickup (fix step 2d) ───────────────────────────────────────
  // Host-fired ticks land server-side; while this surface is open and a timer
  // is live, slowly rehydrate so the applied tick (new revision/view) and the
  // terminal effect row arrive without user interaction. Self-disarms when no
  // live timer remains. Runs BEFORE the visibility gate like every other hook
  // (Rules of Hooks: the gate's early return must never change hook count).
  useExperienceTimerResync({ chatId, branchId, effects, view: session?.view ?? null, active: visible && !detached && hasSession });

  if (!visible) return null;

  const title = session?.manifest.name ?? config!.scriptId ?? "";
  const incompatible = hasSession && session!.visualSource === null;
  // Endgame (lobby Б3): a terminal branch session (completed or interrupted)
  // swaps the primary launcher action for the restart pair. Status is a plain
  // string union — no domain constant is needed.
  const terminal = hasSession && (session!.status === "completed" || session!.status === "interrupted");

  // ── Localized bridge-error message for the fail-closed action outcome ────
  function localizeError(code: BridgeErrorCode): string {
    return code === "stale_revision" ? t("experience_action_stale") : t("experience_action_invalid");
  }

  // ── Action handler: strip CAS/idempotency, submit via store, return outcome ─
  async function handleAction(action: ExperienceActionDto): Promise<ExperienceActionOutcome> {
    // RM-10: a realtime round is driven by the frame loop — a TURN action
    // from the visual (experience.act()) is a mode error, never a server
    // advance (the frame loop and the server session must never become two
    // authorities). Fail-closed: the modal turns this outcome into sendError,
    // the bridge lock clears, and NOTHING is submitted.
    if (session !== null && realtimeRound?.sessionId === session.sessionId) {
      return { ok: false, code: "invalid_action", message: t("experience_realtime_turn_disabled") };
    }
    const intent: ExperienceActionIntent = {
      type: action.type,
      ...(action.participantId !== undefined ? { participantId: action.participantId } : {}),
      ...(action.payload !== undefined ? { payload: action.payload } : {}),
    };
    const store = useExperienceStore.getState();
    let response = await store.submitAction(intent);
    if (!chatId || !branchId) return { ok: false, code: "invalid_action", message: localizeError("invalid_action") };
    // Read the scope FRESH after each await (getState() at call time) — the
    // submit/retry failure path rehydrates before surfacing the error, and the
    // outcome mapping reads the error + revision from the current scope.
    const scopeAfter = () => useExperienceStore.getState().byScope[JSON.stringify([chatId, branchId])] ?? null;
    let outcome = experienceActionOutcome(response, scopeAfter()?.lastApiError ?? null, scopeAfter()?.session?.revision, localizeError);
    // Timer-freedom fix: with controls enabled while timers are live, a click
    // can race a host-fired tick (the client view is up to one resync behind
    // the server). A stale click is not a user error — the store's failure
    // path already rehydrated the fresh revision, so re-submit the SAME intent
    // once. The second failure (if any) surfaces to the visual as before.
    if (!outcome.ok && outcome.code === "stale_revision") {
      response = await store.submitAction(intent);
      outcome = experienceActionOutcome(response, scopeAfter()?.lastApiError ?? null, scopeAfter()?.session?.revision, localizeError);
    }
    return outcome;
  }

  // ── Start: open the setup modal for the exact chat/branch ────────────────
  function handleStart(): void {
    setPopoverOpen(false);
    setSetupRestartSource(null);
    setSetupOpen(true);
  }

  // ── Setup onReady: close setup, probe the round config (RM-10), open the ─
  // persisted modal — the probe awaits BEFORE openModal so a realtime frame
  // mounts with its loop in one document build (on failure the modal still
  // opens; the status line carries the error).
  async function handleSetupReady(_session: ExperienceSessionResponse): Promise<void> {
    setSetupOpen(false);
    setSetupRestartSource(null);
    await ensureRealtimeRound(_session);
    useExperienceStore.getState().openModal();
  }

  // ── Resume: reopen the SAME session through the store ────────────────────
  async function handleResume(): Promise<void> {
    setPopoverOpen(false);
    setPopupError(false);
    // Clear a stale detached flag so the main surface owns effects again.
    useExperienceStore.getState().setDetached(false);
    if (session) await ensureRealtimeRound(session);
    useExperienceStore.getState().openModal();
  }

  // ── Close modal: NEVER end the session ───────────────────────────────────
  function handleCloseModal(): void {
    setPopupError(false);
    useExperienceStore.getState().closeModal();
  }

  // ── Endgame «Играть снова» (Б3): one-shot restart, NO setup modal — an
  // empty body makes the server reuse the source match's frozen snapshots,
  // the plain rehydrate discovers the successor as the branch's active
  // session, and the session modal opens on the NEW match.
  async function handlePlayAgain(): Promise<void> {
    setPopoverOpen(false);
    try {
      const result = await useExperienceStore.getState().restartSession();
      if (result !== null) {
        await ensureRealtimeRound(result);
        useExperienceStore.getState().openModal();
      }
    } catch (err) {
      // The session (or scope) may disappear between render and click — the
      // store then rejects locally. Keep this surface quiet rather than leaking
      // an unhandled rejection (same guard as handleFinishExperience).
      if (typeof console !== "undefined") console.warn("[experience] restart rejected", err);
    }
  }

  // ── Endgame «Изменить настройки» (Б3): open the setup modal PREFILLED from
  //  the finished match's frozen snapshots (LB-5) — Start then restarts.
  function handleRestartChangeSettings(): void {
    setPopoverOpen(false);
    setSetupRestartSource(session);
    setSetupOpen(true);
  }

  // ── In-session settings entry (Б4): the session modal's trusted-chrome
  // confirm routed here — close the session modal FIRST so the setup modal
  // is the only open surface.
  function handleOpenSessionSettings(): void {
    useExperienceStore.getState().closeModal();
    setSetupRestartSource(session);
    setSetupOpen(true);
  }

  // ── Finish: trusted confirmation → endSession → close ONLY on success ─────
  // The store returns the terminal queued attachment on success, or null on a
  // server failure (after its own resync surfaces lastError). Close the modal
  // ONLY when the server returned a non-null final attachment — on null keep
  // the modal/session surface open so the user can see the store error and
  // retry. The trusted confirmation step itself lives in the modal chrome.
  async function handleFinishExperience(): Promise<void> {
    try {
      const result = await useExperienceStore.getState().endSession();
      if (result !== null) {
        useExperienceStore.getState().closeModal();
      }
    } catch (err) {
      // The session may disappear between render and confirmation (for example,
      // after another trusted surface finishes it). Keep this surface open and
      // retryable rather than leaking an unhandled rejection or guessing that
      // the terminal attachment exists.
      if (typeof console !== "undefined") console.warn("[experience] finish rejected", err);
    }
  }

  // ── Quiet end (pos 2 quiet close): trusted confirmation → endSession(true)
  //    → close ONLY on a genuine success ────────────────────────────────────
  // A quiet end returns null BY DESIGN (nothing posted to the chat), so the
  // finish handler's `result !== null` gate does not apply. Success is instead
  // judged by whether the store recorded an error after the resync: null return
  // + no lastError = server ended the session quietly → close. null return +
  // lastError set (409/404) = server did NOT end it → keep the modal open so
  // the fail-closed error stays visible and retryable.
  async function handleEndSessionQuiet(): Promise<void> {
    try {
      await useExperienceStore.getState().endSession(true);
      if (getExperienceLastError(chatId, branchId) === null) {
        useExperienceStore.getState().closeModal();
      }
    } catch (err) {
      // Same keep-open-and-retryable guard as the with-report finish.
      if (typeof console !== "undefined") console.warn("[experience] quiet finish rejected", err);
    }
  }

  // ── Queue / Add later: the SAME server operation (store.queueReport) backs ─
  // both the initial manual Queue and a replacement/Add-later. The store owns
  // race guards + the server resync; this callback rejects on a null store
  // result so the report-control surface can show a fail-closed error WITHOUT
  // an optimistic count/revision bump. No local synthesis — the store
  // rehydrate supplies the new frozen values.
  async function handleQueueReport(): Promise<void> {
    const result = await useExperienceStore.getState().queueReport();
    if (result === null) throw new Error("experience queue failed");
  }

  // ── Effect retry (lobby diagnostics): reject on a null store result so the ─
  // diagnostics surface can show a fail-closed error. On success the store
  // resync brings the pending row back and the chat-page runner (LB-10)
  // picks it up — this callback never runs the effect itself.
  async function handleRetryEffect(effectId: string): Promise<void> {
    const row = await useExperienceStore.getState().retryEffect(effectId);
    if (row === null) throw new Error("experience effect retry failed");
  }

  // ── Detach: open the persisted detached window with the pinned descriptor ─
  function handleDetach(): void {
    if (!session) return;
    const descriptor: DetachedExperienceDescriptor = {
      chatId: chatId!,
      branchId: branchId!,
      sessionId: session.sessionId,
      title,
      visualSource: session.visualSource ?? "",
      initialRevision: session.revision,
      initialView: session.view as ProjectedView,
    };
    const popup = openExperienceDetachedWindow(descriptor);
    if (popup === null) {
      // Popup blocked — stay in the modal and show a localized error.
      setPopupError(true);
      return;
    }
    setPopupError(false);
    useExperienceStore.getState().closeModal();
    useExperienceStore.getState().setDetached(true);
  }

  // ── Pending phase drives chrome + visual (pending/running rows) ───────────
  // Model work wins when both kinds are in flight ("thinking…" outranks
  // "waiting…"); a live timer alone shows the timer-wait chrome (fix step 2d).
  const modelWork = surfaceOwnsEffects && effects.some(
    (e) => e.kind === EXPERIENCE_EFFECT_KIND.model && (e.status === EXPERIENCE_EFFECT_STATUS.pending || e.status === EXPERIENCE_EFFECT_STATUS.running),
  );
  const timerWork = surfaceOwnsEffects && effects.some(
    (e) => e.kind === EXPERIENCE_EFFECT_KIND.timer && (e.status === EXPERIENCE_EFFECT_STATUS.pending || e.status === EXPERIENCE_EFFECT_STATUS.running),
  );
  const pendingPhase: "idle" | "effect" | "timer" = modelWork ? "effect" : timerWork ? "timer" : "idle";

  // ── Pill label + body ────────────────────────────────────────────────────
  const pillLabel = incompatible
    ? t("experience_launcher_incompatible")
    : hasSession
      ? t("experience_launcher_resume")
      : t("experience_launcher_start");
  // RM-10: a realtime round's lifecycle is the frame loop's — the status
  // line says the round is running instead of the generic active line; a
  // failed config probe degrades to the config-failed message (lastError and
  // loading still win over both).
  const isRealtimeLive =
    session !== null && session.status === "active" && realtimeRound?.sessionId === session.sessionId;
  const statusLine = incompatible
    ? t("experience_incompatible")
    : lastError
      ? lastError
      : loading
        ? t("experience_launcher_loading")
        : realtimeError !== null
          ? realtimeError
          : terminal
            ? t("experience_launcher_finished")
            : isRealtimeLive
              ? t("experience_realtime_running")
              : hasSession
                ? t("experience_launcher_active")
                : "";

  const body = (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex flex-col gap-0.5">
        <span className="font-ui text-[12px] font-medium text-t1">{title || t("experience_launcher_title")}</span>
        {statusLine && <span className="font-ui text-[11px] text-t4">{statusLine}</span>}
      </div>
      {terminal && !incompatible ? (
        // Endgame (Б3): the primary action is replaced by the restart pair.
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="rounded bg-accent px-3 py-1.5 font-ui text-[12px] font-medium text-on-accent hover:opacity-90"
            onClick={() => void handlePlayAgain()}
            data-testid="experience-restart-again"
          >
            {t("experience_restart_play_again")}
          </button>
          <button
            type="button"
            className="rounded bg-s2 px-3 py-1.5 font-ui text-[12px] font-medium text-t2 hover:bg-s3"
            onClick={handleRestartChangeSettings}
            data-testid="experience-restart-settings"
          >
            {t("experience_restart_change_settings")}
          </button>
        </div>
      ) : !incompatible && (
        <button
          type="button"
          className="rounded bg-accent px-3 py-1.5 font-ui text-[12px] font-medium text-on-accent hover:opacity-90"
          onClick={hasSession ? handleResume : handleStart}
          data-testid="experience-launcher-primary"
        >
          {pillLabel}
        </button>
      )}
      {/* Report controls live in the popover/sheet ONLY while the modal is
          closed (IR-73C) — when the modal is open the same controls live in
          its trusted footer. Never both at once. The surfaceKey (scope +
          authoritative config) remounts the component on a branch switch OR a
          config-surface change, clearing any stale local queue error. */}
      {hasSession && !incompatible && !modalOpen && (
        <ExperienceReportControls
          key={surfaceKey ?? undefined}
          queuedAttachment={queuedAttachment}
          reportStatus={reportStatus}
          onQueue={handleQueueReport}
        />
      )}
      {popupError && (
        <p className="font-ui text-[11px] leading-relaxed text-danger-text" role="alert">
          {t("experience_popup_blocked")}
        </p>
      )}
    </div>
  );

  // ── Render ───────────────────────────────────────────────────────────────
  const pill = (
    <button
      type="button"
      aria-label={t("experience_launcher_title")}
      aria-expanded={popoverOpen}
      className={cn(
        "glass-blur flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-border2 bg-glass-bg px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-t2 shadow-sm transition-colors hover:bg-s3 hover:text-t1",
        incompatible && "border-warning/50 bg-warning-dim text-warning-text",
      )}
      data-testid="experience-launcher-pill"
    >
      <Icons.Sparkles className="h-3.5 w-3.5" />
      <span>{pillLabel}</span>
      <Icons.Caret direction={popoverOpen ? "d" : "u"} />
    </button>
  );

  const popover = (
    <Popover.Root open={popoverOpen} onOpenChange={setPopoverOpen}>
      <Popover.Trigger asChild>{pill}</Popover.Trigger>
      {!isMobile && (
        <Popover.Portal container={getModalPortal() ?? undefined}>
          <Popover.Content
            side={docked ? "top" : "top"}
            align="center"
            sideOffset={4}
            className="glass-blur z-[220] w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border2 bg-glass-bg shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          >
            {body}
          </Popover.Content>
        </Popover.Portal>
      )}
    </Popover.Root>
  );

  const launcher = docked ? (
    popover
  ) : (
    <div className="absolute bottom-full left-1/2 z-20 mb-1 -translate-x-1/2">{popover}</div>
  );

  return (
    <>
      {launcher}
      {popoverOpen && isMobile && (
        <BottomSheet open={true} onClose={() => setPopoverOpen(false)} title={title || t("experience_launcher_title")}>
          {body}
        </BottomSheet>
      )}
      {chatId && branchId && (
        <ExperienceSetupModal
          open={setupOpen}
          chatId={chatId}
          branchId={branchId}
          onClose={() => { setSetupOpen(false); setSetupRestartSource(null); }}
          onReady={handleSetupReady}
          restartSource={setupRestartSource}
        />
      )}
      {hasSession && !incompatible && (
        <ExperienceModal
          open={modalOpen}
          onClose={handleCloseModal}
          title={title}
          statusLabel={statusLine}
          pendingPhase={pendingPhase}
          visualSource={session!.visualSource ?? ""}
          sessionId={session!.sessionId}
          initialRevision={session!.revision}
          view={session!.view as ProjectedView}
          onAction={handleAction}
          // RM-10: realtime props only for a probed realtime session — the
          // latched loop config, the fail-closed model seam, and the commit
          // hook. Detach is OMITTED for realtime: a round may live in exactly
          // ONE surface (the detached window is not a realtime host — two
          // surfaces would run two diverging logs of the same round).
          realtime={isRealtimeLive && realtimeRound !== null ? { config: realtimeRound.config } : undefined}
          onModelRequest={isRealtimeLive ? modelSeam : undefined}
          onRoundCommit={
            isRealtimeLive
              ? (claim) => {
                  // Fire-and-forget: the modal's own finished panel owns the
                  // immediate UX; the store owns the server truth (RM-8
                  // replay-verify → one terminal transition + the chat card).
                  // A verification failure surfaces through the store's
                  // lastError after its resync.
                  void useExperienceStore.getState().commitRound(claim);
                }
              : undefined
          }
          onDetach={isRealtimeLive ? undefined : handleDetach}
          onFinishExperience={() => void handleFinishExperience()}
          onEndSessionQuiet={handleEndSessionQuiet}
          // Б4 is the RUNNING-game entry: terminal games use the popover
          // restart pair instead, so the in-session settings entry is wired
          // only for an active, compatible match.
          onOpenSessionSettings={
            hasSession && !terminal && !incompatible ? handleOpenSessionSettings : undefined
          }
          reportControls={
            modalOpen ? (
              <ExperienceReportControls
                key={surfaceKey ?? undefined}
                queuedAttachment={queuedAttachment}
                reportStatus={reportStatus}
                onQueue={handleQueueReport}
              />
            ) : undefined
          }
          effectDiagnostics={
            modalOpen && effects.some((e) => RETRYABLE_EFFECT_STATUSES.includes(e.status)) ? (
              <ExperienceEffectDiagnostics
                key={surfaceKey ?? undefined}
                effects={effects}
                onRetry={handleRetryEffect}
              />
            ) : undefined
          }
          onError={(reason) => {
            // Observability only — never crash the host tree.
            if (typeof console !== "undefined") console.warn("[experience]", reason);
          }}
        />
      )}
      {popupError && modalOpen && (
        <p
          className="pointer-events-none fixed bottom-4 left-1/2 z-[300] -translate-x-1/2 rounded bg-danger px-3 py-1.5 font-ui text-[12px] text-white shadow-lg"
          role="alert"
          data-testid="experience-popup-error"
        >
          {t("experience_popup_blocked")}
        </p>
      )}
    </>
  );
}
