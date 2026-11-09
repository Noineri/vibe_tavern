/**
 * AFP-14 (AGENT_FEED_PERFORMANCE_PLAN) — lifecycle pins for the shell's
 * paged-feed wiring. Two subjects, one per seam this unit adds:
 *
 * 1. `useAgentShellFeed` — the shell's ONE decision point between the legacy
 *    full-list path and the AFP-13 windowed lifecycle. The transport is the
 *    DI seam (T1): a scripted `transport.feed.page` double with a call log,
 *    no fetch mocks, no mock.module. Pages are built by the shared
 *    `agentFeedPageFromMessages` derivation (apps/web/test/agent-feed-page.ts
 *    — the ONE wire-schema fixture source; `seqBase` shifts page positions).
 * 2. `useAgentTurnActions` — the local-outcome wiring: a turn-originated
 *    delete carries the SERVER's `deletedMessageIds` into the paged feed's
 *    invalidation path; an assistant-row edit carries `editedMessageIds` +
 *    the `loadAround` re-read, both BEFORE the settle refresh. Legacy hosts
 *    (no `feedOutcome`) call neither.
 *
 * The plan's self-check pins map here as: old-page delete/edit (the outcome
 * seam tests), >window replacement turn (the settle-refresh bridge walk),
 * failure/cancel (non-destructive refresh failure + retry; late-page
 * rejection in the atomic-switch pin), reconnect (the detail-source `onStale`
 * → the same refresh path, with epoch adoption).
 *
 * L1: no absolute/out-of-repo paths; no global/env/registry/i18n mutation
 * (no real i18n init — the error paths' `getT()` only runs on transport
 * failures this file never triggers); every wait is a resolved-state
 * assertion through `waitFor`/manual promise release (parked deferrals, no
 * sleeps); no OS/order assumptions; no module mocks; DOM via `useDomEnv()`
 * (renderHook needs React DOM rendering); stable-state pins read at the
 * moment the invariant holds.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentFeedQuery, AgentFeedResponse, ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { useDomEnv } from "../../../../test/dom-env.js";
import { agentFeedPageFromMessages } from "../../../../test/agent-feed-page.js";
import { strictTestDouble } from "../../../../test/strict-test-double.js";
import type { AgentHostTransport } from "../../../lib/agent-host-registry.js";
import type { getAgentEventDetail, getAgentFeedPage } from "../../../api/agent-feed-api.js";
import type { AgentFeedLocalMutation } from "./agent-feed-reconcile.js";
import { useAgentShellFeed } from "./use-agent-shell-feed.js";
import { useAgentTurnActions } from "./use-agent-turn-actions.js";

useDomEnv();
const { act, renderHook, waitFor } = await import("@testing-library/react");

// ─── Scripted transport (the DI double) ──────────────────────────────────────

type PageScript = (threadId: string, query: AgentFeedQuery) => AgentFeedResponse | Promise<AgentFeedResponse>;

let script: PageScript | null = null;
const pageCalls: Array<{ threadId: string; query: AgentFeedQuery }> = [];

function fakeFeedPage(threadId: string, query: AgentFeedQuery = {}): Promise<AgentFeedResponse> {
  pageCalls.push({ threadId, query });
  const handler = script;
  if (handler === null) return Promise.reject(new Error("no script installed"));
  return Promise.resolve(handler(threadId, query));
}

// Detail reads are AFP-16's subject (their own suite) — present here only so
// the transport double satisfies the atomic `feed` member (page + detail,
// both or neither).
const fakeDetail: typeof getAgentEventDetail = async () => {
  throw new Error("detail reads are AFP-16's subject — not this suite");
};

// The transport type carries every built-in route; this suite exercises only
// `feed` (and the actions' deleteTurn/editMessage below), and the double is
// the DI seam, not a mock of the real client — so an unprovided route throws
// a labeled miss instead of answering `undefined` (the strict double seam).
const pagedTransport = strictTestDouble<AgentHostTransport>(
  { feed: { page: fakeFeedPage, detail: fakeDetail } },
  "pagedTransport",
);
const legacyTransport = {} as AgentHostTransport;

beforeEach(() => {
  script = null;
  pageCalls.length = 0;
});

afterAll(() => {
  script = null;
});

// ─── Fixtures (shared derivation: agentFeedPageFromMessages) ─────────────────

const BASE = Date.parse("2026-11-05T15:00:00.000Z");
const ts = (seq: number) => new Date(BASE + seq * 1000).toISOString();
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

function row(threadId: string, id: string, seq: number, over: Partial<ExperienceCopilotMessageWire> = {}): ExperienceCopilotMessageWire {
  return {
    id,
    threadId,
    role: "assistant",
    content: `body of ${id}`,
    toolCallsJson: null,
    toolCallId: null,
    reasoning: null,
    reasoningDurationMs: null,
    createdAt: ts(seq),
    ...over,
  };
}

/** A page over thread `t` covering rows m<from>..m<to> at seq offsets. */
function page(t: string, from: number, to: number, over: Partial<AgentFeedResponse> = {}): AgentFeedResponse {
  return agentFeedPageFromMessages(
    t,
    range(from, to).map((seq) => row(t, `m${seq}`, seq)),
    over,
    from,
  );
}

const idsOf = (messages: readonly ExperienceCopilotMessageWire[]) => messages.map((m) => m.id);

function renderShellFeed(transport: AgentHostTransport, threadId: string | null) {
  return renderHook(
    ({ thread }: { thread: string | null }) =>
      useAgentShellFeed({ kind: "experience", ownerKey: "own", threadId: thread, transport }),
    { initialProps: { thread: threadId } },
  );
}

// ─── 1. useAgentShellFeed — the shell's paged/legacy decision ────────────────

describe("useAgentShellFeed — host routing", () => {
  it("a legacy host (no transport.feed) never runs the paged lifecycle: no read, every seam absent", async () => {
    const { result } = renderShellFeed(legacyTransport, "A");
    // The resting session: the hook under a legacy transport passes
    // `threadId: null`, so not even the initial page runs.
    await act(async () => {
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(pageCalls).toHaveLength(0);
    expect(result.current.isPaged).toBe(false);
    expect(result.current.refresh).toBeUndefined();
    expect(result.current.outcome).toBeUndefined();
    expect(result.current.detailSource).toBeNull();
    expect(result.current.pageWindows).toBeUndefined();
  });

  it("a paged host mounts the newest window through the transport's page member", async () => {
    script = () => page("A", 0, 9);
    const { result } = renderShellFeed(pagedTransport, "A");
    await waitFor(() => expect(result.current.feed.feed).not.toBeNull());
    expect(pageCalls).toEqual([{ threadId: "A", query: {} }]);
    expect(idsOf(result.current.messages)).toEqual(range(0, 9).map((s) => `m${s}`));
    expect(result.current.isPaged).toBe(true);
    expect(result.current.refresh).toBeTypeOf("function");
    expect(result.current.outcome).toBeTypeOf("object");
  });

  it("a session change swaps the feed atomically — no frame of the new thread over the old rows", async () => {
    // A's page resolves immediately; B's is held until we release it.
    let releaseB: (() => void) | null = null;
    script = (threadId) => {
      if (threadId === "A") return page("A", 0, 4);
      return new Promise<AgentFeedResponse>((resolve) => {
        releaseB = () => resolve(page("B", 0, 2));
      });
    };
    const { result, rerender } = renderShellFeed(pagedTransport, "A");
    await waitFor(() => expect(result.current.feed.feed).not.toBeNull());
    expect(idsOf(result.current.messages)).toEqual(range(0, 4).map((s) => `m${s}`));

    // Switch: the feed resets SYNCHRONOUSLY — the gap frame is `null` (a
    // resting session), never A's rows under B's thread.
    rerender({ thread: "B" });
    expect(result.current.feed.feed).toBeNull();
    expect(result.current.messages).toHaveLength(0);

    await act(async () => {
      releaseB?.();
    });
    await waitFor(() => expect(result.current.feed.feed).not.toBeNull());
    expect(idsOf(result.current.messages)).toEqual(["m0", "m1", "m2"]);
    // The rows' wire threadId proves whose page they came from.
    expect(result.current.messages.every((m) => m.threadId === "B")).toBe(true);
  });

  it("a >window replacement turn settles through ONE refresh chain: newest read + the bounded bridge walk", async () => {
    // Initial: the loaded window covers m40..m59 (an old page, `hasOlder`).
    script = () => page("A", 40, 59, { hasOlder: true, cursors: { before: "cb-40", after: null } });
    const { result } = renderShellFeed(pagedTransport, "A");
    await waitFor(() => expect(result.current.feed.feed).not.toBeNull());
    expect(pageCalls).toHaveLength(1);

    // The settle: a replacement turn pushed a whole new window m100..m119
    // past the retained one. The refresh reads the newest, then bridges with
    // contiguous keyset pages (a real `before` cursor returns the positions
    // immediately older — never a page with internal holes). The walk stops
    // on OVERLAP with the fresh window below (agentFeedBridgeTarget's
    // `<= 0` check): the second bridge page [20..59] overlaps the retained
    // [40..59], proving continuity — mere seq adjacency never could (events
    // can sit between two adjacent messages).
    const callsBefore = pageCalls.length;
    script = (threadId, query) => {
      if (query.before === "cb-100") {
        return page("A", 60, 99, { hasOlder: true, cursors: { before: "cb-60", after: null } });
      }
      if (query.before === "cb-60") {
        return page("A", 20, 59, { hasOlder: true, cursors: { before: "cb-20", after: null } });
      }
      return page("A", 100, 119, { hasOlder: true, cursors: { before: "cb-100", after: null } });
    };
    act(() => {
      result.current.refresh?.();
    });
    await waitFor(() => expect(result.current.feed.refreshing).toBe(false));
    // Exactly the newest read + two contiguous bridge pages — never a
    // full-list fetch beside them (the ONE refresh path).
    expect(pageCalls.slice(callsBefore)).toEqual([
      { threadId: "A", query: {} },
      { threadId: "A", query: { before: "cb-100" } },
      { threadId: "A", query: { before: "cb-60" } },
    ]);
    expect(idsOf(result.current.messages)).toEqual(range(20, 119).map((s) => `m${s}`));
  });

  it("an old-page delete leaves its rows NOW through the outcome seam — no refetch needed", async () => {
    script = () => page("A", 0, 9);
    const { result } = renderShellFeed(pagedTransport, "A");
    await waitFor(() => expect(result.current.feed.feed).not.toBeNull());
    const callsBefore = pageCalls.length;

    act(() => {
      result.current.outcome?.applyLocalOutcome({ deletedMessageIds: ["m3", "m7"] });
    });
    expect(idsOf(result.current.messages)).toEqual(
      range(0, 9).map((s) => `m${s}`).filter((id) => id !== "m3" && id !== "m7"),
    );
    // A local outcome is an invalidation, not a read: no page request ran.
    expect(pageCalls.slice(callsBefore)).toHaveLength(0);
  });

  it("an old-page edit marks the row and re-reads its own neighborhood through loadAround", async () => {
    script = () => page("A", 0, 9);
    const { result } = renderShellFeed(pagedTransport, "A");
    await waitFor(() => expect(result.current.feed.feed).not.toBeNull());

    // The around read returns the EDITED row text in its neighborhood page.
    const callsBefore = pageCalls.length;
    script = () =>
      page("A", 0, 9, {
        messages: range(0, 9).map((seq) =>
          seq === 2 ? row("A", `m${seq}`, seq, { content: "edited text of m2" }) : row("A", `m${seq}`, seq),
        ),
      });
    act(() => {
      result.current.outcome?.applyLocalOutcome({ editedMessageIds: ["m2"] });
      result.current.outcome?.loadAround("m2");
    });
    await waitFor(() =>
      expect(pageCalls.slice(callsBefore)).toEqual([{ threadId: "A", query: { aroundMessageId: "m2" } }]),
    );
    await waitFor(() => expect(result.current.feed.loadingAround).toBe(false));
    // Non-destructive: the row survives with the fresh text, its neighbors
    // untouched.
    expect(result.current.messages.find((m) => m.id === "m2")?.content).toBe("edited text of m2");
    expect(result.current.messages).toHaveLength(10);
  });

  it("a refresh failure is non-destructive and retryable: rows stay, the error surfaces, the retry clears it", async () => {
    script = () => page("A", 0, 9);
    const { result } = renderShellFeed(pagedTransport, "A");
    await waitFor(() => expect(result.current.feed.feed).not.toBeNull());

    let failOnce = true;
    script = () => {
      if (failOnce) {
        failOnce = false;
        throw new Error("boom");
      }
      return page("A", 0, 9);
    };
    act(() => {
      result.current.refresh?.();
    });
    await waitFor(() => expect(result.current.feed.refreshError).toBe("boom"));
    // Rows, windows and flags stay exactly as the last applied page left them.
    expect(result.current.feed.refreshing).toBe(false);
    expect(idsOf(result.current.messages)).toEqual(range(0, 9).map((s) => `m${s}`));

    act(() => {
      result.current.refresh?.();
    });
    await waitFor(() => expect(result.current.feed.refreshError).toBeNull());
    expect(idsOf(result.current.messages)).toEqual(range(0, 9).map((s) => `m${s}`));
  });

  it("reconnect: the detail source carries the feed's epoch and its onStale routes through the SAME refresh path", async () => {
    script = () => page("A", 0, 9, { historyEpoch: 5 });
    const { result } = renderShellFeed(pagedTransport, "A");
    await waitFor(() => expect(result.current.feed.feed).not.toBeNull());

    const source = result.current.detailSource;
    expect(source).not.toBeNull();
    expect(source?.threadId).toBe("A");
    expect(source?.epoch).toBe(5);
    expect(source?.loadDetail).toBe(fakeDetail);

    // A detail 409 (history moved under the loaded window) never restarts
    // the detail loop eagerly — it notifies the lifecycle, which refreshes.
    const callsBefore = pageCalls.length;
    script = () => page("A", 0, 9, { historyEpoch: 7 });
    act(() => {
      source?.onStale();
    });
    await waitFor(() => expect(pageCalls.slice(callsBefore)).toEqual([{ threadId: "A", query: {} }]));
    await waitFor(() => expect(result.current.feed.refreshing).toBe(false));
    // The adopted epoch flows back into the detail source.
    expect(result.current.detailSource?.epoch).toBe(7);
  });
});

// ─── 2. useAgentTurnActions — the local-outcome wiring ───────────────────────

function turnActionsHarness(wireOutcome: boolean) {
  const applyLocalOutcome = mock((_mutation: AgentFeedLocalMutation) => {});
  const loadAround = mock((_messageId: string) => {});
  const onTurnSettled = mock((_ok: boolean) => {});
  const transport = strictTestDouble<AgentHostTransport>(
    {
      // The server names the deleted rows (AFP-7's delete wire) — the turn
      // actions carry THIS list, never the caller's single messageId guess.
      // deletedUserMessageId is part of the wire result; these turns delete
      // assistant rows only.
      deleteTurn: mock(async () => ({ deletedMessageIds: ["m4", "m5"], deletedUserMessageId: null })),
      // The edit's refreshed row — the hook discards it (the store refetches
      // through the settle refresh), so any valid wire row answers.
      editMessage: mock(async () => row("A", "m4", 4)),
    },
    "turnActionsTransport",
  );
  const noop = () => {};
  // CopilotStreamOpts' required pair — the actions never invoke them in
  // these flows (no stream is started); the shape only satisfies the type.
  const streamCallbacks = { onStatus: noop, onChunk: noop };
  const harness = renderHook(() =>
    useAgentTurnActions({
      kind: "experience",
      transport,
      threadId: "A",
      providerProfileId: "p1",
      onTurnSettled,
      threadMessages: [row("A", "m4", 4)],
      sendTurn: mock(async () => {}),
      buildStreamCallbacks: mock(() => streamCallbacks),
      ...(wireOutcome ? { feedOutcome: { applyLocalOutcome, loadAround } } : {}),
      turnState: {
        isSendingRef: { current: false },
        abortRef: { current: null },
        setIsSending: noop,
        clearLiveStreamText: noop,
        setPendingAskAnswer: noop,
        setPendingPermissionAnswer: noop,
        setTurnFailure: noop,
        flushDeltaBuffer: noop,
      },
    }),
  );
  return { harness, applyLocalOutcome, loadAround, onTurnSettled };
}

describe("useAgentTurnActions — local-outcome wiring", () => {
  it("a delete carries the SERVER's deleted ids into the feed's invalidation path, then settles", async () => {
    const { harness, applyLocalOutcome, loadAround, onTurnSettled } = turnActionsHarness(true);
    await act(async () => {
      await harness.result.current.handleDeleteTurn("m4", true);
    });
    expect(applyLocalOutcome).toHaveBeenCalledTimes(1);
    expect(applyLocalOutcome).toHaveBeenCalledWith({ deletedMessageIds: ["m4", "m5"] });
    // An invalidation, not a neighborhood re-read: loadAround stays quiet.
    expect(loadAround).not.toHaveBeenCalled();
    expect(onTurnSettled).toHaveBeenCalledWith(true);
  });

  it("an assistant-row edit marks the row, re-reads its neighborhood, THEN settles", async () => {
    const { harness, applyLocalOutcome, loadAround, onTurnSettled } = turnActionsHarness(true);
    let ok = false;
    await act(async () => {
      ok = await harness.result.current.handleEditAssistant("m2", "fresh text");
    });
    expect(ok).toBe(true);
    expect(applyLocalOutcome).toHaveBeenCalledWith({ editedMessageIds: ["m2"] });
    expect(loadAround).toHaveBeenCalledWith("m2");
    expect(onTurnSettled).toHaveBeenCalledWith(true);
  });

  it("a legacy host (no feedOutcome seam) settles exactly as before — no outcome calls", async () => {
    const { harness, onTurnSettled } = turnActionsHarness(false);
    await act(async () => {
      await harness.result.current.handleDeleteTurn("m4", true);
    });
    expect(onTurnSettled).toHaveBeenCalledWith(true);
  });
});
