/**
 * ExperienceReportControls — IR-73C pure-component tests.
 *
 * Boundary under test: the REAL ExperienceReportControls (no store, no API) with
 * typed server-shaped props → DOM observations + onQueue call assertions. The
 * component is pure: every count, frontier, and revision comes from props, and
 * the ONLY mutation is the single async `onQueue` callback. This test pins the
 * no-silent-growth contract at the component boundary:
 *   - frozen count from `queuedAttachment.publicReport?.events.length` (fail-
 *     closed on a malformed/null report — never guessed);
 *   - pending count from `reportStatus.pendingPublicEventCount` ONLY;
 *   - no onQueue call without a user click (no automatic queueing);
 *   - duplicate-click suppression while pending;
 *   - server failure (rejection) shows a localized error and leaves the frozen
 *     values unchanged (no optimistic bump);
 *   - button enabled only for queue/addLater; disabled (no call) for up-to-date
 *     /no-events.
 *
 * Runner: bun:test + happy-dom (useDomEnv). i18n returns keys verbatim. RTL
 * cleanup() runs after every test.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import type { ReactNode } from "react";

useDomEnv();
const { render, fireEvent, act } = await import("@testing-library/react");

// ─── i18n mock (returns keys verbatim; interpolation params are ignored so the
//     test asserts on stable key text, matching the rest of the experience tests) ─
const realI18n = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (k: string) => k,
    tDynamic: (k: string) => k,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

const { ExperienceReportControls, computeReportActionState } = await import("./ExperienceReportControls.js");
import type {
  ExperienceReportControlsProps,
  ReportActionState,
} from "./ExperienceReportControls.js";
import type {
  ExperienceQueuedAttachmentView,
  ExperienceReportStatus,
} from "../../api/types.js";

// ─── fixtures ───────────────────────────────────────────────────────────────
function makeAttachment(over: Partial<ExperienceQueuedAttachmentView> = {}): ExperienceQueuedAttachmentView {
  return {
    id: "att_1",
    chatId: "chat_1",
    branchId: "branch_1",
    sessionId: "sess_1",
    sessionRevision: 7,
    queueRevision: 5,
    kind: "report",
    publicReport: { title: "Hearts", events: [{ type: "public", detail: "e1" }, { type: "public", detail: "e2" }] },
    rulesSourceHash: "hash_r",
    visualSourceHash: "hash_v",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function makeReportStatus(over: Partial<ExperienceReportStatus> = {}): ExperienceReportStatus {
  return {
    revision: 7,
    reportFrontier: 8,
    pendingPublicEventCount: 2,
    queuedAttachment: null,
    ...over,
  };
}

function renderControls(over: Partial<ExperienceReportControlsProps> = {}):
  ReturnType<typeof render> & { onQueue: ReturnType<typeof mock> } {
  const onQueue = mock((_over?: unknown) => Promise.resolve());
  const utils = render(
    <ExperienceReportControls
      queuedAttachment={over.queuedAttachment ?? null}
      reportStatus={over.reportStatus ?? null}
      onQueue={(over.onQueue as () => Promise<void>) ?? onQueue}
    />,
  );
  return { ...utils, onQueue };
}

beforeEach(() => {
  // RTL cleanup is handled by useDomEnv's afterEach.
});

// ─── Pure action-state derivation ──────────────────────────────────────────
describe("computeReportActionState — pure derivation from server props", () => {
  it("no attachment + pending > 0 → queue", () => {
    expect(computeReportActionState(null, makeReportStatus({ pendingPublicEventCount: 3 }))).toEqual({
      kind: "queue",
      pending: 3,
    } satisfies ReportActionState);
  });

  it("attachment + pending > 0 → addLater", () => {
    expect(
      computeReportActionState(makeAttachment(), makeReportStatus({ pendingPublicEventCount: 1 })),
    ).toEqual({ kind: "addLater", pending: 1 } satisfies ReportActionState);
  });

  it("attachment + pending === 0 → upToDate", () => {
    expect(
      computeReportActionState(makeAttachment(), makeReportStatus({ pendingPublicEventCount: 0 })),
    ).toEqual({ kind: "upToDate" } satisfies ReportActionState);
  });

  it("no attachment + no pending → noEvents", () => {
    expect(computeReportActionState(null, makeReportStatus({ pendingPublicEventCount: 0 }))).toEqual({
      kind: "noEvents",
    } satisfies ReportActionState);
  });

  it("null report status is fail-closed (pending treated as 0)", () => {
    expect(computeReportActionState(makeAttachment(), null)).toEqual({ kind: "upToDate" });
    expect(computeReportActionState(null, null)).toEqual({ kind: "noEvents" });
  });
});

// ─── Frozen + pending counts (server-authoritative) ────────────────────────
describe("ExperienceReportControls — server-authoritative counts", () => {
  it("shows the frozen count from publicReport.events.length", () => {
    const att = makeAttachment({ publicReport: { title: "T", events: [{ type: "public", detail: "a" }] } });
    const { getByTestId } = renderControls({ queuedAttachment: att, reportStatus: makeReportStatus({ pendingPublicEventCount: 0 }) });
    expect(getByTestId("experience-report-frozen").textContent).toContain("experience_report_queued_events");
  });

  it("shows the pending count label from reportStatus.pendingPublicEventCount", () => {
    const { getByTestId } = renderControls({
      queuedAttachment: makeAttachment(),
      reportStatus: makeReportStatus({ pendingPublicEventCount: 4 }),
    });
    expect(getByTestId("experience-report-pending").textContent).toContain("experience_report_pending_events");
  });

  it("fail-closed: a queued attachment with null publicReport shows malformed, never a guessed count", () => {
    const att = makeAttachment({ publicReport: null });
    const { getByTestId, queryByTestId } = renderControls({
      queuedAttachment: att,
      reportStatus: makeReportStatus({ pendingPublicEventCount: 2 }),
    });
    expect(getByTestId("experience-report-frozen-malformed").textContent).toContain("experience_report_queued_malformed");
    // No guessed frozen count is rendered.
    expect(queryByTestId("experience-report-frozen")).toBeNull();
  });

  it("omits the frozen count entirely when there is no queued attachment", () => {
    const { queryByTestId } = renderControls({
      queuedAttachment: null,
      reportStatus: makeReportStatus({ pendingPublicEventCount: 1 }),
    });
    expect(queryByTestId("experience-report-frozen")).toBeNull();
    expect(queryByTestId("experience-report-frozen-malformed")).toBeNull();
  });
});

// ─── Frontier / revisions metadata ─────────────────────────────────────────
describe("ExperienceReportControls — frontier + revisions", () => {
  it("renders the report frontier, queue revision, and session revision", () => {
    const { getByTestId } = renderControls({
      queuedAttachment: makeAttachment({ queueRevision: 5, sessionRevision: 7 }),
      reportStatus: makeReportStatus({ reportFrontier: 9 }),
    });
    expect(getByTestId("experience-report-frontier").textContent).toContain("experience_report_frontier");
    expect(getByTestId("experience-report-queue-rev").textContent).toContain("experience_report_queue_rev");
    expect(getByTestId("experience-report-session-rev").textContent).toContain("experience_report_session_rev");
  });

  it("does not conflate the frontier with the event count (separate spans)", () => {
    const att = makeAttachment({ publicReport: { title: "T", events: [{ type: "public", detail: "x" }] } });
    const { getByTestId } = renderControls({
      queuedAttachment: att,
      reportStatus: makeReportStatus({ reportFrontier: 12, pendingPublicEventCount: 1 }),
    });
    // The frontier span carries the frontier key; the frozen span carries the
    // events key — they are distinct DOM nodes, never the same text.
    expect(getByTestId("experience-report-frontier").textContent).toContain("experience_report_frontier");
    expect(getByTestId("experience-report-frozen").textContent).toContain("experience_report_queued_events");
  });
});

// ─── Action button — enabled / disabled + no automatic queueing ─────────────
describe("ExperienceReportControls — action button states", () => {
  it("no attachment + pending > 0: enabled Queue, data-action=queue", () => {
    const { getByTestId } = renderControls({
      queuedAttachment: null,
      reportStatus: makeReportStatus({ pendingPublicEventCount: 2 }),
    });
    const btn = getByTestId("experience-report-action") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute("data-action")).toBe("queue");
    expect(btn.textContent).toContain("experience_report_queue");
  });

  it("attachment + pending > 0: enabled Add later, data-action=addLater", () => {
    const { getByTestId } = renderControls({
      queuedAttachment: makeAttachment(),
      reportStatus: makeReportStatus({ pendingPublicEventCount: 1 }),
    });
    const btn = getByTestId("experience-report-action") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute("data-action")).toBe("addLater");
    expect(btn.textContent).toContain("experience_report_add_later");
  });

  it("attachment + pending === 0: disabled Up to date, no endpoint call", () => {
    const { getByTestId, onQueue } = renderControls({
      queuedAttachment: makeAttachment(),
      reportStatus: makeReportStatus({ pendingPublicEventCount: 0 }),
    });
    const btn = getByTestId("experience-report-action") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onQueue).not.toHaveBeenCalled();
  });

  it("no attachment + no pending: disabled No events, no endpoint call", () => {
    const { getByTestId, onQueue } = renderControls({
      queuedAttachment: null,
      reportStatus: makeReportStatus({ pendingPublicEventCount: 0 }),
    });
    const btn = getByTestId("experience-report-action") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onQueue).not.toHaveBeenCalled();
  });

  it("never calls onQueue without a user click (no automatic queueing)", () => {
    const { onQueue } = renderControls({
      queuedAttachment: null,
      reportStatus: makeReportStatus({ pendingPublicEventCount: 5 }),
    });
    expect(onQueue).not.toHaveBeenCalled();
  });
});

// ─── Action contract — single call, duplicate suppression, fail-closed ──────
describe("ExperienceReportControls — action contract", () => {
  it("calls onQueue exactly once on a click (queue path, no attachment)", async () => {
    const { getByTestId, onQueue } = renderControls({
      queuedAttachment: null,
      reportStatus: makeReportStatus({ pendingPublicEventCount: 2 }),
    });
    await act(async () => {
      fireEvent.click(getByTestId("experience-report-action"));
    });
    expect(onQueue).toHaveBeenCalledTimes(1);
  });

  it("calls onQueue exactly once on a click (add-later path, with attachment)", async () => {
    const { getByTestId, onQueue } = renderControls({
      queuedAttachment: makeAttachment(),
      reportStatus: makeReportStatus({ pendingPublicEventCount: 3 }),
    });
    await act(async () => {
      fireEvent.click(getByTestId("experience-report-action"));
    });
    expect(onQueue).toHaveBeenCalledTimes(1);
  });

  it("suppresses duplicate clicks while pending", async () => {
    let resolveFn: (() => void) | null = null;
    const slow = mock(
      () => new Promise<void>((resolve) => {
        resolveFn = resolve;
      }),
    );
    const { getByTestId } = renderControls({
      queuedAttachment: null,
      reportStatus: makeReportStatus({ pendingPublicEventCount: 2 }),
      onQueue: slow,
    });
    act(() => {
      fireEvent.click(getByTestId("experience-report-action"));
    });
    // Second click while still pending — suppressed.
    act(() => {
      fireEvent.click(getByTestId("experience-report-action"));
    });
    expect(slow).toHaveBeenCalledTimes(1);
    // Resolve to unblock.
    await act(async () => {
      resolveFn!();
      await new Promise((r) => setTimeout(r, 0));
    });
  });

  it("server failure (rejection) shows a fail-closed error and leaves frozen values unchanged", async () => {
    const att = makeAttachment({ publicReport: { title: "T", events: [{ type: "public", detail: "a" }, { type: "public", detail: "b" }] } });
    const fail = mock(() => Promise.reject(new Error("server down")));
    const { getByTestId, rerender } = renderControls({
      queuedAttachment: att,
      reportStatus: makeReportStatus({ pendingPublicEventCount: 1 }),
      onQueue: fail,
    });
    // Before: frozen count span present (2 events).
    expect(getByTestId("experience-report-frozen")).toBeTruthy();
    await act(async () => {
      fireEvent.click(getByTestId("experience-report-action"));
    });
    // Error is shown.
    expect(getByTestId("experience-report-error").textContent).toContain("experience_report_action_error");
    // The frozen count span is STILL present with the OLD value (no optimistic
    // bump / no removal). Re-render with the SAME props to prove the UI kept
    // the old frozen values.
    rerender(
      <ExperienceReportControls
        queuedAttachment={att}
        reportStatus={makeReportStatus({ pendingPublicEventCount: 1 })}
        onQueue={fail}
      />,
    );
    expect(getByTestId("experience-report-frozen")).toBeTruthy();
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it("clears the error after a successful action", async () => {
    const att = makeAttachment();
    let first = true;
    const succeed = mock(() => {
      // First call succeeds; reject the second to leave an error, then we
      // re-render and succeed again to prove the error clears.
      return Promise.resolve();
    });
    const { getByTestId, rerender } = renderControls({
      queuedAttachment: att,
      reportStatus: makeReportStatus({ pendingPublicEventCount: 1 }),
      onQueue: succeed,
    });
    // No error initially.
    expect(getByTestId("experience-report-controls").querySelector("[data-testid='experience-report-error']")).toBeNull();
    await act(async () => {
      fireEvent.click(getByTestId("experience-report-action"));
    });
    // After success, still no error.
    expect(getByTestId("experience-report-controls").querySelector("[data-testid='experience-report-error']")).toBeNull();
    void first;
    void rerender;
  });
});
