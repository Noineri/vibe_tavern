/**
 * AFP-18 (AGENT_FEED_PERFORMANCE_PLAN, Wave 4 item 1): structural performance
 * pins for the paged agent feed — the same seams the earlier suites exercise
 * (transport DI into `useAgentFeed`, the real list, the real detail cache),
 * asserting STRUCTURAL counts and references, never wall-clock timing:
 *  - a 10k-record thread is served and mounted in bounded pages (policy
 *    100 initial / 40 older), never fetched or mounted whole;
 *  - a live delta burst rebuilds neither the historical model nor historical
 *    bodies, and an equal-row settle refresh costs ONE newest read while
 *    retaining row references and DOM identity ("equal refreshed rows retain
 *    references");
 *  - an oversized frozen `rp_sync` body crosses the seam only as requested
 *    bounded detail slices, and the shared cache returns under its entry/byte
 *    budget once its pages are unobserved.
 * Mounted bounds count VIRTUAL RENDER ITEMS (`[data-scroller-message-id]`)
 * plus nothing else — arbitrary user content inside a row may hold any number
 * of DOM descendants, which is explicitly not the bounded quantity.
 * L1: (1) repo-relative imports only; (2) no global/env/registry/i18n
 * mutations — the two live-stream stores are captured and restored in
 * afterAll; (3) resolved-state assertions and parked promise waits, no
 * sleeps; (4) no OS/path-order assumptions; (5) real hook/list/cache through
 * transport DI, no module mocks beyond the shared markdown seam every
 * agent-shell DOM suite registers, transparent spies restored in afterEach;
 * (6) invariants read at committed states (waitFor a row/alert, then count);
 * (7) no DB/build/heavy setup — synthetic in-memory fixtures only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { AgentEventDetailResponse, AgentFeedResponse, ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import type { getAgentEventDetail, getAgentFeedPage } from "../../../api/agent-feed-api.js";
import { agentFeedPageFromMessages } from "../../../../test/agent-feed-page.js";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installAgentMessageMarkdownSeam } from "../../../../test/agent-message-markdown-seam.js";
import { useAgentFeed, type UseAgentFeedResult } from "./use-agent-feed.js";
import { AgentFeedFeedbackProvider } from "./agent-feed-scroller.js";
import { AgentEventDetail } from "./agent-event-detail.js";
import { createAgentEventDetailCache } from "./agent-event-detail-cache.js";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";
import { useAgentLiveStreamStore } from "../../../stores/agent-live-stream-store.js";

useDomEnv({ failOnNetwork: true });
installAgentMessageMarkdownSeam();
const { act, fireEvent, render, waitFor } = await import("@testing-library/react");
const { AgentMessageList } = await import("./AgentMessageList.js");
const feedModel = await import("./agent-feed-model.js");
const markdown = await import("../../../lib/markdown.js");

const THREAD = "T";
const TOTAL = 10_000;
const INITIAL_RECORDS = 100;
const OLDER_RECORDS = 40;

const originalTurn = useAgentTurnStore.getState();
const originalLive = useAgentLiveStreamStore.getState();
let restoreProbes = () => {};
afterEach(() => restoreProbes());
beforeAll(async () => { await import("../../build/editors/copilot/experience-agent-host.js"); });
beforeEach(() => {
  useAgentTurnStore.setState({ turnsByThread: {}, feedByThread: {} });
  useAgentLiveStreamStore.setState({ liveByThread: {} });
});
afterAll(() => {
  restoreProbes();
  useAgentTurnStore.setState(originalTurn, true);
  useAgentLiveStreamStore.setState(originalLive, true);
});

function largeThread(): ExperienceCopilotMessageWire[] {
  return Array.from({ length: TOTAL }, (_, i) => ({
    id: `m${i}`, threadId: THREAD, role: i % 2 === 0 ? "user" as const : "assistant" as const,
    content: `Body m${i}`, toolCallsJson: null, toolCallId: null, reasoning: null, reasoningDurationMs: null,
    createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
  }));
}

/** The policy-shaped paged server double: newest serves the initial 100, each
 *  `before` cursor serves the 40 records strictly below it. `served` records
 *  how many rows CROSSED the seam per call — the quantity the whole plan
 *  bounds (never the thread's full 10k). */
function makePagedServer(all: ExperienceCopilotMessageWire[]): { load: typeof getAgentFeedPage; served: number[] } {
  const served: number[] = [];
  const load: typeof getAgentFeedPage = async (_threadId, query) => {
    const upper = query?.before === undefined ? all.length : Number(query.before.slice("before-".length));
    const size = query?.before === undefined ? INITIAL_RECORDS : OLDER_RECORDS;
    const lower = Math.max(0, upper - size);
    const rows = all.slice(lower, upper);
    served.push(rows.length);
    return agentFeedPageFromMessages(THREAD, rows, {
      hasOlder: lower > 0,
      cursors: { before: lower > 0 ? `before-${lower}` : null, after: null },
    }, lower);
  };
  return { load, served };
}

let latest!: UseAgentFeedResult;
function FeedHarness({ load, busy = false }: { load: typeof getAgentFeedPage; busy?: boolean }) {
  const feed = useAgentFeed({ kind: "experience", ownerKey: "owner", threadId: THREAD, feedPage: load });
  latest = feed;
  return <div style={{ display: "flex", height: 500 }}>
    <AgentFeedFeedbackProvider feed={feed}>
      <AgentMessageList kind="experience" threadId={THREAD} pageWindows={feed.feed?.windows}
        pendingUserContent="" isSending={busy} emptyTitle="No history" />
    </AgentFeedFeedbackProvider>
  </div>;
}
const olderButton = (view: ReturnType<typeof render>) => view.getByRole("button", { name: "agent_feed_load_older" });
const mountedItems = (view: ReturnType<typeof render>) => view.container.querySelectorAll("[data-scroller-message-id]").length;

describe("AFP-18 paged feed performance structure", () => {
  it("serves and mounts a 10k-record thread in bounded pages, never the whole history", async () => {
    const modelProbe = spyOn(feedModel, "memoizedAgentFeedModel");
    restoreProbes = () => modelProbe.mockRestore();
    const { load, served } = makePagedServer(largeThread());
    const view = render(<FeedHarness load={load} />);
    await waitFor(() => expect(view.getByText(`Body m${TOTAL - 1}`)).toBeDefined());
    expect(served).toEqual([INITIAL_RECORDS]);
    const initialModel = modelProbe.mock.results.at(-1)?.value as ReturnType<typeof feedModel.memoizedAgentFeedModel>;
    expect(initialModel.visibleMessages).toHaveLength(INITIAL_RECORDS);
    expect(mountedItems(view)).toBeLessThanOrEqual(100); // the mounted suffix, not 10k virtual items
    for (let older = 1; older <= 3; older++) {
      await waitFor(() => expect((olderButton(view) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(olderButton(view));
      await waitFor(() => expect(served).toHaveLength(1 + older));
    }
    expect(served).toEqual([100, 40, 40, 40]);
    // Explicit requests only: settling drains no further page reads.
    await act(async () => {});
    expect(served).toHaveLength(4);
    const model = modelProbe.mock.results.at(-1)?.value as ReturnType<typeof feedModel.memoizedAgentFeedModel>;
    expect(model.visibleMessages).toHaveLength(220);
    expect(model.visibleMessages[0]!.message.id).toBe("m9780");
    expect(model.visibleMessages.at(-1)!.message.id).toBe("m9999");
    expect(view.getByText("Body m9900")).toBeDefined(); // oldest SUFFIX row still mounted
    expect(mountedItems(view)).toBeLessThanOrEqual(100); // 220 loaded, 100 mounted
  });

  it("a live delta burst over the paged path reruns no historical model or body work", async () => {
    const modelProbe = spyOn(feedModel, "memoizedAgentFeedModel");
    const bodyProbe = spyOn(markdown, "Markdown");
    restoreProbes = () => { modelProbe.mockRestore(); bodyProbe.mockRestore(); };
    const { load } = makePagedServer(largeThread());
    const view = render(<FeedHarness load={load} busy />);
    await waitFor(() => expect(view.getByText(`Body m${TOTAL - 1}`)).toBeDefined());
    expect(modelProbe.mock.calls.length).toBeGreaterThan(0); // the probe fires (R11)
    const modelCalls = modelProbe.mock.calls.length;
    const historicalBodies = () => bodyProbe.mock.calls.filter(([props]) => props.text.startsWith("Body m")).length;
    const bodiesBefore = historicalBodies();
    expect(bodiesBefore).toBeGreaterThan(0);
    const viewport = view.container.querySelector("[data-virtuoso-scroller]");
    for (let i = 0; i < 20; i++) {
      act(() => {
        useAgentTurnStore.getState().appendTextDelta("experience", THREAD, "live ");
        useAgentLiveStreamStore.getState().appendLiveDeltas("experience", THREAD, { text: "live " });
      });
    }
    expect(view.container.textContent?.includes("live live")).toBe(true); // the burst landed
    expect(modelProbe.mock.calls).toHaveLength(modelCalls);
    expect(historicalBodies()).toBe(bodiesBefore);
    expect(view.container.querySelector("[data-virtuoso-scroller]")).toBe(viewport);
  });

  it("an equal-row settle refresh costs one newest read and retains row references and DOM identity", async () => {
    const modelProbe = spyOn(feedModel, "memoizedAgentFeedModel");
    restoreProbes = () => modelProbe.mockRestore();
    const all = largeThread();
    let calls = 0;
    // The SAME row objects come back every read — what an unchanged-thread
    // settle refresh actually receives from the server.
    const load: typeof getAgentFeedPage = async () => {
      calls++;
      return agentFeedPageFromMessages(THREAD, all.slice(-INITIAL_RECORDS), {
        hasOlder: true, cursors: { before: "before-9900", after: null },
      }, TOTAL - INITIAL_RECORDS);
    };
    const view = render(<FeedHarness load={load} />);
    await waitFor(() => expect(view.getByText("Body m9950")).toBeDefined());
    const before = view.getByText("Body m9950");
    const modelBefore = modelProbe.mock.results.at(-1)?.value as ReturnType<typeof feedModel.memoizedAgentFeedModel>;
    const rowsBefore = modelBefore.visibleMessages.map((entry) => entry.message);
    act(() => latest.refresh());
    await waitFor(() => expect(calls).toBe(2));
    await waitFor(() => expect(view.getByText("Body m9950")).toBeDefined());
    const modelAfter = modelProbe.mock.results.at(-1)?.value as ReturnType<typeof feedModel.memoizedAgentFeedModel>;
    const rowsAfter = modelAfter.visibleMessages.map((entry) => entry.message);
    expect(rowsAfter.every((row, index) => row === rowsBefore[index])).toBe(true);
    expect(view.getByText("Body m9950")).toBe(before);
    expect(calls).toBe(2); // newest read only — the overlapping page needs no bridge walk
  });
});

describe("AFP-18 oversized frozen-event detail structure", () => {
  const PAGE_ITEMS = 50;
  const FROZEN_ITEMS = 5_500;
  function detailPage(offset: number): AgentEventDetailResponse {
    return {
      kind: "rp_sync", threadId: THREAD, eventId: "E", epoch: 1, fromPosition: 0, toPosition: FROZEN_ITEMS,
      offset,
      messages: Array.from({ length: PAGE_ITEMS }, (_, i) => ({
        id: `f${offset + i}`, position: offset + i, role: "assistant" as const, authorName: null,
        variantId: null, model: null, preset: null, text: `Frozen snapshot ${offset + i} ` + "x".repeat(160),
      })),
      nextCursor: offset + PAGE_ITEMS < FROZEN_ITEMS ? `cursor-${offset + PAGE_ITEMS}` : null,
    };
  }

  it("crosses the seam only as requested 50-item slices and returns under its cache budget", async () => {
    const pageBytes = new TextEncoder().encode(JSON.stringify(detailPage(0))).byteLength;
    const cache = createAgentEventDetailCache({ maxEntries: 4, maxBytes: pageBytes * 2 });
    const servedItems: number[] = [];
    const loadDetail: typeof getAgentEventDetail = async (_threadId, _eventId, cursor) => {
      const offset = cursor === undefined ? 0 : Number(cursor.slice("cursor-".length));
      servedItems.push(PAGE_ITEMS);
      return detailPage(offset);
    };
    const source = { threadId: THREAD, epoch: 1, cache, loadDetail };
    const view = render(<AgentEventDetail source={source} eventId="E"
      renderPage={(page) => {
        if (page.kind !== "rp_sync") return null;
        return <ul data-detail-page={page.offset}>{page.messages.map((row) => <li key={row.id}>{row.text.slice(0, 16)}</li>)}</ul>;
      }} />);
    const renderedPages = () => view.container.querySelectorAll("[data-detail-page]").length;
    await waitFor(() => expect(view.getAllByRole("listitem")).toHaveLength(PAGE_ITEMS));
    for (let continuation = 1; continuation <= 5; continuation++) {
      fireEvent.click(view.getByRole("button", { name: "agent_event_detail_more" }));
      await waitFor(() => expect(view.getAllByRole("listitem")).toHaveLength(PAGE_ITEMS * (continuation + 1)));
    }
    // 300 of 5500 frozen items crossed the seam and rendered — never the body.
    expect(servedItems).toHaveLength(6);
    expect(servedItems.reduce((sum, n) => sum + n, 0)).toBe(300);
    expect(renderedPages()).toBe(6);
    // Observed pages may exceed the retention budget by design…
    expect(cache.stats().entries).toBe(6);
    view.unmount();
    // …once unobserved, the cache returns under its entry/byte budget.
    const stats = cache.stats();
    expect(stats.retainedEntries).toBeLessThanOrEqual(4);
    expect(stats.retainedBytes).toBeLessThanOrEqual(pageBytes * 2);
    expect(stats.retainedEntries).toBeGreaterThan(0); // recent slices stay warm for a reopen
  });
});
