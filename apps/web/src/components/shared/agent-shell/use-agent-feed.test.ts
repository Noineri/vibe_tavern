/**
 * AFP-13 — pins for the feed lifecycle hook (`use-agent-feed.ts`): the
 * session-atomic initial commit, settle bridging over >100-record appends,
 * A→B→A late-result rejection, error/retry with a non-destructive failure
 * surface, single-flight older pages, overlap refresh with stable row
 * references, the typed stale-window 409 (invalidation + reading-neighborhood
 * revalidation), around-island reads and local-outcome invalidation.
 *
 * The transport is the hook's DI seam: a scripted `feedPage` double with a
 * call log (T1 — no fetch mocks, no mock.module); every page is a literal
 * AFP-7 `AgentFeedResponse`. DOM via `useDomEnv()` (renderHook needs React
 * DOM rendering); RTL auto-cleanup drains between tests.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { AgentFeedBoundary, AgentFeedQuery, AgentFeedOrderPosition, AgentFeedResponse, ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { useDomEnv } from "../../../../test/dom-env.js";
import { AgentFeedStaleError } from "../../../api/agent-feed-api.js";
import { useAgentFeed } from "./use-agent-feed.js";

useDomEnv();
const { act, renderHook, waitFor } = await import("@testing-library/react");

// ─── Scripted transport (the DI double) ──────────────────────────────────────

let script: ((threadId: string, query: AgentFeedQuery) => AgentFeedResponse | Promise<AgentFeedResponse>) | null = null;
const calls: Array<{ threadId: string; query: AgentFeedQuery }> = [];

function fakeFeedPage(threadId: string, query: AgentFeedQuery = {}): Promise<AgentFeedResponse> {
  calls.push({ threadId, query });
  const handler = script;
  if (handler === null) return Promise.reject(new Error("no script installed"));
  return Promise.resolve(handler(threadId, query));
}

beforeEach(() => {
  script = null;
  calls.length = 0;
});

afterAll(() => {
  script = null;
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BASE = Date.parse("2026-11-05T14:00:00.000Z");
const ts = (seq: number) => new Date(BASE + seq * 1000).toISOString();
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const BOUNDARY: AgentFeedBoundary = {
  startsMidTurn: false,
  endsMidTurn: false,
  turnOpenerMessageId: null,
  continuedToolCalls: [],
  lastUserMessageId: null,
  digest: { totalInThread: 0, unloadedOlderCount: 0, lastAnchor: null },
};

function message(id: string, seq: number, over: Partial<ExperienceCopilotMessageWire> = {}): ExperienceCopilotMessageWire {
  return {
    id,
    threadId: "A",
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

function msgPos(id: string, seq: number): AgentFeedOrderPosition {
  return { record: "message", seq, createdAt: ts(seq), id };
}

/** A newest/`before` page over `seqs` of thread "A" (threadId overridable). */
function seqPage(seqs: number[], over: Partial<AgentFeedResponse> = {}): AgentFeedResponse {
  const first = seqs[0];
  const last = seqs[seqs.length - 1];
  return {
    threadId: "A",
    historyEpoch: 0,
    head: last === undefined ? null : msgPos(`m${last}`, last),
    range: {
      oldest: first === undefined ? null : msgPos(`m${first}`, first),
      newest: last === undefined ? null : msgPos(`m${last}`, last),
    },
    messages: seqs.map((seq) => message(`m${seq}`, seq)),
    events: [],
    hasOlder: first !== undefined && first > 0,
    hasNewer: false,
    cursors: { before: first !== undefined && first > 0 ? `cb-${first}` : null, after: null },
    boundary: BOUNDARY,
    ...over,
  };
}

function renderFeed(threadId: string | null) {
  return renderHook(
    ({ thread }: { thread: string | null }) =>
      useAgentFeed({ kind: "sidechat-ooc", ownerKey: "own", threadId: thread, feedPage: fakeFeedPage }),
    { initialProps: { thread: threadId } },
  );
}

const idsOf = (result: { messages: readonly ExperienceCopilotMessageWire[] }) => result.messages.map((m) => m.id);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("use-agent-feed — initial load & session identity", () => {
  it("mounts the session's first page atomically: loading → the newest window", async () => {
    script = () => seqPage([8, 9, 10]);
    const { result } = renderFeed("A");
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(idsOf(result.current)).toEqual(["m8", "m9", "m10"]);
    expect(result.current.feed?.windows).toHaveLength(1);
    expect(result.current.error).toBeNull();
    // The initial read carries no paging params:
    expect(calls).toEqual([{ threadId: "A", query: {} }]);
  });

  it("a null thread is a resting session — no read, no loading", async () => {
    const { result } = renderFeed(null);
    expect(result.current.loading).toBe(false);
    expect(result.current.feed).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("a foreign-thread response never stitches rows into this session", async () => {
    script = () => seqPage([1, 2], { threadId: "B" });
    const { result } = renderFeed("A");
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.feed?.threadId).toBe("A");
    expect(result.current.feed?.windows).toHaveLength(0);
    expect(result.current.messages).toEqual([]);
  });

  it("A→B→A: the B page resolving after both switches is rejected — no B rows under A", async () => {
    script = (_threadId) => seqPage([1, 2, 3]);
    const { result, rerender } = renderFeed("A");
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(idsOf(result.current)).toEqual(["m1", "m2", "m3"]);

    let resolveB!: (page: AgentFeedResponse) => void;
    script = (threadId) => {
      if (threadId === "B") return new Promise<AgentFeedResponse>((resolve) => { resolveB = resolve; });
      return seqPage([1, 2, 3]);
    };
    rerender({ thread: "B" }); // B's initial read parks
    expect(result.current.loading).toBe(true);
    rerender({ thread: "A" }); // back to A before B ever landed
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      resolveB(seqPage([1, 2], { threadId: "B" }));
    });
    expect(result.current.feed?.threadId).toBe("A");
    expect(idsOf(result.current)).toEqual(["m1", "m2", "m3"]); // exactly A's rows
  });
});

describe("use-agent-feed — settle refresh, bridging and reconciliation", () => {
  it("a >100-record settle bridges with several bounded before-walks — no gap, no duplicates", async () => {
    script = () => seqPage(range(131, 230)); // the retained newest window
    const { result } = renderFeed("A");
    await waitFor(() => expect(result.current.loading).toBe(false));

    // The settle appended 200 records (231..430): the newest page is
    // [331..430], leaving a 100-record interval to bridge at 40 per page.
    script = (_threadId, query) => {
      if (query.before !== undefined) {
        const anchor = Number(query.before.slice(3)); // "cb-331" → 331
        return seqPage(range(anchor - 40, anchor - 1));
      }
      return seqPage(range(331, 430));
    };
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.refreshing).toBe(false));

    const ids = idsOf(result.current);
    expect(ids).toHaveLength(300); // 131..430 — continuous
    expect(new Set(ids).size).toBe(300); // deduped across overlaps
    expect(ids[0]).toBe("m131");
    expect(ids[299]).toBe("m430");
    expect(result.current.feed?.windows).toHaveLength(1); // coalesced into one covered range
    // ONE newest read + exactly three bridge pages (100 records / 40 per page):
    expect(calls.filter((call) => call.query.before !== undefined)).toHaveLength(3);
    expect(result.current.refreshError).toBeNull();
  });

  it("an overlapping refresh dedupes, swaps edited rows and keeps unchanged row REFERENCES", async () => {
    script = () => seqPage([1, 2, 3, 4, 5]);
    const { result } = renderFeed("A");
    await waitFor(() => expect(result.current.loading).toBe(false));
    const retainedRow = result.current.messages[0]!; // m1

    const edited = seqPage([1, 2, 3, 4, 5, 6]);
    edited.messages[2] = { ...edited.messages[2]!, content: "edited body" };
    script = () => edited;
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.refreshing).toBe(false));

    expect(idsOf(result.current)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
    expect(result.current.messages[0]).toBe(retainedRow); // stable reference
    expect(result.current.messages[2]!.content).toBe("edited body"); // swapped in
    expect(result.current.feed?.windows).toHaveLength(1);
  });

  it("the typed stale 409 invalidates, revalidates the reading neighborhood and reconciles the retry", async () => {
    script = () => seqPage([1, 2, 3, 4, 5]);
    const { result } = renderFeed("A");
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      result.current.setReadingAnchor("m2"); // AFP-14 wires the reader's position
    });

    let staleThrown = false;
    script = (_threadId, query) => {
      if (!staleThrown && query.before === undefined && query.aroundMessageId === undefined) {
        staleThrown = true;
        return Promise.reject(new AgentFeedStaleError("stale window", "AGENT_FEED_STALE_WINDOW", 7));
      }
      if (query.aroundMessageId !== undefined) return seqPage([1, 2, 3], { historyEpoch: 7 });
      const retry = seqPage([1, 2, 3, 4, 6], { historyEpoch: 7 }); // m5 deleted, m6 appended
      return retry;
    };
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.refreshing).toBe(false));

    expect(calls.some((call) => call.query.aroundMessageId === "m2")).toBe(true); // the neighborhood re-read ran
    expect(idsOf(result.current)).toEqual(["m1", "m2", "m3", "m4", "m6"]); // m5's deletion reconciled
    expect(result.current.feed?.historyEpoch).toBe(7);
    expect(result.current.feed?.windows.every((window) => !window.stale)).toBe(true); // revalidated
    expect(result.current.refreshError).toBeNull();
  });

  it("a plain refresh failure surfaces as refreshError and empties nothing", async () => {
    script = () => seqPage([1, 2, 3], { hasOlder: false, cursors: { before: null, after: null } });
    const { result } = renderFeed("A");
    await waitFor(() => expect(result.current.loading).toBe(false));
    script = () => Promise.reject(new Error("gateway down"));
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.refreshError).toBe("gateway down"));
    expect(idsOf(result.current)).toEqual(["m1", "m2", "m3"]);
    expect(result.current.canLoadOlder).toBe(false); // thread start was already reached
  });

  it("a destructive epoch change stales untouched windows; loadOlder routes through around-revalidation", async () => {
    script = () => seqPage([10, 11, 12]);
    const { result } = renderFeed("A");
    await waitFor(() => expect(result.current.loading).toBe(false));
    script = (_threadId, query) =>
      query.aroundMessageId !== undefined ? seqPage([30, 31, 32]) : seqPage([10, 11, 12]);
    await act(async () => {
      result.current.loadAround("m31"); // a fresh island above the loaded window
    });
    await waitFor(() => expect(result.current.loadingAround).toBe(false));
    expect(result.current.feed?.windows).toHaveLength(2);

    // The settle re-read touched only the island's range under a bumped epoch.
    script = (_threadId, query) => {
      if (query.aroundMessageId !== undefined) return seqPage([8, 9], { historyEpoch: 1 });
      return seqPage([30, 31, 32], { historyEpoch: 1 });
    };
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    const [older, head] = result.current.feed?.windows ?? [];
    expect(older!.stale).toBe(true); // untouched by the epoch-1 page, rows retained
    expect(older!.messages).toHaveLength(3);
    expect(head!.stale).toBe(false);

    // loadOlder on the stale oldest window revalidates its neighborhood
    // instead of paging from a dead cursor:
    await act(async () => {
      result.current.loadOlder();
    });
    await waitFor(() => expect(result.current.loadingAround).toBe(false));
    expect(calls.some((call) => call.query.aroundMessageId === "m10")).toBe(true);
    expect(idsOf(result.current)).toEqual(["m8", "m9", "m10", "m11", "m12", "m30", "m31", "m32"]);
  });
});

describe("use-agent-feed — older pages, around reads, local outcomes", () => {
  it("loadOlder is single-flight per cursor; a failure preserves rows and retryability", async () => {
    script = () => seqPage([10, 11, 12]);
    const { result } = renderFeed("A");
    await waitFor(() => expect(result.current.loading).toBe(false));

    let failOnce = true;
    script = (_threadId, query) => {
      if (query.before !== undefined) {
        if (failOnce) {
          failOnce = false;
          return Promise.reject(new Error("offline"));
        }
        return seqPage([7, 8, 9]);
      }
      return seqPage([10, 11, 12]);
    };
    await act(async () => {
      result.current.loadOlder();
      result.current.loadOlder(); // same cursor — must not issue a second fetch
    });
    await waitFor(() => expect(result.current.olderError).toBe("offline"));
    expect(calls.filter((call) => call.query.before !== undefined)).toHaveLength(1);
    expect(idsOf(result.current)).toEqual(["m10", "m11", "m12"]); // nothing emptied
    expect(result.current.canLoadOlder).toBe(true); // hasOlder survived the failure

    await act(async () => {
      result.current.loadOlder(); // retry — the cursor is fetchable again
    });
    await waitFor(() => expect(result.current.loadingOlder).toBe(false));
    expect(idsOf(result.current)).toEqual(["m7", "m8", "m9", "m10", "m11", "m12"]);
    expect(result.current.olderError).toBeNull();
    expect(result.current.feed?.windows).toHaveLength(1); // coalesced with the target
  });

  it("an around read inserts a bounded island — no eager bridging toward it", async () => {
    script = () => seqPage([10, 11, 12]);
    const { result } = renderFeed("A");
    await waitFor(() => expect(result.current.loading).toBe(false));
    script = (_threadId, query) =>
      query.aroundMessageId !== undefined ? seqPage([20, 21, 22]) : seqPage([10, 11, 12]);
    await act(async () => {
      result.current.loadAround("m21");
    });
    await waitFor(() => expect(result.current.loadingAround).toBe(false));
    expect(idsOf(result.current)).toEqual(["m10", "m11", "m12", "m20", "m21", "m22"]);
    expect(result.current.feed?.windows).toHaveLength(2);
    expect(calls.filter((call) => call.query.before !== undefined)).toHaveLength(0); // no bridge chase
    expect(result.current.canLoadOlder).toBe(true); // the oldest window's cursor is untouched
  });

  it("a local deletion leaves immediately and the refresh reconciles the window clear", async () => {
    script = () => seqPage([1, 2, 3, 4, 5]);
    const { result } = renderFeed("A");
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.applyLocalOutcome({ deletedMessageIds: ["m3"] });
    });
    expect(idsOf(result.current)).toEqual(["m1", "m2", "m4", "m5"]); // gone NOW
    expect(result.current.feed?.windows[0]!.stale).toBe(true); // cursors dead until revalidated

    script = () => seqPage([1, 2, 4, 5], { historyEpoch: 1 });
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(idsOf(result.current)).toEqual(["m1", "m2", "m4", "m5"]);
    expect(result.current.feed?.windows.every((window) => !window.stale)).toBe(true);
    expect(result.current.feed?.historyEpoch).toBe(1);
  });

  it("an initial-load failure surfaces for retry without inventing state", async () => {
    script = () => Promise.reject(new Error("boom"));
    const { result } = renderFeed("A");
    await waitFor(() => expect(result.current.error).toBe("boom"));
    expect(result.current.loading).toBe(false);
    expect(result.current.feed).toBeNull();
    expect(result.current.messages).toEqual([]);

    script = () => seqPage([4, 5, 6]);
    await act(async () => {
      result.current.retry();
    });
    await waitFor(() => expect(idsOf(result.current)).toEqual(["m4", "m5", "m6"]));
    expect(result.current.error).toBeNull();
  });
});
