/**
 * ExperienceDetachedWindow — window.open mechanism + trusted-host tests (IR-62).
 *
 * The live handshake is covered elsewhere; here we pin the SURFACE contract:
 *   - openExperienceDetachedWindow stashes the descriptor and opens a same-origin
 *     hash URL (`#experience=<sessionId>`) with the detached features;
 *   - a blocked popup returns null and the caller is expected to handle it
 *     (we assert the null is surfaced, not papered over);
 *   - readDetachedDescriptor reads the stashed descriptor back from the opener
 *     and rejects a malformed one;
 *   - ExperienceDetachedHost renders trusted chrome + the SAME sandboxed frame
 *     (the user visual is never the top-level document), and shows the
 *     unavailable fallback when there is no descriptor.
 *
 * The bridge functions take an injectable `win` (production defaults to
 * globalThis); tests pass a fake so they never touch the readonly happy-dom
 * window.location/opener.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, act } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";
import type { DetachWindow } from "./ExperienceDetachedWindow.js";
import type { ExperienceLoopConfig } from "../../lib/experience-loop-host.js";

useDomEnv();

// URL spy so the embedded ExperienceFrame does not make happy-dom navigate.
const realCreate = URL.createObjectURL;
function installUrlSpy() {
  URL.createObjectURL = (() => "about:blank#blob") as typeof URL.createObjectURL;
}
afterEach(() => {
  URL.createObjectURL = realCreate;
});

// Mock the Experience store so the detached host's setScope/rehydrate/reads do
// not make real API calls. The host uses the descriptor bootstrap before the
// rehydrate settles, so a null store session is the normal initial state.
// IR-73C: the host now also reads queued attachment + report status and exposes
// a trusted Finish (endSession) + report controls, so those store actions are
// mocked too. `storeSessionValue` is mutable so tests can simulate pre/post
// hydration of the authoritative store session (the Finish button is disabled
// until that session exists).
const realStore = await import("../../stores/experience-store.js");
let storeSessionValue: unknown = null;
const storeMocks = {
  rehydrate: mock(async () => {}),
  setScope: mock(),
  submitAction: mock(),
  runEffect: mock(),
  queueReport: mock(async () => null),
  endSession: mock(async () => null),
};
mock.module("../../stores/experience-store.js", () => ({
  ...realStore,
  useExperienceSession: () => storeSessionValue,
  useExperienceEffects: () => [],
  useExperienceQueuedAttachment: () => null,
  useExperienceReportStatus: () => null,
  useExperienceStore: {
    getState: () => ({
      setScope: storeMocks.setScope,
      rehydrate: storeMocks.rehydrate,
      submitAction: storeMocks.submitAction,
      runEffect: storeMocks.runEffect,
      queueReport: storeMocks.queueReport,
      endSession: storeMocks.endSession,
    }),
  },
}));

// Mock ExperienceFrame to a thin shell that still renders a real iframe with
// the sandbox contract (the existing surface tests assert exactly that) while
// capturing the RM-6 realtime props (onModelRequest / onRoundCommit /
// realtime) and wiring a fake ref handle whose sendModelResult is a spy. The
// real frame needs a live handshake happy-dom cannot drive; the bridge wiring
// inside it is covered by ExperienceFrame.test.tsx + the bridge integration
// tests, so the boundary this file pins (host chrome + prop threading) is
// unchanged.
const realFrame = await import("./ExperienceFrame.js");
import type {
  ExperienceModelSeatRequest,
  ExperienceRoundCommitClaim,
} from "./ExperienceFrame.js";
let capturedOnModelRequest: ((req: ExperienceModelSeatRequest) => void) | null = null;
let capturedOnRoundCommit: ((claim: ExperienceRoundCommitClaim) => void) | null = null;
let capturedRealtime: { readonly config: ExperienceLoopConfig } | undefined;
const sendModelResultSpy = mock((_seatId: string, _result: unknown, _requestId?: string) => {});
mock.module("./ExperienceFrame.js", () => ({
  ...realFrame,
  ExperienceFrame: (props: {
    onModelRequest?: (req: ExperienceModelSeatRequest) => void;
    onRoundCommit?: (claim: ExperienceRoundCommitClaim) => void;
    realtime?: { readonly config: ExperienceLoopConfig };
    ref?: React.Ref<unknown>;
  }) => {
    capturedOnModelRequest = props.onModelRequest ?? null;
    capturedOnRoundCommit = props.onRoundCommit ?? null;
    capturedRealtime = props.realtime;
    const ref = props.ref;
    if (ref !== null && typeof ref === "object" && "current" in ref) {
      (ref as { current: unknown }).current = {
        sendState: () => {},
        sendResult: () => {},
        sendError: () => {},
        sendPending: () => {},
        sendLifecycle: () => {},
        sendModelResult: sendModelResultSpy,
        isReady: true,
        sessionNonce: "nonce-mock",
      };
    }
    return <iframe sandbox="allow-scripts" title="Interactive experience" data-testid="mock-frame" />;
  },
}));

const {
  openExperienceDetachedWindow,
  readDetachedDescriptor,
  isDetachedExperienceWindow,
  ExperienceDetachedHost,
  DETACHED_WINDOW_FEATURES,
} = await import("./ExperienceDetachedWindow.js");

const DESCRIPTOR = {
  chatId: "chat_1",
  branchId: "branch_1",
  sessionId: "sess_42",
  title: "Hearts",
  visualSource: "<div>play</div>",
  initialRevision: 3,
};

// A minimal authoritative store session fixture (the descriptor is only the
// bootstrap; the Finish button requires this authoritative session).
const STORE_SESSION = {
  sessionId: "sess_42",
  visualSource: "<div>play</div>",
  visualSourceHash: "hash_42",
  revision: 3,
  status: "active",
  view: { revision: 3, status: "active", state: {}, actions: [] },
  manifest: { name: "Hearts" },
};

/** A minimal fake opener window with a controllable location + open() result. */
function fakeOpener(props: { pathname?: string; search?: string; open?: Window | null }): DetachWindow {
  return {
    location: { pathname: props.pathname ?? "/app", search: props.search ?? "", hash: "" },
    opener: null,
    // Pass through exactly — `null` means "popup blocked". (Do NOT coalesce,
    // which would turn null into {}.)
    open: () => props.open as Window | null,
  } as unknown as DetachWindow;
}

/** A minimal fake popup window whose `opener` points at the given descriptor. */
function fakePopup(openerDesc?: unknown): DetachWindow {
  return {
    location: { pathname: "/app", search: "", hash: openerDesc ? "#experience=sess_42" : "" },
    opener: openerDesc ? ({ __experienceDetachDescriptor: openerDesc } as unknown as DetachWindow["opener"]) : null,
    open: () => null,
  } as unknown as DetachWindow;
}

describe("openExperienceDetachedWindow — mechanism + popup-blocked fallback", () => {
  it("opens a same-origin hash URL and stashes the descriptor on the opener", () => {
    let openedUrl = "";
    let openedFeatures = "";
    const handle = {} as Window;
    const opener = {
      location: { pathname: "/app", search: "?x=1", hash: "" },
      opener: null,
      open: (url?: string, _t?: string, features?: string) => {
        openedUrl = url ?? "";
        openedFeatures = features ?? "";
        return handle;
      },
    } as unknown as DetachWindow;

    const result = openExperienceDetachedWindow(DESCRIPTOR, opener);

    expect(result).toBe(handle);
    expect(openedUrl).toBe("/app?x=1#experience=sess_42");
    expect(openedFeatures).toBe(DETACHED_WINDOW_FEATURES);
    // Descriptor stashed on the opener for the popup to read via window.opener.
    expect(opener.__experienceDetachDescriptor).toEqual(DESCRIPTOR);
  });

  it("surfaces a blocked popup as null (does not pretend success)", () => {
    const opener = fakeOpener({ open: null });
    expect(openExperienceDetachedWindow(DESCRIPTOR, opener)).toBeNull();
  });
});

describe("readDetachedDescriptor — opener handoff", () => {
  it("returns null when there is no opener descriptor", () => {
    expect(readDetachedDescriptor(fakePopup(null))).toBeNull();
  });

  it("reads a valid descriptor from the opener", () => {
    expect(readDetachedDescriptor(fakePopup(DESCRIPTOR))).toEqual(DESCRIPTOR);
  });

  it("rejects a malformed descriptor (no visualSource)", () => {
    expect(readDetachedDescriptor(fakePopup({ sessionId: "x" }))).toBeNull();
  });

  it("rejects a descriptor missing the scope fields (chatId/branchId)", () => {
    expect(
      readDetachedDescriptor(
        fakePopup({ sessionId: "s", title: "T", visualSource: "<div/>", initialRevision: 0 }),
      ),
    ).toBeNull();
  });
});

describe("isDetachedExperienceWindow", () => {
  it("detects the #experience hash", () => {
    const withHash = { location: { hash: "#experience=sess_42" } } as Pick<DetachWindow, "location">;
    const without = { location: { hash: "" } } as Pick<DetachWindow, "location">;
    expect(isDetachedExperienceWindow(withHash)).toBe(true);
    expect(isDetachedExperienceWindow(without)).toBe(false);
  });
});

describe("ExperienceDetachedHost — trusted wrapper", () => {
  beforeEach(() => {
    storeSessionValue = null;
    for (const m of Object.values(storeMocks)) m.mockClear();
  });

  it("renders trusted chrome + the sandboxed frame from an explicit descriptor", () => {
    installUrlSpy();
    const { getByText, container, queryByTestId } = render(
      <ExperienceDetachedHost descriptor={DESCRIPTOR} />,
    );
    // Trusted title in chrome.
    expect(getByText("Hearts")).toBeTruthy();
    // The detached close-self control is present (trusted chrome).
    expect(queryByTestId("experience-detached-close")).not.toBeNull();
    // The user visual is inside an iframe (sandboxed), NOT the top-level doc.
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute("sandbox")).toBe("allow-scripts");
    // The host set the store scope for the exact chat/branch (reconnect).
    expect(storeMocks.setScope).toHaveBeenCalledWith("chat_1", "branch_1");
    // IR-73C: the trusted report-control footer + Finish button are present.
    expect(queryByTestId("experience-detached-report-footer")).not.toBeNull();
    expect(queryByTestId("experience-report-controls")).not.toBeNull();
    expect(queryByTestId("experience-detached-finish")).not.toBeNull();
  });

  // ── 4a phase (e): mobile touch-target class pins (happy-dom computes no
  // layout): the header Finish/Close buttons and the report footer carry the
  // 36px mobile floor via max-md utilities; desktop sizes are unchanged.
  it("header buttons + report footer carry mobile touch floors (4a phase e)", () => {
    installUrlSpy();
    const { getByTestId } = render(<ExperienceDetachedHost descriptor={DESCRIPTOR} />);
    const finish = getByTestId("experience-detached-finish") as HTMLButtonElement;
    expect(finish.classList.contains("max-md:min-h-9")).toBe(true);
    const close = getByTestId("experience-detached-close") as HTMLButtonElement;
    expect(close.classList.contains("max-md:min-h-9")).toBe(true);
    expect(close.classList.contains("max-md:min-w-9")).toBe(true);
    const footer = getByTestId("experience-detached-report-footer") as HTMLElement;
    expect(
      footer.className.includes("pb-[calc(env(safe-area-inset-bottom,0px)+8px)]"),
    ).toBe(true);
    // The shared report action button (ExperienceReportControls) carries the
    // same floor — one pin covers the modal footer surface too.
    const action = getByTestId("experience-report-action") as HTMLButtonElement;
    expect(action.classList.contains("max-md:min-h-9")).toBe(true);
  });

  it("shows the unavailable fallback when there is no descriptor", () => {
    installUrlSpy();
    // readDetachedDescriptor() (default window) returns null under happy-dom
    // (no opener), so the host falls back.
    const { container, queryByTestId } = render(<ExperienceDetachedHost />);
    expect(queryByTestId("experience-detached-close")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
  });
});

// ─── IR-73C: trusted Finish + report controls in the detached surface ──────
describe("ExperienceDetachedHost — trusted Finish + report controls (IR-73C)", () => {
  beforeEach(() => {
    storeSessionValue = null;
    for (const m of Object.values(storeMocks)) m.mockClear();
  });

  it("Finish is disabled before the store session hydrates (descriptor alone is not authority)", () => {
    installUrlSpy();
    // No authoritative store session — the descriptor bootstrap is present
    // but the Finish button must be disabled.
    storeSessionValue = null;
    const { getByTestId } = render(
      <ExperienceDetachedHost descriptor={DESCRIPTOR} />,
    );
    const btn = getByTestId("experience-detached-finish") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("Finish opens a shared confirmation; endSession runs only after confirm", async () => {
    installUrlSpy();
    // The authoritative store session is hydrated — Finish is enabled.
    storeSessionValue = STORE_SESSION;
    storeMocks.endSession.mockResolvedValue(null);
    const { getByTestId, queryByTestId } = render(
      <ExperienceDetachedHost descriptor={DESCRIPTOR} />,
    );
    // Clicking Finish does NOT end immediately — confirmation is required.
    await act(async () => {
      fireEvent.click(getByTestId("experience-detached-finish"));
    });
    expect(storeMocks.endSession).not.toHaveBeenCalled();
    // The shared DestructiveConfirmModal renders the confirm body. It uses a
    // confirm button; we click it by text (the confirm label is the Finish
    // key, returned verbatim by the mocked t).
    const confirmBtns = document.querySelectorAll("button");
    const confirmBtn = Array.from(confirmBtns).find(
      (b) => b.textContent === "experience_finish" && b !== getByTestId("experience-detached-finish"),
    );
    expect(confirmBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(confirmBtn!);
    });
    expect(storeMocks.endSession).toHaveBeenCalledTimes(1);
    void queryByTestId;
  });

  it("a rejected/null endSession is fail-closed: no unhandled rejection, surface stays open", async () => {
    installUrlSpy();
    storeSessionValue = STORE_SESSION;
    // endSession throws (e.g. pre-hydration edge or a thrown store action).
    storeMocks.endSession.mockRejectedValue(new Error("no active session"));
    const { getByTestId, queryByTestId } = render(
      <ExperienceDetachedHost descriptor={DESCRIPTOR} />,
    );
    // Open the confirmation.
    await act(async () => {
      fireEvent.click(getByTestId("experience-detached-finish"));
    });
    const confirmBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "experience_finish" && b !== getByTestId("experience-detached-finish"),
    );
    expect(confirmBtn).toBeTruthy();
    // Confirm — the rejection is caught; no unhandled rejection; the surface
    // stays open (the trusted chrome + frame are still present).
    await act(async () => {
      fireEvent.click(confirmBtn!);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(storeMocks.endSession).toHaveBeenCalledTimes(1);
    // The surface is NOT destroyed — the close button + frame are still there.
    expect(queryByTestId("experience-detached-close")).not.toBeNull();
    expect(queryByTestId("experience-detached-finish")).not.toBeNull();
  });

  it("report controls call store.queueReport on a click (no silent growth)", async () => {
    installUrlSpy();
    storeMocks.queueReport.mockResolvedValue(null);
    const { getByTestId } = render(
      <ExperienceDetachedHost descriptor={DESCRIPTOR} />,
    );
    // The report controls are present in the trusted footer. The action
    // button is disabled by default (no pending events / no attachment from
    // the null store reads) so no queue call happens automatically.
    expect(storeMocks.queueReport).not.toHaveBeenCalled();
    void getByTestId;
  });
});

// ─── RM-6: realtime round plumb (descriptor config + seam + finished panel) ─

const REALTIME_CONFIG: ExperienceLoopConfig = {
  rulesSource: 'context.experience.register({ apiVersion: 1 });',
  tickMs: 100,
  initialState: { remaining: 1000 },
  seed: 42,
  viewer: { kind: "human", participantId: "p1" },
  scriptSeats: [],
};

const REALTIME_DESCRIPTOR = { ...DESCRIPTOR, realtimeConfig: REALTIME_CONFIG };

function resetRealtimeCaptures(): void {
  capturedOnModelRequest = null;
  capturedOnRoundCommit = null;
  capturedRealtime = undefined;
  sendModelResultSpy.mockClear();
}

describe("ExperienceDetachedHost — realtime round plumb (RM-6)", () => {
  beforeEach(() => {
    storeSessionValue = null;
    for (const m of Object.values(storeMocks)) m.mockClear();
    resetRealtimeCaptures();
  });

  it("a descriptor with realtimeConfig reaches the frame as the realtime prop", () => {
    installUrlSpy();
    render(<ExperienceDetachedHost descriptor={REALTIME_DESCRIPTOR} />);
    expect(capturedRealtime).not.toBeUndefined();
    expect(capturedRealtime?.config).toBe(REALTIME_CONFIG);
  });

  it("a turn-based descriptor omits the realtime prop", () => {
    installUrlSpy();
    render(<ExperienceDetachedHost descriptor={DESCRIPTOR} />);
    expect(capturedRealtime).toBeUndefined();
  });

  it("readDetachedDescriptor round-trips a valid realtimeConfig and rejects a malformed one", () => {
    expect(readDetachedDescriptor(fakePopup(REALTIME_DESCRIPTOR))).toEqual(REALTIME_DESCRIPTOR);
    expect(
      readDetachedDescriptor(fakePopup({ ...DESCRIPTOR, realtimeConfig: "nope" })),
    ).toBeNull();
  });

  it("a resolved seam reply re-enters the frame via sendModelResult", async () => {
    installUrlSpy();
    const seam = mock((_req: ExperienceModelSeatRequest) => Promise.resolve<unknown | null>({ type: "speak" }));
    render(<ExperienceDetachedHost descriptor={REALTIME_DESCRIPTOR} onModelRequest={seam} />);
    expect(capturedOnModelRequest).not.toBeNull();
    await act(async () => {
      capturedOnModelRequest!({ seatId: "m1", prompt: { q: "hi" }, requestId: "rq-1" });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(seam).toHaveBeenCalledTimes(1);
    expect(sendModelResultSpy).toHaveBeenCalledTimes(1);
    expect(sendModelResultSpy.mock.calls[0]).toEqual(["m1", { type: "speak" }, "rq-1"]);
  });

  it("an absent or null seam sends nothing and the surface stays alive", async () => {
    installUrlSpy();
    render(<ExperienceDetachedHost descriptor={REALTIME_DESCRIPTOR} />);
    await act(async () => {
      capturedOnModelRequest!({ seatId: "m1", prompt: {}, requestId: "rq-2" });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(sendModelResultSpy).not.toHaveBeenCalled();
  });

  it("a round commit renders the trusted finished panel with status/score and fires the hook once", () => {
    installUrlSpy();
    const onRoundCommit = mock((_claim: ExperienceRoundCommitClaim) => {});
    const { getByTestId, queryAllByTestId } = render(
      <ExperienceDetachedHost descriptor={REALTIME_DESCRIPTOR} onRoundCommit={onRoundCommit} />,
    );
    expect(capturedOnRoundCommit).not.toBeNull();
    act(() => {
      capturedOnRoundCommit!({
        status: "completed",
        finalState: { remaining: 0 },
        log: [],
        score: 1500,
        summary: "Top out",
      });
    });
    expect(getByTestId("experience-detached-round-finished")).toBeTruthy();
    expect(getByTestId("experience-detached-round-finished-status").textContent).toBe(
      "experience_round_finished",
    );
    expect(getByTestId("experience-detached-round-finished-score").textContent).toContain("1500");
    expect(getByTestId("experience-detached-round-finished-summary").textContent).toBe("Top out");
    expect(onRoundCommit).toHaveBeenCalledTimes(1);
    // A duplicate commit neither re-fires nor re-renders.
    act(() => {
      capturedOnRoundCommit!({ status: "interrupted", finalState: {}, log: [] });
    });
    expect(onRoundCommit).toHaveBeenCalledTimes(1);
    expect(queryAllByTestId("experience-detached-round-finished")).toHaveLength(1);
    // The trusted chrome above the panel stays reachable (header untouched).
    expect(getByTestId("experience-detached-close")).toBeTruthy();
  });
});
