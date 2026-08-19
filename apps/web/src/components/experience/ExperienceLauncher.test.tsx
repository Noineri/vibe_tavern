/**
 * ExperienceLauncher — IR-73B boundary tests.
 *
 * Boundary under test: mocked Experience store + snapshot store + SetupModal
 * seams → the REAL ExperienceLauncher (with the REAL shared Popover/BottomSheet
 * pill) → DOM observations + store-action assertions. The ExperienceModal is
 * mocked to a thin shell so the launcher's prop-wiring (pinned source, action
 * intent, finish, detach) is observable without the bridge/iframe machinery
 * (those are pinned by ExperienceModal/Frame tests).
 *
 * Runner: bun:test + happy-dom (useDomEnv). i18n returns keys verbatim. The
 * Experience store is a useSyncExternalStore-backed fake so the launcher's
 * reads/actions are controllable. RTL cleanup() runs after every test.
 *
 * Pinned contract areas (numbered to the IR-73B spec):
 *  1. hidden for no scope/loading/disabled/launcher-hidden/missing script/visual
 *  2. exact setScope hydration + A→B late-result isolation
 *  3. no session Start opens SetupModal; onReady opens modal; Resume reopens; close≠end
 *  4. session uses exact pinned visual source
 *  5. visual action strips CAS/idempotency; outcome carries committed revision/status/view
 *  7. pending effect runs once; running/unknown/failed never auto-run
 *  8. trusted finish confirmation required before endSession
 *  9. detach descriptor includes exact scope+pinned source; blocked popup error
 * 10. branch switch shows branch's own session + closes local surfaces
 * 11. desktop Popover / mobile BottomSheet
 * 12. endgame restart pair replaces the primary for terminal sessions (Б3);
 *     the in-session settings entry is wired only for ACTIVE matches (Б4)
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import type { ReactNode } from "react";

useDomEnv();
const { render, fireEvent, act } = await import("@testing-library/react");
const { useSyncExternalStore } = await import("react");
const { TIMER_RESYNC_INTERVAL_MS } = await import("../../hooks/use-experience-timer-resync.js");

const CHAT_ID = "chat_1";
const BRANCH_ID = "branch_1";
const SCOPE_KEY = JSON.stringify([CHAT_ID, BRANCH_ID]);

// ─── fake Experience store (useSyncExternalStore-backed) ────────────────────
interface FakeScopeState {
  config: {
    enabled: boolean;
    launcherVisible: boolean;
    scriptId: string | null;
    visualId: string | null;
  } | null;
  session: {
    sessionId: string;
    visualSource: string | null;
    visualSourceHash: string | null;
    revision: number;
    status: string;
    view: { revision: number; status: string; state: unknown; actions: unknown[] };
    manifest: { name: string };
  } | null;
  effects: Array<{ id: string; kind?: string; status: string }>;
  queuedAttachment: {
    queueRevision: number;
    sessionRevision: number;
    publicReport: { title: string; events: Array<{ type: string; detail?: unknown }> } | null;
  } | null;
  reportStatus: {
    reportFrontier: number;
    pendingPublicEventCount: number;
  } | null;
  loading: boolean;
  lastError: string | null;
  modalOpen: boolean;
  detached: boolean;
  lastApiError: { code?: string } | null;
}

interface FakeState {
  byScope: Record<string, FakeScopeState>;
  activeScope: { chatId: string; branchId: string } | null;
}

let state: FakeState = { byScope: {}, activeScope: null };
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
const emit = () => listeners.forEach((l) => l());

// A stable empty scope so useSyncExternalStore never sees a new reference
// on every getSnapshot call (which would cause an infinite re-render loop).
const EMPTY_SCOPE: FakeScopeState = {
  config: null,
  session: null,
  effects: [],
  queuedAttachment: null,
  reportStatus: null,
  loading: false,
  lastError: null,
  modalOpen: false,
  detached: false,
  lastApiError: null,
};

function scopeState(key: string): FakeScopeState {
  return state.byScope[key] ?? EMPTY_SCOPE;
}
function readField<T>(key: string | null, fn: (s: FakeScopeState) => T): T {
  if (!key) return fn(scopeState("__none__"));
  return fn(scopeState(key));
}
function setScopeState(key: string, patch: Partial<FakeScopeState>): void {
  state.byScope[key] = { ...scopeState(key), ...patch };
  emit();
}

const storeMocks = {
  rehydrate: mock(async () => {}),
  setScope: mock((_chatId: string, _branchId: string) => {}),
  openModal: mock(() => {}),
  closeModal: mock(() => {}),
  setDetached: mock((_d: boolean) => {}),
  submitAction: mock(async (_intent: unknown) => null as unknown),
  endSession: mock(async () => null as unknown),
  restartSession: mock(async () => null as unknown),
  runEffect: mock(async (_effectId: string, _signal?: AbortSignal) => null as unknown),
  retryEffect: mock(async (_effectId: string) => null as unknown),
  queueReport: mock(async () => null as unknown),
};

// ─── module mocks ───────────────────────────────────────────────────────────
const realI18n = await import("../../i18n/context.js");
const realStore = await import("../../stores/experience-store.js");
const realSnapshot = await import("../../stores/snapshot-store.js");
const realMobile = await import("../../hooks/use-mobile.js");
const realTooltip = await import("../shared/Tooltip.js");
const realBottomSheet = await import("../shared/BottomSheet.js");
const realDetached = await import("./ExperienceDetachedWindow.js");

const stableT = {
  // Keys WITHOUT interpolation params are returned verbatim (preserving every
  // existing assertion). Keys WITH params append the opts JSON so the
  // report-control integration test can verify exact server-supplied counts /
  // revisions without local arithmetic.
  t: (k: string, opts?: Record<string, unknown>) =>
    opts && Object.keys(opts).length > 0 ? `${k}:${JSON.stringify(opts)}` : k,
  tDynamic: (k: string) => k,
  locale: "en",
  setLocale: () => {},
  ready: true,
};

mock.module("../../i18n/context.js", () => ({ ...realI18n, useT: () => stableT }));

// Snapshot store: returns the active chat/branch.
let snapshotChat: { id: string } | null = { id: CHAT_ID };
let snapshotBranch: { id: string } | null = { id: BRANCH_ID };
mock.module("../../stores/snapshot-store.js", () => ({
  ...realSnapshot,
  useSnapshotStore: (selector: (s: { activeChat: typeof snapshotChat; activeBranch: typeof snapshotBranch }) => unknown) =>
    selector({ activeChat: snapshotChat, activeBranch: snapshotBranch }),
}));

mock.module("../../stores/experience-store.js", () => ({
  ...realStore,
  useExperienceConfig: (_c: string | null, _b: string | null) =>
    useSyncExternalStore(subscribe, () => readField(currentScopeKey(), (s) => s.config)),
  useExperienceSession: () => useSyncExternalStore(subscribe, () => readField(currentScopeKey(), (s) => s.session)),
  useExperienceEffects: () => useSyncExternalStore(subscribe, () => readField(currentScopeKey(), (s) => s.effects)),
  useExperienceQueuedAttachment: () =>
    useSyncExternalStore(subscribe, () => readField(currentScopeKey(), (s) => s.queuedAttachment)),
  useExperienceReportStatus: () =>
    useSyncExternalStore(subscribe, () => readField(currentScopeKey(), (s) => s.reportStatus)),
  useExperienceLoading: () => useSyncExternalStore(subscribe, () => readField(currentScopeKey(), (s) => s.loading)),
  useExperienceLastError: () => useSyncExternalStore(subscribe, () => readField(currentScopeKey(), (s) => s.lastError)),
  useExperienceModalOpen: () => useSyncExternalStore(subscribe, () => readField(currentScopeKey(), (s) => s.modalOpen)),
  useExperienceDetached: () => useSyncExternalStore(subscribe, () => readField(currentScopeKey(), (s) => s.detached)),
  useExperienceStore: {
    getState: () => ({
      activeScope: state.activeScope,
      byScope: Object.fromEntries(
        Object.entries(state.byScope).map(([k, v]) => [k, { lastApiError: v.lastApiError, session: v.session }]),
      ),
      setScope: (chatId: string, branchId: string) => {
        storeMocks.setScope(chatId, branchId);
        state.activeScope = { chatId, branchId };
      },
      openModal: () => {
        storeMocks.openModal();
        const key = currentScopeKey();
        if (key) setScopeState(key, { modalOpen: true });
      },
      closeModal: () => {
        storeMocks.closeModal();
        const key = currentScopeKey();
        if (key) setScopeState(key, { modalOpen: false });
      },
      setDetached: (d: boolean) => {
        storeMocks.setDetached(d);
        const key = currentScopeKey();
        if (key) setScopeState(key, { detached: d });
      },
      submitAction: storeMocks.submitAction,
      rehydrate: storeMocks.rehydrate,
      endSession: storeMocks.endSession,
      restartSession: storeMocks.restartSession,
      runEffect: storeMocks.runEffect,
      retryEffect: storeMocks.retryEffect,
      queueReport: storeMocks.queueReport,
    }),
  },
}));

function currentScopeKey(): string | null {
  if (!snapshotChat || !snapshotBranch) return null;
  return JSON.stringify([snapshotChat.id, snapshotBranch.id]);
}

let mobileOverride = false;
mock.module("../../hooks/use-mobile.js", () => ({
  ...realMobile,
  useIsMobile: () => mobileOverride,
}));

mock.module("../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

mock.module("../shared/BottomSheet.js", () => ({
  ...realBottomSheet,
  BottomSheet: ({ open, title, children }: { open: boolean; title?: ReactNode; children: ReactNode }) =>
    open ? <div data-testid="bottom-sheet">{title}{children}</div> : null,
}));

// Mock ExperienceSetupModal to a thin shell so Start/onReady are observable.
let setupOnReady: ((s: unknown) => void) | null = null;
mock.module("./ExperienceSetupModal.js", () => ({
  ExperienceSetupModal: ({ open, onClose, onReady, restartSource }: { open: boolean; onClose: () => void; onReady?: (s: unknown) => void; restartSource?: unknown }) => {
    setupOnReady = onReady ?? null;
    return open ? (
      <div data-testid="setup-modal">
        <button data-testid="setup-close" onClick={onClose}>close</button>
        {restartSource ? <span data-testid="setup-restart-src" /> : null}
        <button
          data-testid="setup-ready"
          onClick={() => onReady?.({ sessionId: "sess_new", visualSource: "<div>new</div>", revision: 1, status: "active", view: { revision: 1, status: "active", state: {}, actions: [] }, manifest: { name: "Game" } })}
        >
          ready
        </button>
      </div>
    ) : null;
  },
}));

// Mock ExperienceModal to a thin shell so the launcher's props are observable,
// while preserving the REAL experienceActionOutcome (a pure function).
const realModal = await import("./ExperienceModal.js");
let modalProps: Record<string, unknown> = {};
mock.module("./ExperienceModal.js", () => ({
  ...realModal,
  ExperienceModal: (props: Record<string, unknown>) => {
    modalProps = props;
    return props.open ? (
      <div data-testid="experience-modal">
        <span data-testid="modal-visual-source">{String(props.visualSource ?? "")}</span>
        <span data-testid="modal-session-id">{String(props.sessionId ?? "")}</span>
        <span data-testid="modal-pending">{String(props.pendingPhase ?? "idle")}</span>
        <button data-testid="modal-close" onClick={() => (props.onClose as () => void)()}>close</button>
        <button data-testid="modal-detach" onClick={() => (props.onDetach as () => void)()}>detach</button>
        <button data-testid="modal-finish" onClick={() => (props.onFinishExperience as () => void)()}>finish</button>
        {props.onOpenSessionSettings ? (
          <button data-testid="modal-session-settings" onClick={() => (props.onOpenSessionSettings as () => void)()}>settings</button>
        ) : null}
        {props.effectDiagnostics ? (
          <div data-testid="modal-effect-diagnostics">{props.effectDiagnostics as ReactNode}</div>
        ) : null}
      </div>
    ) : null;
  },
}));

// Mock openExperienceDetachedWindow.
let detachResult: Window | null = null;
mock.module("./ExperienceDetachedWindow.js", () => ({
  ...realDetached,
  openExperienceDetachedWindow: mock(() => detachResult),
}));

const { ExperienceLauncher } = await import("./ExperienceLauncher.js");

// ─── fixtures ───────────────────────────────────────────────────────────────
function makeConfig(over: Partial<FakeScopeState["config"]> = {}): NonNullable<FakeScopeState["config"]> {
  return { enabled: true, launcherVisible: true, scriptId: "script_1", visualId: "vis_1", ...over };
}
function makeSession(over: Partial<NonNullable<FakeScopeState["session"]>> = {}): NonNullable<FakeScopeState["session"]> {
  return {
    sessionId: "sess_1",
    visualSource: "<div>play</div>",
    visualSourceHash: "hash_1",
    revision: 5,
    status: "active",
    view: { revision: 5, status: "active", state: {}, actions: [] },
    manifest: { name: "Hearts" },
    ...over,
  };
}

beforeEach(() => {
  state = { byScope: {}, activeScope: null };
  snapshotChat = { id: CHAT_ID };
  snapshotBranch = { id: BRANCH_ID };
  mobileOverride = false;
  detachResult = null;
  modalProps = {};
  setupOnReady = null;
  for (const m of Object.values(storeMocks)) m.mockClear();
});

// ─── 1. Visibility gate ────────────────────────────────────────────────────
describe("ExperienceLauncher — visibility gate", () => {
  it("returns null with no active scope", () => {
    snapshotChat = null;
    const { container } = render(<ExperienceLauncher />);
    expect(container.firstElementChild).toBeNull();
  });

  it("returns null while config is unloaded", () => {
    setScopeState(SCOPE_KEY, { config: null });
    const { container } = render(<ExperienceLauncher />);
    expect(container.firstElementChild).toBeNull();
  });

  it("returns null when disabled", () => {
    setScopeState(SCOPE_KEY, { config: makeConfig({ enabled: false }) });
    const { container } = render(<ExperienceLauncher />);
    expect(container.firstElementChild).toBeNull();
  });

  it("returns null when launcher hidden", () => {
    setScopeState(SCOPE_KEY, { config: makeConfig({ launcherVisible: false }) });
    const { container } = render(<ExperienceLauncher />);
    expect(container.firstElementChild).toBeNull();
  });

  it("returns null with no script", () => {
    setScopeState(SCOPE_KEY, { config: makeConfig({ scriptId: null }) });
    const { container } = render(<ExperienceLauncher />);
    expect(container.firstElementChild).toBeNull();
  });

  it("returns null with no visual", () => {
    setScopeState(SCOPE_KEY, { config: makeConfig({ visualId: null }) });
    const { container } = render(<ExperienceLauncher />);
    expect(container.firstElementChild).toBeNull();
  });

  it("renders the pill when fully configured with no session", () => {
    setScopeState(SCOPE_KEY, { config: makeConfig() });
    const { getByTestId } = render(<ExperienceLauncher />);
    expect(getByTestId("experience-launcher-pill")).toBeTruthy();
  });
});

// ─── 2. setScope hydration ──────────────────────────────────────────────────
describe("ExperienceLauncher — scope hydration", () => {
  it("calls setScope with the exact chat/branch id", () => {
    setScopeState(SCOPE_KEY, { config: makeConfig() });
    render(<ExperienceLauncher />);
    expect(storeMocks.setScope).toHaveBeenCalledWith(CHAT_ID, BRANCH_ID);
  });

  it("switching branch re-hydrates the new scope (A→B isolation)", () => {
    setScopeState(SCOPE_KEY, { config: makeConfig() });
    const { rerender } = render(<ExperienceLauncher />);
    expect(storeMocks.setScope).toHaveBeenLastCalledWith(CHAT_ID, BRANCH_ID);
    snapshotBranch = { id: "branch_2" };
    act(() => {
      rerender(<ExperienceLauncher />);
    });
    expect(storeMocks.setScope).toHaveBeenLastCalledWith(CHAT_ID, "branch_2");
  });
});

// ─── 3. Start / Resume / Close ──────────────────────────────────────────────
describe("ExperienceLauncher — start, resume, close", () => {
  it("no session: Start opens the SetupModal", () => {
    setScopeState(SCOPE_KEY, { config: makeConfig() });
    const { getByTestId, queryByTestId } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("experience-launcher-pill"));
    fireEvent.click(getByTestId("experience-launcher-primary"));
    expect(getByTestId("setup-modal")).toBeTruthy();
    void queryByTestId;
  });

  it("SetupModal onReady opens the visual modal (store.openModal)", () => {
    setScopeState(SCOPE_KEY, { config: makeConfig() });
    const { getByTestId } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("experience-launcher-pill"));
    fireEvent.click(getByTestId("experience-launcher-primary"));
    fireEvent.click(getByTestId("setup-ready"));
    expect(storeMocks.openModal).toHaveBeenCalledTimes(1);
    // Setup closed after ready.
    expect(() => getByTestId("setup-modal")).toThrow();
  });

  it("active session: Resume opens the same session", () => {
    setScopeState(SCOPE_KEY, { config: makeConfig(), session: makeSession() });
    const { getByTestId } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("experience-launcher-pill"));
    fireEvent.click(getByTestId("experience-launcher-primary"));
    expect(storeMocks.openModal).toHaveBeenCalledTimes(1);
    expect(storeMocks.setDetached).toHaveBeenCalledWith(false);
  });

  it("close modal NEVER calls endSession", () => {
    setScopeState(SCOPE_KEY, { config: makeConfig(), session: makeSession(), modalOpen: true });
    const { getByTestId } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("modal-close"));
    expect(storeMocks.closeModal).toHaveBeenCalledTimes(1);
    expect(storeMocks.endSession).not.toHaveBeenCalled();
  });
});

// ─── 4. Pinned visual source ────────────────────────────────────────────────
describe("ExperienceLauncher — pinned visual source", () => {
  it("passes the session's pinned visualSource to the modal (not config.visualId)", () => {
    setScopeState(SCOPE_KEY, {
      config: makeConfig({ visualId: "vis_DIFFERENT" }),
      session: makeSession({ visualSource: "<div>PINNED</div>" }),
      modalOpen: true,
    });
    const { getByTestId } = render(<ExperienceLauncher />);
    expect(getByTestId("modal-visual-source").textContent).toBe("<div>PINNED</div>");
  });

  it("surfaces incompatible state when session visualSource is null", () => {
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession({ visualSource: null, visualSourceHash: null }),
    });
    const { getByTestId, queryByTestId } = render(<ExperienceLauncher />);
    // The pill renders but shows the incompatible label; no modal is mounted.
    expect(getByTestId("experience-launcher-pill").textContent).toContain("experience_launcher_incompatible");
    expect(queryByTestId("experience-modal")).toBeNull();
  });
});

// ─── 5. Visual action contract ──────────────────────────────────────────────
describe("ExperienceLauncher — visual action contract", () => {
  it("strips requestId/expectedRevision before store.submitAction", async () => {
    setScopeState(SCOPE_KEY, { config: makeConfig(), session: makeSession({ revision: 5 }), modalOpen: true });
    storeMocks.submitAction.mockResolvedValue({
      revision: 6,
      status: "active",
      view: { revision: 6, status: "active", state: {}, actions: [] },
    });
    render(<ExperienceLauncher />);
    const onAction = modalProps.onAction as (a: { requestId: string; expectedRevision: number; type: string; participantId?: string; payload?: unknown }) => Promise<unknown>;
    expect(onAction).toBeTruthy();
    const outcome = await onAction({ requestId: "visual-rid", expectedRevision: 5, type: "move", participantId: "p1", payload: { x: 1 } });
    // The store received the INTENT without requestId/expectedRevision.
    expect(storeMocks.submitAction).toHaveBeenCalledTimes(1);
    const intent = storeMocks.submitAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(intent.requestId).toBeUndefined();
    expect(intent.expectedRevision).toBeUndefined();
    expect(intent.type).toBe("move");
    expect(intent.participantId).toBe("p1");
    // Success outcome carries the committed revision/status/view.
    expect(outcome).toMatchObject({ ok: true, revision: 6, status: "active" });
  });

  it("null store response maps fail-closed to a valid bridge error", async () => {
    setScopeState(SCOPE_KEY, { config: makeConfig(), session: makeSession({ revision: 9 }), modalOpen: true });
    storeMocks.submitAction.mockResolvedValue(null);
    render(<ExperienceLauncher />);
    const onAction = modalProps.onAction as (a: { requestId: string; expectedRevision: number; type: string }) => Promise<unknown>;
    const outcome = await onAction({ requestId: "rid", expectedRevision: 9, type: "move" });
    expect(outcome).toMatchObject({ ok: false });
    expect(["stale_revision", "invalid_action"]).toContain((outcome as { code: string }).code);
  });
});

// ─── 7b. Timer pending phase (fix step 2d) ──────────────────────────────────
describe("ExperienceLauncher — timer pending phase", () => {
  it("shows the timer-wait phase (not effect) when only a timer is live, and never runs it", () => {
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession(),
      effects: [{ id: "eff_t", kind: "timer", status: "pending" }],
      modalOpen: true,
    });
    render(<ExperienceLauncher />);
    expect(modalProps.pendingPhase).toBe("timer");
    expect(storeMocks.runEffect).not.toHaveBeenCalled();
  });

  it("model work outranks the timer wait when both are live", () => {
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession(),
      effects: [
        { id: "eff_t", kind: "timer", status: "pending" },
        { id: "eff_m", kind: "model", status: "pending" },
      ],
      modalOpen: true,
    });
    render(<ExperienceLauncher />);
    expect(modalProps.pendingPhase).toBe("effect");
  });

  it("a running timer also shows the timer-wait phase", () => {
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession(),
      effects: [{ id: "eff_t", kind: "timer", status: "running" }],
      modalOpen: true,
    });
    render(<ExperienceLauncher />);
    expect(modalProps.pendingPhase).toBe("timer");
  });

  it("a terminal timer shows the idle phase", () => {
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession(),
      effects: [{ id: "eff_t", kind: "timer", status: "succeeded" }],
      modalOpen: true,
    });
    render(<ExperienceLauncher />);
    expect(modalProps.pendingPhase).toBe("idle");
  });
});

// ─── 7. Pending effect runner ───────────────────────────────────────────────
describe("ExperienceLauncher — durable pending effects", () => {
  it("runs a pending effect once through store.runEffect while modal open", async () => {
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession(),
      effects: [{ id: "eff_1", kind: "model", status: "pending" }],
      modalOpen: true,
    });
    storeMocks.runEffect.mockResolvedValue({ effect: { id: "eff_1", status: "succeeded" }, delivered: true });
    render(<ExperienceLauncher />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(storeMocks.runEffect).toHaveBeenCalledTimes(1);
    expect(storeMocks.runEffect.mock.calls[0]![0]).toBe("eff_1");
  });

  it("never auto-runs a running/unknown/failed effect", () => {
    for (const status of ["running", "unknown", "failed", "succeeded", "cancelled"]) {
      storeMocks.runEffect.mockClear();
      setScopeState(SCOPE_KEY, {
        config: makeConfig(),
        session: makeSession(),
        effects: [{ id: "eff_x", status }],
        modalOpen: true,
      });
      render(<ExperienceLauncher />);
      expect(storeMocks.runEffect).not.toHaveBeenCalled();
      // Cleanup between iterations: unmount by re-rendering fresh next loop.
    }
  });

  it("does not run effects while detached (the detached host owns them)", () => {
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession(),
      effects: [{ id: "eff_1", kind: "model", status: "pending" }],
      modalOpen: false,
      detached: true,
    });
    render(<ExperienceLauncher />);
    expect(storeMocks.runEffect).not.toHaveBeenCalled();
  });
});

// ─── LB-10 (Option C): runner lifetime = chat page ──────────────────────────
describe("ExperienceLauncher — LB-10 Option C: effect runner lifetime", () => {
  it("drains a pending model effect with the modal CLOSED (chat page open)", async () => {
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession(),
      effects: [{ id: "eff_1", kind: "model", status: "pending" }],
      modalOpen: false,
    });
    render(<ExperienceLauncher />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(storeMocks.runEffect).toHaveBeenCalledTimes(1);
    expect(storeMocks.runEffect.mock.calls[0]![0]).toBe("eff_1");
  });

  it("closing the modal does not freeze the queue — the next pending row still runs", async () => {
    storeMocks.runEffect.mockResolvedValue({ effect: { id: "eff_1", status: "succeeded" }, delivered: true });
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession(),
      effects: [{ id: "eff_1", kind: "model", status: "pending" }],
      modalOpen: true,
    });
    const { rerender } = render(<ExperienceLauncher />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(storeMocks.runEffect).toHaveBeenCalledTimes(1);
    // The user closes the modal while a SECOND durable row is pending —
    // under Option C the queue must keep draining (chat page still open).
    act(() => {
      setScopeState(SCOPE_KEY, {
        effects: [
          { id: "eff_1", kind: "model", status: "succeeded" },
          { id: "eff_2", kind: "model", status: "pending" },
        ],
        modalOpen: false,
      });
      rerender(<ExperienceLauncher />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(storeMocks.runEffect).toHaveBeenCalledTimes(2);
    expect(storeMocks.runEffect.mock.calls[1]![0]).toBe("eff_2");
  });

  it("leaving the chat (unmount) aborts the in-flight run and starts nothing else", async () => {
    let capturedSignal: AbortSignal | undefined;
    storeMocks.runEffect.mockImplementation((_effectId: string, signal?: AbortSignal) => {
      capturedSignal = signal;
      return new Promise(() => {});
    });
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession(),
      effects: [
        { id: "eff_1", kind: "model", status: "pending" },
        { id: "eff_2", kind: "model", status: "pending" },
      ],
      modalOpen: true,
    });
    const { unmount } = render(<ExperienceLauncher />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // One at a time: eff_1 in flight, eff_2 blocked.
    expect(storeMocks.runEffect).toHaveBeenCalledTimes(1);
    unmount();
    // The in-flight run is aborted; durable eff_2 stays frozen client-side
    // (still pending server-side — resumed when the chat page is reopened).
    expect(capturedSignal?.aborted).toBe(true);
    expect(storeMocks.runEffect).toHaveBeenCalledTimes(1);
  });

  it("timer resync stays active with the modal closed (live timer)", async () => {
    storeMocks.rehydrate.mockClear();
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession(),
      effects: [{ id: "eff_t", kind: "timer", status: "pending" }],
      modalOpen: false,
    });
    render(<ExperienceLauncher />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, TIMER_RESYNC_INTERVAL_MS + 150));
    });
    expect(storeMocks.rehydrate.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Lobby pos 1: effect diagnostics + retry in the trusted modal chrome ────
describe("ExperienceLauncher — effect diagnostics + retry", () => {
  it("a failed row renders in the modal chrome; retry hits store.retryEffect and the runner drains the re-pending row", async () => {
    storeMocks.retryEffect.mockClear();
    storeMocks.runEffect.mockClear();
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession(),
      effects: [{ id: "eff_1", kind: "model", status: "failed" }],
      modalOpen: true,
    });
    const { getByTestId } = render(<ExperienceLauncher />);

    // The trusted-chrome diagnostics render INSIDE the modal surface (the
    // real component tree, not the visual) with the failed status + retry.
    expect(getByTestId("modal-effect-diagnostics")).toBeTruthy();
    expect(getByTestId("experience-effect-row-eff_1").textContent).toContain("experience_effect_status_failed");

    // Retry click → the launcher callback routes to the store action.
    await act(async () => {
      fireEvent.click(getByTestId("experience-effect-retry-eff_1"));
    });
    expect(storeMocks.retryEffect).toHaveBeenCalledTimes(1);
    expect(storeMocks.retryEffect.mock.calls[0]![0]).toBe("eff_1");

    // The store resync flips the row back to pending; the chat-page runner
    // (LB-10 Option C) picks it up from the authoritative effects list.
    act(() => {
      setScopeState(SCOPE_KEY, {
        effects: [{ id: "eff_1", kind: "model", status: "pending" }],
      });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(storeMocks.runEffect).toHaveBeenCalledTimes(1);
    expect(storeMocks.runEffect.mock.calls[0]![0]).toBe("eff_1");
  });

  it("no retryable rows → no diagnostics surface in the modal", () => {
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession(),
      effects: [{ id: "eff_1", kind: "model", status: "succeeded" }],
      modalOpen: true,
    });
    const { queryByTestId } = render(<ExperienceLauncher />);
    expect(queryByTestId("modal-effect-diagnostics")).toBeNull();
  });
});

// ─── 8. Finish confirmation ─────────────────────────────────────────────────
describe("ExperienceLauncher — finish", () => {
  it("finish with a non-null server result calls endSession then closeModal", async () => {
    setScopeState(SCOPE_KEY, { config: makeConfig(), session: makeSession(), modalOpen: true });
    // Success: the store returns a non-null terminal queued attachment.
    storeMocks.endSession.mockResolvedValue({
      id: "att_final",
      queueRevision: 5,
      sessionRevision: 5,
      publicReport: { title: "Hearts", events: [] },
    });
    render(<ExperienceLauncher />);
    // The modal's onFinishExperience (forwarded from the trusted chrome) runs
    // endSession + closeModal. The CONFIRMATION step itself lives in the modal
    // chrome (tested by ExperienceModal); here we verify the launcher wires the
    // privileged op through the store.
    await act(async () => {
      fireEvent.click(document.querySelector("[data-testid='modal-finish']")!);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(storeMocks.endSession).toHaveBeenCalledTimes(1);
    expect(storeMocks.closeModal).toHaveBeenCalled();
  });

  it("finish with a null server result keeps the modal open (no closeModal)", async () => {
    setScopeState(SCOPE_KEY, { config: makeConfig(), session: makeSession(), modalOpen: true });
    // Server failure: the store returns null after its own resync.
    storeMocks.endSession.mockResolvedValue(null);
    render(<ExperienceLauncher />);
    await act(async () => {
      fireEvent.click(document.querySelector("[data-testid='modal-finish']")!);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(storeMocks.endSession).toHaveBeenCalledTimes(1);
    // Modal/session surface stays open so the user can see the error + retry.
    expect(storeMocks.closeModal).not.toHaveBeenCalled();
  });

  it("finish rejection is handled and keeps the modal open", async () => {
    setScopeState(SCOPE_KEY, { config: makeConfig(), session: makeSession(), modalOpen: true });
    storeMocks.endSession.mockRejectedValue(new Error("session disappeared"));
    const warn = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warn;
    try {
      render(<ExperienceLauncher />);
      await act(async () => {
        fireEvent.click(document.querySelector("[data-testid='modal-finish']")!);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(storeMocks.endSession).toHaveBeenCalledTimes(1);
      expect(storeMocks.closeModal).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });
});

// ─── 9. Detach ──────────────────────────────────────────────────────────────
describe("ExperienceLauncher — detach", () => {
  it("blocked popup shows a localized error and stays in modal", () => {
    detachResult = null;
    setScopeState(SCOPE_KEY, { config: makeConfig(), session: makeSession(), modalOpen: true });
    const { getByTestId } = render(<ExperienceLauncher />);
    fireEvent.click(document.querySelector("[data-testid='modal-detach']")!);
    expect(storeMocks.closeModal).not.toHaveBeenCalled();
    expect(storeMocks.setDetached).not.toHaveBeenCalledWith(true);
    // The popup-blocked error is shown as a visible notice.
    expect(getByTestId("experience-popup-error").textContent).toContain("experience_popup_blocked");
  });

  it("successful detach closes modal and marks detached", () => {
    detachResult = {} as Window;
    setScopeState(SCOPE_KEY, { config: makeConfig(), session: makeSession(), modalOpen: true });
    render(<ExperienceLauncher />);
    fireEvent.click(document.querySelector("[data-testid='modal-detach']")!);
    expect(storeMocks.closeModal).toHaveBeenCalledTimes(1);
    expect(storeMocks.setDetached).toHaveBeenCalledWith(true);
  });
});

// ─── 10. Branch switch ──────────────────────────────────────────────────────
describe("ExperienceLauncher — branch switch", () => {
  it("renders the branch's own config/session after switching", () => {
    setScopeState(SCOPE_KEY, { config: makeConfig(), session: makeSession({ sessionId: "sess_A" }) });
    const BRANCH2 = JSON.stringify([CHAT_ID, "branch_2"]);
    setScopeState(BRANCH2, { config: makeConfig(), session: makeSession({ sessionId: "sess_B" }) });
    const { getByTestId, rerender } = render(<ExperienceLauncher />);
    // Open the modal on branch 1.
    fireEvent.click(getByTestId("experience-launcher-pill"));
    fireEvent.click(getByTestId("experience-launcher-primary"));
    expect(storeMocks.openModal).toHaveBeenCalledTimes(1);
    // Switch to branch 2 — local surfaces reset.
    snapshotBranch = { id: "branch_2" };
    act(() => {
      rerender(<ExperienceLauncher />);
    });
    // setScope called for the new branch.
    expect(storeMocks.setScope).toHaveBeenCalledWith(CHAT_ID, "branch_2");
  });
});

// ─── 11. Desktop Popover / mobile BottomSheet ───────────────────────────────
describe("ExperienceLauncher — responsive pill", () => {
  it("opens a popover content on desktop", () => {
    setScopeState(SCOPE_KEY, { config: makeConfig() });
    const { getByTestId } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("experience-launcher-pill"));
    // The primary action button is inside the popover content.
    expect(getByTestId("experience-launcher-primary")).toBeTruthy();
  });

  it("uses BottomSheet on mobile", () => {
    mobileOverride = true;
    setScopeState(SCOPE_KEY, { config: makeConfig() });
    const { getByTestId } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("experience-launcher-pill"));
    expect(getByTestId("bottom-sheet")).toBeTruthy();
  });
});

// ─── Defect fixes (IR-73B follow-up) ───────────────────────────────────────
describe("ExperienceLauncher — defect #1: incompatible session omits primary action", () => {
  it("renders no primary action button for an incompatible session", () => {
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession({ visualSource: null, visualSourceHash: null }),
    });
    const { getByTestId, queryByTestId } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("experience-launcher-pill"));
    // The primary action button is omitted — Start/Resume are both impossible.
    expect(queryByTestId("experience-launcher-primary")).toBeNull();
  });

  it("never calls Start or Resume for an incompatible session", () => {
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession({ visualSource: null, visualSourceHash: null }),
    });
    const { getByTestId } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("experience-launcher-pill"));
    // No setup modal, no openModal — nothing fires.
    expect(storeMocks.openModal).not.toHaveBeenCalled();
    expect(storeMocks.setScope).toHaveBeenCalledTimes(1); // only the scope hydrate
  });
});

describe("ExperienceLauncher — defect #2: config change resets local UI + invisible closes modal", () => {
  it("resets setup popover when the config surface changes", () => {
    setScopeState(SCOPE_KEY, { config: makeConfig() });
    const { getByTestId, rerender } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("experience-launcher-pill"));
    expect(getByTestId("experience-launcher-primary")).toBeTruthy();
    // Change the config surface (toggle scriptId) — local UI resets.
    setScopeState(SCOPE_KEY, { config: makeConfig({ scriptId: "script_OTHER" }) });
    act(() => {
      rerender(<ExperienceLauncher />);
    });
    // The popover was reset (closed), so the primary button is no longer in the DOM.
    expect(document.querySelector("[data-testid='experience-launcher-primary']")).toBeNull();
  });

  it("closes the local modal non-destructively when config becomes invisible", () => {
    setScopeState(SCOPE_KEY, { config: makeConfig(), session: makeSession(), modalOpen: true });
    const { rerender } = render(<ExperienceLauncher />);
    expect(storeMocks.closeModal).not.toHaveBeenCalled();
    // Config becomes invisible (launcherVisible=false).
    setScopeState(SCOPE_KEY, { config: makeConfig({ launcherVisible: false }), session: makeSession(), modalOpen: true });
    act(() => {
      rerender(<ExperienceLauncher />);
    });
    // Modal closed via store.closeModal only (never endSession).
    expect(storeMocks.closeModal).toHaveBeenCalledTimes(1);
    expect(storeMocks.endSession).not.toHaveBeenCalled();
  });

  it("does not own/running effects while config is invisible", () => {
    setScopeState(SCOPE_KEY, {
      config: makeConfig({ launcherVisible: false }),
      session: makeSession(),
      effects: [{ id: "eff_1", kind: "model", status: "pending" }],
      modalOpen: true,
    });
    render(<ExperienceLauncher />);
    expect(storeMocks.runEffect).not.toHaveBeenCalled();
  });
});

describe("ExperienceLauncher — defect #3: popup error clears on close/resume", () => {
  it("closing the modal clears the popup-blocked error", () => {
    detachResult = null;
    setScopeState(SCOPE_KEY, { config: makeConfig(), session: makeSession(), modalOpen: true });
    const { getByTestId, queryByTestId, rerender } = render(<ExperienceLauncher />);
    // Trigger a blocked popup.
    fireEvent.click(document.querySelector("[data-testid='modal-detach']")!);
    expect(getByTestId("experience-popup-error")).toBeTruthy();
    // Close the modal — the popup error clears.
    setScopeState(SCOPE_KEY, { config: makeConfig(), session: makeSession(), modalOpen: false });
    act(() => {
      rerender(<ExperienceLauncher />);
    });
    expect(queryByTestId("experience-popup-error")).toBeNull();
  });
});

// ─── IR-73C: report controls — no silent growth integration boundary ──────
// The frozen queued snapshot must NEVER grow locally. All values and mutations
// come from the store (server-authoritative). The t mock appends opts JSON so
// server-supplied counts / revisions are verifiable in the DOM.
describe("ExperienceLauncher — report controls (IR-73C)", () => {
  function makeAttachment(events: number, queueRev: number, sessionRev = 7) {
    return {
      queueRevision: queueRev,
      sessionRevision: sessionRev,
      publicReport: {
        title: "Hearts",
        events: Array.from({ length: events }, (_, i) => ({ type: "public", detail: `e${i}` })),
      },
    };
  }

  it("no auto-queue: a pending-count change never calls queueReport and keeps the frozen N/Q", () => {
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession(),
      queuedAttachment: makeAttachment(2, 5),
      reportStatus: { reportFrontier: 6, pendingPublicEventCount: 1 },
      modalOpen: false,
    });
    const { getByTestId } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("experience-launcher-pill"));
    // Frozen shows N=2, queueRev Q=5 from server props.
    expect(getByTestId("experience-report-frozen").textContent).toContain('"n":2');
    expect(getByTestId("experience-report-queue-rev").textContent).toContain('"n":5');
    // A rehydrate changes ONLY pendingPublicEventCount.
    setScopeState(SCOPE_KEY, {
      ...scopeState(SCOPE_KEY),
      reportStatus: { reportFrontier: 6, pendingPublicEventCount: 3 },
    });
    // No queue endpoint call occurred automatically.
    expect(storeMocks.queueReport).not.toHaveBeenCalled();
  });

  it("explicit Add later calls queueReport exactly once", async () => {
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession(),
      queuedAttachment: makeAttachment(2, 5),
      reportStatus: { reportFrontier: 6, pendingPublicEventCount: 1 },
      modalOpen: false,
    });
    storeMocks.queueReport.mockResolvedValue(makeAttachment(2, 5));
    const { getByTestId } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("experience-launcher-pill"));
    await act(async () => {
      fireEvent.click(getByTestId("experience-report-action"));
    });
    expect(storeMocks.queueReport).toHaveBeenCalledTimes(1);
  });

  it("only after the server supplies a new attachment does UI show N+later and Q+1", async () => {
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession(),
      queuedAttachment: makeAttachment(2, 5),
      reportStatus: { reportFrontier: 6, pendingPublicEventCount: 3 },
      modalOpen: false,
    });
    // The queue operation returns the new attachment AND the store rehydrate
    // supplies it — simulate both in the mock implementation.
    const laterAttachment = makeAttachment(5, 6);
    storeMocks.queueReport.mockImplementation(async () => {
      setScopeState(SCOPE_KEY, {
        ...scopeState(SCOPE_KEY),
        queuedAttachment: laterAttachment,
        reportStatus: { reportFrontier: 6, pendingPublicEventCount: 0 },
      });
      return laterAttachment;
    });
    const { getByTestId } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("experience-launcher-pill"));
    // Before: frozen N=2, queueRev Q=5.
    expect(getByTestId("experience-report-frozen").textContent).toContain('"n":2');
    expect(getByTestId("experience-report-queue-rev").textContent).toContain('"n":5');
    await act(async () => {
      fireEvent.click(getByTestId("experience-report-action"));
    });
    // After: frozen N+later=5, queueRev Q+1=6 — supplied ONLY by the server
    // response (no local arithmetic).
    expect(getByTestId("experience-report-frozen").textContent).toContain('"n":5');
    expect(getByTestId("experience-report-queue-rev").textContent).toContain('"n":6');
  });

  it("Queue path with no existing attachment", async () => {
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession(),
      queuedAttachment: null,
      reportStatus: { reportFrontier: 4, pendingPublicEventCount: 2 },
      modalOpen: false,
    });
    storeMocks.queueReport.mockResolvedValue(makeAttachment(2, 0));
    const { getByTestId } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("experience-launcher-pill"));
    const btn = getByTestId("experience-report-action") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute("data-action")).toBe("queue");
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(storeMocks.queueReport).toHaveBeenCalledTimes(1);
  });

  it("duplicate-click suppression: a second click while pending does not call queueReport again", async () => {
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession(),
      queuedAttachment: null,
      reportStatus: { reportFrontier: 4, pendingPublicEventCount: 2 },
      modalOpen: false,
    });
    let resolveFn: (() => void) | null = null;
    storeMocks.queueReport.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFn = resolve as () => void;
        }),
    );
    const { getByTestId } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("experience-launcher-pill"));
    act(() => {
      fireEvent.click(getByTestId("experience-report-action"));
    });
    act(() => {
      fireEvent.click(getByTestId("experience-report-action"));
    });
    expect(storeMocks.queueReport).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveFn!();
      await new Promise((r) => setTimeout(r, 0));
    });
  });

  it("server failure leaves old frozen values (no optimistic bump)", async () => {
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession(),
      queuedAttachment: makeAttachment(2, 5),
      reportStatus: { reportFrontier: 6, pendingPublicEventCount: 1 },
      modalOpen: false,
    });
    // A null store result = server failure (the launcher rejects it).
    storeMocks.queueReport.mockResolvedValue(null);
    const { getByTestId } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("experience-launcher-pill"));
    await act(async () => {
      fireEvent.click(getByTestId("experience-report-action"));
    });
    // The frozen count is STILL 2 (the old server value) — no optimistic bump.
    expect(getByTestId("experience-report-frozen").textContent).toContain('"n":2');
    // A fail-closed error is shown.
    expect(getByTestId("experience-report-error").textContent).toContain("experience_report_action_error");
  });

  it("no action when pending === 0 (disabled button, no call)", () => {
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession(),
      queuedAttachment: makeAttachment(2, 5),
      reportStatus: { reportFrontier: 5, pendingPublicEventCount: 0 },
      modalOpen: false,
    });
    const { getByTestId } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("experience-launcher-pill"));
    const btn = getByTestId("experience-report-action") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(storeMocks.queueReport).not.toHaveBeenCalled();
  });

  it("exact scope/branch isolation: branch B's controls do not see branch A's attachment", () => {
    const BRANCH2 = JSON.stringify([CHAT_ID, "branch_2"]);
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession(),
      queuedAttachment: makeAttachment(3, 8),
      reportStatus: { reportFrontier: 8, pendingPublicEventCount: 0 },
      modalOpen: false,
    });
    setScopeState(BRANCH2, {
      config: makeConfig(),
      session: makeSession({ sessionId: "sess_B" }),
      queuedAttachment: null,
      reportStatus: { reportFrontier: 1, pendingPublicEventCount: 2 },
      modalOpen: false,
    });
    const { getByTestId, rerender } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("experience-launcher-pill"));
    // Branch 1: up-to-date (attachment, no pending).
    expect((getByTestId("experience-report-action") as HTMLButtonElement).getAttribute("data-action")).toBe("upToDate");
    // Switch to branch 2.
    snapshotBranch = { id: "branch_2" };
    act(() => {
      rerender(<ExperienceLauncher />);
    });
    // The branch switch reset local UI (popover closed) — reopen it.
    fireEvent.click(getByTestId("experience-launcher-pill"));
    // Branch 2 has NO attachment + pending > 0 → queue (not branch 1's data).
    expect((getByTestId("experience-report-action") as HTMLButtonElement).getAttribute("data-action")).toBe("queue");
  });

  it("report controls are NOT rendered in the popover while the modal is open (no duplicate)", () => {
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession(),
      queuedAttachment: makeAttachment(2, 5),
      reportStatus: { reportFrontier: 6, pendingPublicEventCount: 1 },
      modalOpen: true,
    });
    const { queryByTestId } = render(<ExperienceLauncher />);
    // The popover body does NOT render report controls while modal is open.
    expect(queryByTestId("experience-report-controls")).toBeNull();
  });

  it("config-surface change clears the local queue error without an automatic queue call", async () => {
    setScopeState(SCOPE_KEY, {
      config: makeConfig(),
      session: makeSession(),
      queuedAttachment: makeAttachment(2, 5),
      reportStatus: { reportFrontier: 6, pendingPublicEventCount: 1 },
      modalOpen: false,
    });
    // A failing queue action leaves a local fail-closed error.
    storeMocks.queueReport.mockResolvedValue(null);
    const { getByTestId, queryByTestId, rerender } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("experience-launcher-pill"));
    await act(async () => {
      fireEvent.click(getByTestId("experience-report-action"));
    });
    // The error is shown.
    expect(getByTestId("experience-report-error").textContent).toContain("experience_report_action_error");
    expect(storeMocks.queueReport).toHaveBeenCalledTimes(1);
    // Change the config surface (toggle scriptId) — the surfaceKey changes so
    // the ReportControls remounts, clearing its local error. The launcher's
    // surfaceKey effect also closes the popover.
    setScopeState(SCOPE_KEY, { ...scopeState(SCOPE_KEY), config: makeConfig({ scriptId: "script_OTHER" }) });
    act(() => {
      rerender(<ExperienceLauncher />);
    });
    // No automatic queue call occurred during the config change.
    expect(storeMocks.queueReport).toHaveBeenCalledTimes(1);
    // Reopen the popover — the report controls are freshly mounted with no error.
    fireEvent.click(getByTestId("experience-launcher-pill"));
    expect(queryByTestId("experience-report-error")).toBeNull();
    // Still only the one manual call — no auto-queue after the remount.
    expect(storeMocks.queueReport).toHaveBeenCalledTimes(1);
  });
});

// ─── 12. Endgame restart pair (lobby Б3) + in-session settings (Б4) ────────
describe("ExperienceLauncher — endgame restart pair (Б3)", () => {
  it("completed session: the restart pair replaces the primary action and the status reads finished", async () => {
    setScopeState(SCOPE_KEY, { config: makeConfig(), session: makeSession({ status: "completed" }) });
    const { getByTestId, queryByTestId } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("experience-launcher-pill"));
    // The primary Start/Resume action is replaced by the restart pair.
    expect(queryByTestId("experience-launcher-primary")).toBeNull();
    expect(getByTestId("experience-restart-again")).toBeTruthy();
    expect(getByTestId("experience-restart-settings")).toBeTruthy();
    // The status line reads the finished label, not "Session active".
    expect(document.body.textContent).toContain("experience_launcher_finished");

    // Play again is the one-shot restart: empty body via the store, then the
    // modal opens on the NEW match only on a non-null result.
    storeMocks.restartSession.mockResolvedValue({ sessionId: "sess_new" });
    await act(async () => {
      fireEvent.click(getByTestId("experience-restart-again"));
    });
    expect(storeMocks.restartSession).toHaveBeenCalledTimes(1);
    expect(storeMocks.openModal).toHaveBeenCalledTimes(1);
    // No setup modal in the one-shot path.
    expect(queryByTestId("setup-modal")).toBeNull();
  });

  it("Play again with a NULL restart result does not open the modal (server failure, store surfaces the error)", async () => {
    setScopeState(SCOPE_KEY, { config: makeConfig(), session: makeSession({ status: "completed" }) });
    const { getByTestId } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("experience-launcher-pill"));
    storeMocks.restartSession.mockResolvedValue(null);
    await act(async () => {
      fireEvent.click(getByTestId("experience-restart-again"));
    });
    expect(storeMocks.restartSession).toHaveBeenCalledTimes(1);
    expect(storeMocks.openModal).not.toHaveBeenCalled();
  });

  it("Change settings opens the setup modal WITHOUT restarting", () => {
    setScopeState(SCOPE_KEY, { config: makeConfig(), session: makeSession({ status: "completed" }) });
    const { getByTestId } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("experience-launcher-pill"));
    fireEvent.click(getByTestId("experience-restart-settings"));
    expect(getByTestId("setup-modal")).toBeTruthy();
    expect(storeMocks.restartSession).not.toHaveBeenCalled();
    expect(storeMocks.openModal).not.toHaveBeenCalled();
  });

  it("Change settings opens the setup modal PREFILLED (restartSource = the finished session, LB-5)", () => {
    setScopeState(SCOPE_KEY, { config: makeConfig(), session: makeSession({ status: "completed" }) });
    const { getByTestId } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("experience-launcher-pill"));
    fireEvent.click(getByTestId("experience-restart-settings"));
    expect(getByTestId("setup-restart-src")).toBeTruthy();
  });

  it("interrupted session behaves like completed: both restart buttons, no primary", () => {
    setScopeState(SCOPE_KEY, { config: makeConfig(), session: makeSession({ status: "interrupted" }) });
    const { getByTestId, queryByTestId } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("experience-launcher-pill"));
    expect(queryByTestId("experience-launcher-primary")).toBeNull();
    expect(getByTestId("experience-restart-again")).toBeTruthy();
    expect(getByTestId("experience-restart-settings")).toBeTruthy();
  });
});

describe("ExperienceLauncher — in-session settings entry (Б4)", () => {
  it("ACTIVE session: invoking the modal's settings entry closes the session modal and opens the setup modal", () => {
    setScopeState(SCOPE_KEY, { config: makeConfig(), session: makeSession(), modalOpen: true });
    const { getByTestId, queryByTestId } = render(<ExperienceLauncher />);
    expect(getByTestId("modal-session-settings")).toBeTruthy();
    fireEvent.click(getByTestId("modal-session-settings"));
    expect(storeMocks.closeModal).toHaveBeenCalledTimes(1);
    // The setup modal is now the only open surface.
    expect(getByTestId("setup-modal")).toBeTruthy();
    expect(queryByTestId("experience-modal")).toBeNull();
    expect(storeMocks.restartSession).not.toHaveBeenCalled();
  });

  it("the Б4 settings entry ALSO prefill-opens the setup modal (restartSource = the active session, LB-5)", () => {
    setScopeState(SCOPE_KEY, { config: makeConfig(), session: makeSession(), modalOpen: true });
    const { getByTestId } = render(<ExperienceLauncher />);
    fireEvent.click(getByTestId("modal-session-settings"));
    expect(getByTestId("setup-restart-src")).toBeTruthy();
  });

  it("TERMINAL session: the settings entry is NOT wired into the modal (the popover restart pair owns the endgame)", () => {
    setScopeState(SCOPE_KEY, { config: makeConfig(), session: makeSession({ status: "completed" }), modalOpen: true });
    const { queryByTestId } = render(<ExperienceLauncher />);
    expect(queryByTestId("modal-session-settings")).toBeNull();
    expect(modalProps.onOpenSessionSettings).toBeUndefined();
  });
});
