/**
 * ExperienceModal — trusted-chrome + session-preservation tests (IR-62).
 *
 * The live handshake is covered by the bridge integration test; here we pin the
 * CHROME contract and the close-without-destroy invariant:
 *   - Detach calls onDetach (the parent opens the window); hidden when no onDetach.
 *   - Finish opens a system confirmation IN THE CHROME (not the frame), and only
 *     the confirm button runs the privileged onFinishExperience.
 *   - A frame-driven finish REQUEST also routes through the chrome confirmation
 *     (a compromised visual cannot auto-finish).
 *   - The optional in-session settings entry (lobby Б4) follows the same
 *     trusted-chrome confirm pattern: cancel never fires the privileged op.
 *   - Close hides the surface and calls onClose only — there is no onDestroy
 *     prop, so closing never ends the session.
 *
 * i18n keys are mocked at the boundary (return the key verbatim) so the chrome
 * text is stable and the test does not depend on the locale bundle.
 */
import { describe, it, expect, beforeAll, mock, afterEach } from "bun:test";
import { render, fireEvent, act } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";
import type { ExperienceLoopConfig } from "../../lib/experience-loop-host.js";

useDomEnv();

// Spy on URL.createObjectURL so happy-dom does not try to navigate the embedded
// iframe (its BrowserFrameNavigator rejects a real blob URL as "null" and logs
// a noisy TypeError). Returns about:blank so no navigation/fetch is attempted.
const realCreate = URL.createObjectURL;
function installUrlSpy() {
  URL.createObjectURL = (() => "about:blank#blob") as typeof URL.createObjectURL;
}
afterEach(() => {
  URL.createObjectURL = realCreate;
});

// Mock the i18n context so `t` returns keys verbatim (stable chrome text). The
// `...real` spread keeps every other export intact (AGENTS.md mock.module
// gotcha — file-scoped vi.mock does not apply here; bun:test module mock does).
const realI18n = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({ t: (k: string) => k, tDynamic: (k: string) => k, locale: "en", setLocale: () => {}, ready: true }),
}));

// Mock ExperienceFrame to a thin shell that captures the onAction prop so the
// rejection-handling regression can invoke the modal's internal handleAction
// directly (the real frame requires a live handshake happy-dom cannot drive).
// RM-6: the shell also captures the realtime props (onModelRequest /
// onRoundCommit / realtime) and wires a fake ref handle whose sendModelResult
// is a spy — the modal's seam round-trip is asserted through it.
const realFrame = await import("./ExperienceFrame.js");
import type {
  ExperienceModelSeatRequest,
  ExperienceRoundCommitClaim,
} from "./ExperienceFrame.js";
let capturedOnAction: ((action: { requestId: string }) => void) | null = null;
let capturedOnModelRequest: ((req: ExperienceModelSeatRequest) => void) | null = null;
let capturedOnRoundCommit: ((claim: ExperienceRoundCommitClaim) => void) | null = null;
let capturedRealtime: { readonly config: ExperienceLoopConfig } | undefined;
const sendModelResultSpy = mock((_seatId: string, _result: unknown, _requestId?: string) => {});
mock.module("./ExperienceFrame.js", () => ({
  ...realFrame,
  ExperienceFrame: (props: {
    onAction: (a: { requestId: string }) => void;
    onModelRequest?: (req: ExperienceModelSeatRequest) => void;
    onRoundCommit?: (claim: ExperienceRoundCommitClaim) => void;
    realtime?: { readonly config: ExperienceLoopConfig };
    ref?: React.Ref<unknown>;
  }) => {
    capturedOnAction = props.onAction;
    capturedOnModelRequest = props.onModelRequest ?? null;
    capturedOnRoundCommit = props.onRoundCommit ?? null;
    capturedRealtime = props.realtime;
    // The modal reads frameRef.current after awaits; assigning during render
    // matches this file's established mock style (side-effect capture).
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
    return <div data-testid="mock-frame" />;
  },
}));

const { ExperienceModal } = await import("./ExperienceModal.js");
import type { ExperienceActionOutcome } from "./ExperienceModal.js";

const VISUAL = "<div id=\"g\">play</div>";

/** A no-op async action handler that resolves to a success outcome (the
 *  chrome tests do not exercise action submission — only the contract shape
 *  matters so the component typechecks). */
const okOutcome: ExperienceActionOutcome = {
  ok: true,
  revision: 1,
  status: "active",
  view: { state: {}, actions: [], revision: 1, status: "active" },
};
const onAction = () => Promise.resolve(okOutcome);

function renderModal(over: Partial<React.ComponentProps<typeof ExperienceModal>> = {}) {
  installUrlSpy();
  const onClose = mock(() => {});
  const onDetach = mock(() => {});
  const onFinishExperience = mock(() => {});
  const utils = render(
    <ExperienceModal
      open
      onClose={onClose}
      title="Hearts"
      visualSource={VISUAL}
      sessionId="sess_1"
      initialRevision={0}
      onAction={onAction}
      onDetach={over.onDetach === undefined ? onDetach : over.onDetach}
      onFinishExperience={over.onFinishExperience === undefined ? onFinishExperience : over.onFinishExperience}
      {...(over as object)}
    />,
  );
  return { ...utils, onClose, onDetach, onFinishExperience };
}

describe("ExperienceModal — trusted chrome", () => {
  it("renders the Detach control and calls onDetach on click", () => {
    const { getByTestId, onDetach } = renderModal();
    fireEvent.click(getByTestId("experience-detach"));
    expect(onDetach).toHaveBeenCalledTimes(1);
  });

  it("renders the reportControls footer OUTSIDE the frame when supplied (IR-73C)", () => {
    const { getByTestId, queryByTestId } = renderModal({
      reportControls: <div data-testid="injected-report-controls">controls</div>,
    });
    // The trusted footer renders the supplied content.
    expect(getByTestId("experience-report-footer")).toBeTruthy();
    expect(getByTestId("injected-report-controls")).toBeTruthy();
    // The footer is a sibling of the frame container, not inside it.
    const frameContainer = getByTestId("mock-frame").parentElement;
    const footer = getByTestId("experience-report-footer");
    expect(frameContainer?.contains(footer)).toBe(false);
    void queryByTestId;
  });

  it("omits the reportControls footer when not supplied", () => {
    const { queryByTestId } = renderModal();
    expect(queryByTestId("experience-report-footer")).toBeNull();
  });

  it("hides the Detach control when onDetach is absent", () => {
    const { queryByTestId } = renderModal({ onDetach: undefined });
    expect(queryByTestId("experience-detach")).toBeNull();
  });

  it("Close button calls onClose and nothing else (no session destroy)", () => {
    const { getByTestId, onClose, onFinishExperience } = renderModal();
    fireEvent.click(getByTestId("experience-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    // Closing never triggers finish/destroy.
    expect(onFinishExperience).not.toHaveBeenCalled();
  });
});

describe("ExperienceModal — finish confirmation lives in the chrome", () => {
  it("Finish opens a chrome confirmation, not an auto-finish", () => {
    const { getByTestId, queryByTestId, onFinishExperience } = renderModal();
    fireEvent.click(getByTestId("experience-finish"));
    // Confirm prompt is present; the privileged op has NOT run yet.
    expect(getByTestId("experience-finish-confirm")).toBeTruthy();
    expect(onFinishExperience).not.toHaveBeenCalled();
    // Cancel dismisses without finishing.
    fireEvent.click(getByTestId("experience-finish-cancel"));
    expect(queryByTestId("experience-finish-confirm")).toBeNull();
    expect(onFinishExperience).not.toHaveBeenCalled();
  });

  it("the confirm button (not the frame) runs the privileged finish", () => {
    const { getByTestId, onFinishExperience } = renderModal();
    fireEvent.click(getByTestId("experience-finish"));
    fireEvent.click(getByTestId("experience-finish-confirm-btn"));
    expect(onFinishExperience).toHaveBeenCalledTimes(1);
  });

  it("hides the Finish control when onFinishExperience is absent", () => {
    const { queryByTestId } = renderModal({ onFinishExperience: undefined });
    expect(queryByTestId("experience-finish")).toBeNull();
  });

  it("shows a quiet-end option in the confirm and runs onEndSessionQuiet (not the with-report finish)", () => {
    const onEndSessionQuiet = mock(() => {});
    const { getByTestId, queryByTestId, onFinishExperience } = renderModal({
      onFinishExperience: () => {},
      onEndSessionQuiet,
    });
    fireEvent.click(getByTestId("experience-finish"));
    // The trusted overlay offers BOTH: with-report (primary) and quiet (secondary).
    expect(getByTestId("experience-finish-confirm-btn")).toBeTruthy();
    expect(getByTestId("experience-finish-quiet")).toBeTruthy();
    fireEvent.click(getByTestId("experience-finish-quiet"));
    expect(onEndSessionQuiet).toHaveBeenCalledTimes(1);
    expect(onFinishExperience).not.toHaveBeenCalled();
    // The quiet choice dismisses the confirm overlay in the same way finish does.
    expect(queryByTestId("experience-finish-confirm")).toBeNull();
  });

  it("hides the quiet-end option when onEndSessionQuiet is absent", () => {
    const { getByTestId, queryByTestId } = renderModal();
    fireEvent.click(getByTestId("experience-finish"));
    expect(queryByTestId("experience-finish-quiet")).toBeNull();
  });
});

describe("ExperienceModal — in-session settings entry (lobby Б4)", () => {
  it("hides the Settings control when onOpenSessionSettings is absent", () => {
    const { queryByTestId } = renderModal();
    expect(queryByTestId("experience-session-settings")).toBeNull();
  });

  it("Settings opens a chrome confirmation; cancel dismisses WITHOUT the privileged op; confirm runs it exactly once", () => {
    const onOpenSessionSettings = mock(() => {});
    const { getByTestId, queryByTestId } = renderModal({ onOpenSessionSettings });
    fireEvent.click(getByTestId("experience-session-settings"));
    // Confirm prompt is present IN THE CHROME; the privileged op has NOT run.
    expect(getByTestId("experience-settings-confirm")).toBeTruthy();
    expect(onOpenSessionSettings).not.toHaveBeenCalled();
    // Cancel dismisses without invoking the entry.
    fireEvent.click(getByTestId("experience-settings-cancel"));
    expect(queryByTestId("experience-settings-confirm")).toBeNull();
    expect(onOpenSessionSettings).not.toHaveBeenCalled();
    // Reopen and confirm — the privileged op runs exactly once and the overlay
    // closes.
    fireEvent.click(getByTestId("experience-session-settings"));
    fireEvent.click(getByTestId("experience-settings-confirm-btn"));
    expect(onOpenSessionSettings).toHaveBeenCalledTimes(1);
    expect(queryByTestId("experience-settings-confirm")).toBeNull();
  });
});

describe("ExperienceModal — session preservation on close", () => {
  it("closing and reopening resets the finish-confirmation step", async () => {
    const { getByTestId, queryByTestId, rerender } = renderModal();
    fireEvent.click(getByTestId("experience-finish"));
    expect(getByTestId("experience-finish-confirm")).toBeTruthy();
    // Close the modal (parent sets open=false).
    await act(async () => {
      rerender(
        <ExperienceModal
          open={false}
          onClose={() => {}}
          title="Hearts"
          visualSource={VISUAL}
          sessionId="sess_1"
          initialRevision={0}
          onAction={onAction}
          onFinishExperience={() => {}}
        />,
      );
    });
    // Reopen.
    await act(async () => {
      rerender(
        <ExperienceModal
          open
          onClose={() => {}}
          title="Hearts"
          visualSource={VISUAL}
          sessionId="sess_1"
          initialRevision={0}
          onAction={onAction}
          onFinishExperience={() => {}}
        />,
      );
    });
    // The stale confirm is gone — the surface reopened clean.
    expect(queryByTestId("experience-finish-confirm")).toBeNull();
  });
});

describe("ExperienceModal — async action-outcome contract (seam #3)", () => {
  it("accepts an async onAction returning the outcome contract and renders", async () => {
    installUrlSpy();
    const actionHandler = mock((_action: { requestId: string }) =>
      Promise.resolve<ExperienceActionOutcome>({
        ok: true,
        revision: 7,
        status: "active",
        view: { state: { turn: 2 }, actions: [], revision: 7, status: "active" },
      }),
    );
    const { } = render(
      <ExperienceModal
        open
        onClose={() => {}}
        title="Hearts"
        visualSource={VISUAL}
        sessionId="sess_1"
        initialRevision={5}
        view={{ state: {}, actions: [], revision: 5, status: "active" }}
        onAction={actionHandler as unknown as (a: { requestId: string }) => Promise<ExperienceActionOutcome>}
      />,
    );
    // The modal mounts with the async contract + authoritative view; the
    // mocked frame is present.
    expect(document.querySelector("[data-testid='mock-frame']")).not.toBeNull();
  });

  it("a failure outcome is a valid bridge error shape (fail-closed)", () => {
    const failOutcome: ExperienceActionOutcome = {
      ok: false,
      code: "stale_revision",
      message: "Action was built on an outdated state.",
      revision: 9,
    };
    expect(failOutcome.ok).toBe(false);
    expect(failOutcome.code).toBe("stale_revision");
    expect(typeof failOutcome.message).toBe("string");
  });
});

describe("ExperienceModal — live state + pending push (seams #2 + #5)", () => {
  it("renders the pending chrome indicator for a typing phase", () => {
    installUrlSpy();
    const { getByTestId } = render(
      <ExperienceModal
        open
        onClose={() => {}}
        title="Hearts"
        visualSource={VISUAL}
        sessionId="sess_1"
        initialRevision={0}
        view={{ state: {}, actions: [], revision: 0, status: "active" }}
        onAction={onAction}
        pendingPhase="typing"
      />,
    );
    expect(getByTestId("experience-pending")).toBeTruthy();
  });

  it("renders the timer-wait label for a timer phase (fix step 2d)", () => {
    installUrlSpy();
    const { getByTestId } = render(
      <ExperienceModal
        open
        onClose={() => {}}
        title="Hearts"
        visualSource={VISUAL}
        sessionId="sess_t"
        initialRevision={0}
        view={{ state: {}, actions: [], revision: 0, status: "active" }}
        onAction={onAction}
        pendingPhase="timer"
      />,
    );
    // t() returns keys verbatim — the badge text is the timer key, not the
    // model "thinking" key.
    expect(getByTestId("experience-pending").textContent).toContain("experience_pending_timer");
  });

  it("hides the pending chrome indicator for an idle phase", () => {
    installUrlSpy();
    const { queryByTestId } = render(
      <ExperienceModal
        open
        onClose={() => {}}
        title="Hearts"
        visualSource={VISUAL}
        sessionId="sess_2"
        initialRevision={0}
        view={{ state: {}, actions: [], revision: 0, status: "active" }}
        onAction={onAction}
        pendingPhase="idle"
      />,
    );
    expect(queryByTestId("experience-pending")).toBeNull();
  });
});

describe("ExperienceModal — fail-closed rejection handling (seam #3 defect #4)", () => {
  it("a rejected action callback sends onError and does not strand the bridge lock", async () => {
    installUrlSpy();
    capturedOnAction = null;
    const onError = mock((_reason: string) => {});
    const rejectingAction: React.ComponentProps<typeof ExperienceModal>["onAction"] = () =>
      Promise.reject(new Error("store exploded"));
    render(
      <ExperienceModal
        open
        onClose={() => {}}
        title="Hearts"
        visualSource={VISUAL}
        sessionId="sess_1"
        initialRevision={5}
        view={{ state: {}, actions: [], revision: 5, status: "active" }}
        onAction={rejectingAction}
        onError={onError}
      />,
    );
    // The modal captured the frame's onAction (its internal handleAction).
    expect(capturedOnAction).not.toBeNull();
    // Invoke it — the rejection must be caught, not propagated as an
    // unhandled rejection. The modal reports through onError and always
    // acks the frame (sendError via frameRef). Since the mocked frame does
    // not wire a ref, sendError is a no-op — but the catch path is proven by
    // onError firing and no thrown rejection.
    await act(async () => {
      await capturedOnAction!({ requestId: "visual-rid-42" });
    });
    expect(onError).toHaveBeenCalledTimes(1);
    // The error message reported is safe (the exception's message, not raw
    // text leaked to the visual).
    expect(typeof onError.mock.calls[0]![0]).toBe("string");
  });
});

// ── 4a phase (e): mobile touch targets + header composition ────────────────
// Class pins (happy-dom computes no layout): chrome/confirm buttons carry
// max-md min-heights (36px precedent), icon buttons also min-width, the
// pending badge yields its TEXT to the truncated title on mobile (pulse dot
// stays), and the report footer pads past the gesture bar (safe-area).
describe("ExperienceModal — mobile touch targets + badge composition (4a phase e)", () => {
  it("chrome buttons have mobile min-height/min-width floors", () => {
    const { getByTestId } = renderModal();
    const detach = getByTestId("experience-detach") as HTMLButtonElement;
    // Detach is an icon button: BOTH the min-height and the min-width floor.
    expect(detach.classList.contains("max-md:min-h-9")).toBe(true);
    expect(detach.classList.contains("max-md:min-w-9")).toBe(true);
    const finish = getByTestId("experience-finish") as HTMLButtonElement;
    expect(finish.classList.contains("max-md:min-h-9")).toBe(true);
    const close = getByTestId("experience-close") as HTMLButtonElement;
    expect(close.classList.contains("max-md:min-h-9")).toBe(true);
    expect(close.classList.contains("max-md:min-w-9")).toBe(true);
  });

  it("finish-confirm buttons have mobile min-heights", () => {
    const { getByTestId } = renderModal();
    fireEvent.click(getByTestId("experience-finish"));
    const cancel = getByTestId("experience-finish-cancel") as HTMLButtonElement;
    expect(cancel.classList.contains("max-md:min-h-9")).toBe(true);
    const confirm = getByTestId("experience-finish-confirm-btn") as HTMLButtonElement;
    expect(confirm.classList.contains("max-md:min-h-9")).toBe(true);
  });

  it("pending badge text is hidden on mobile (pulse dot remains)", () => {
    const { getByTestId } = renderModal({ pendingPhase: "typing" });
    const badge = getByTestId("experience-pending");
    const label = badge.querySelector("span.max-md\\:hidden");
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe("experience_pending_typing");
    // The pulse dot is NOT hidden on mobile.
    const dot = badge.querySelector("span.animate-pulse");
    expect(dot).not.toBeNull();
    expect(dot!.classList.contains("max-md:hidden")).toBe(false);
  });

  it("report footer pads past the gesture bar on mobile", () => {
    const { getByTestId } = renderModal({ reportControls: <div data-testid="rc" /> });
    const footer = getByTestId("experience-report-footer") as HTMLElement;
    expect(
      footer.className.includes("pb-[calc(env(safe-area-inset-bottom,0px)+8px)]"),
    ).toBe(true);
  });
});

// ─── RM-6: realtime round plumb (model seam + round-finished panel) ────────

const REALTIME_CONFIG: ExperienceLoopConfig = {
  rulesSource: 'context.experience.register({ apiVersion: 1 });',
  tickMs: 100,
  initialState: { remaining: 1000 },
  seed: 42,
  viewer: { kind: "human", participantId: "p1" },
  scriptSeats: [],
};

const COMMIT_CLAIM: ExperienceRoundCommitClaim = {
  status: "completed",
  finalState: { remaining: 0 },
  log: [{ kind: "round_started", seed: 42 }, { kind: "round_finished", status: "completed" }],
  score: 42,
  summary: "Board cleared",
};

function resetRealtimeCaptures(): void {
  capturedOnModelRequest = null;
  capturedOnRoundCommit = null;
  capturedRealtime = undefined;
  sendModelResultSpy.mockClear();
}

describe("ExperienceModal — realtime round plumb (RM-6)", () => {
  it("passes the realtime config through to the frame", () => {
    resetRealtimeCaptures();
    renderModal({ realtime: { config: REALTIME_CONFIG } });
    expect(capturedRealtime?.config).toBe(REALTIME_CONFIG);
  });

  it("omits the realtime prop for a turn-based surface", () => {
    resetRealtimeCaptures();
    renderModal();
    expect(capturedRealtime).toBeUndefined();
  });

  it("a resolved seam reply re-enters the frame via sendModelResult", async () => {
    resetRealtimeCaptures();
    const seam = mock((_req: ExperienceModelSeatRequest) => Promise.resolve<unknown | null>({ type: "speak" }));
    renderModal({ realtime: { config: REALTIME_CONFIG }, onModelRequest: seam });
    expect(capturedOnModelRequest).not.toBeNull();
    await act(async () => {
      capturedOnModelRequest!({ seatId: "m1", prompt: { q: "hi" }, requestId: "rq-1" });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(seam).toHaveBeenCalledTimes(1);
    expect(seam.mock.calls[0]![0]).toEqual({ seatId: "m1", prompt: { q: "hi" }, requestId: "rq-1" });
    expect(sendModelResultSpy).toHaveBeenCalledTimes(1);
    expect(sendModelResultSpy.mock.calls[0]).toEqual(["m1", { type: "speak" }, "rq-1"]);
  });

  it("a null seam resolution sends nothing back into the round", async () => {
    resetRealtimeCaptures();
    const seam = mock((_req: ExperienceModelSeatRequest) => Promise.resolve<unknown | null>(null));
    renderModal({ realtime: { config: REALTIME_CONFIG }, onModelRequest: seam });
    await act(async () => {
      capturedOnModelRequest!({ seatId: "m1", prompt: {}, requestId: "rq-2" });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(seam).toHaveBeenCalledTimes(1);
    expect(sendModelResultSpy).not.toHaveBeenCalled();
  });

  it("a rejected seam reports via onError and sends nothing into the frame", async () => {
    resetRealtimeCaptures();
    const onError = mock((_reason: string) => {});
    const seam = mock((_req: ExperienceModelSeatRequest) => Promise.reject<unknown | null>(new Error("provider down")));
    renderModal({ realtime: { config: REALTIME_CONFIG }, onModelRequest: seam, onError });
    await act(async () => {
      capturedOnModelRequest!({ seatId: "m1", prompt: {}, requestId: "rq-3" });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBe("provider down");
    expect(sendModelResultSpy).not.toHaveBeenCalled();
  });

  it("an absent seam reports via onError and sends nothing", () => {
    resetRealtimeCaptures();
    const onError = mock((_reason: string) => {});
    renderModal({ realtime: { config: REALTIME_CONFIG }, onError });
    act(() => {
      capturedOnModelRequest!({ seatId: "m1", prompt: {}, requestId: "rq-4" });
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBe("model seam unavailable");
    expect(sendModelResultSpy).not.toHaveBeenCalled();
  });

  it("a round commit renders the trusted finished panel and fires the parent hook exactly once", () => {
    resetRealtimeCaptures();
    const onRoundCommit = mock((_claim: ExperienceRoundCommitClaim) => {});
    const { getByTestId, queryAllByTestId } = renderModal({
      realtime: { config: REALTIME_CONFIG },
      onRoundCommit,
    });
    expect(capturedOnRoundCommit).not.toBeNull();
    act(() => {
      capturedOnRoundCommit!(COMMIT_CLAIM);
    });
    // The trusted panel shows the status / score / summary from the claim.
    expect(getByTestId("experience-round-finished")).toBeTruthy();
    expect(getByTestId("experience-round-finished-status").textContent).toBe("experience_round_finished");
    expect(getByTestId("experience-round-finished-score").textContent).toContain("experience_round_score");
    expect(getByTestId("experience-round-finished-score").textContent).toContain("42");
    expect(getByTestId("experience-round-finished-summary").textContent).toBe("Board cleared");
    expect(onRoundCommit).toHaveBeenCalledTimes(1);
    expect(onRoundCommit.mock.calls[0]![0]).toBe(COMMIT_CLAIM);
    // A duplicate commit (stale frame event) neither re-fires nor re-renders.
    act(() => {
      capturedOnRoundCommit!({ status: "interrupted", finalState: {}, log: [] });
    });
    expect(onRoundCommit).toHaveBeenCalledTimes(1);
    expect(queryAllByTestId("experience-round-finished")).toHaveLength(1);
    expect(getByTestId("experience-round-finished-status").textContent).toBe("experience_round_finished");
  });

  it("an interrupted claim renders the abandoned status without score/summary", () => {
    resetRealtimeCaptures();
    const { getByTestId, queryByTestId, onClose } = renderModal({ realtime: { config: REALTIME_CONFIG } });
    act(() => {
      capturedOnRoundCommit!({ status: "interrupted", finalState: {}, log: [] });
    });
    expect(getByTestId("experience-round-finished-status").textContent).toBe("experience_round_interrupted");
    expect(queryByTestId("experience-round-finished-score")).toBeNull();
    expect(queryByTestId("experience-round-finished-summary")).toBeNull();
    // The panel's Close routes to the trusted close path.
    fireEvent.click(getByTestId("experience-round-finished-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
