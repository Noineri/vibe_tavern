import { describe, expect, it, spyOn } from "bun:test";
import type { AgentEventDetailResponse, AgentFeedResponse, ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import type { getAgentFeedPage } from "../../../api/agent-feed-api.js";
import { AgentFeedStaleError } from "../../../api/agent-feed-api.js";
import { agentFeedPageFromMessages } from "../../../../test/agent-feed-page.js";
import { useDomEnv } from "../../../../test/dom-env.js";
import { useAgentFeed, type UseAgentFeedResult } from "./use-agent-feed.js";
import { AgentFeedFeedbackProvider } from "./agent-feed-scroller.js";
import { AgentEventDetail } from "./agent-event-detail.js";
import { createAgentEventDetailCache } from "./agent-event-detail-cache.js";

useDomEnv({ failOnNetwork: true });
const { act, render, fireEvent, waitFor } = await import("@testing-library/react");
const { AgentMessageList } = await import("./AgentMessageList.js");
const scrollerCore = await import("../../chat/message-scroller-core.js");
// L1: (1) relative imports; (2) no global/env/registry/i18n mutations;
// (3) parked promises/resolved DOM assertions, no sleeps; (4) no OS/order
// assumptions, geometry is element-local; (5) real hook/list/core/cache with
// transport DI, no module mocks; one transparent core spy restored in finally;
// (6) stable committed states and DOM identity;
// (7) no DB/build/heavy setup. dom-env owns registration and cleanup.
function parked<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function page(from = 2, hasOlder = true): AgentFeedResponse {
  const message: ExperienceCopilotMessageWire = { id: `m${from}`, threadId: "T", role: "assistant", content: `history ${from}`,
    toolCallsJson: null, toolCallId: null, reasoning: null, reasoningDurationMs: null, createdAt: new Date(Date.UTC(2026, 10, 5, 12, 0, from)).toISOString() };
  return agentFeedPageFromMessages("T", [message], { hasOlder, cursors: { before: hasOlder ? `before-${from}` : null, after: null } }, from);
}
function mount(load: typeof getAgentFeedPage) {
  let latest!: UseAgentFeedResult;
  function Harness({ hidden = false }: { hidden?: boolean }) {
    const feed = useAgentFeed({ kind: "experience", ownerKey: "owner", threadId: "T", feedPage: load });
    latest = feed;
    return <div style={{ display: hidden ? "none" : "flex", height: 500 }}><AgentFeedFeedbackProvider feed={feed}>
      <AgentMessageList kind="experience" threadId="T" pageWindows={feed.feed?.windows} pendingUserContent="" emptyTitle="No history" />
    </AgentFeedFeedbackProvider></div>;
  }
  const view = render(<Harness />);
  return { view, feed: () => latest, hide: (hidden: boolean) => view.rerender(<Harness hidden={hidden} />) };
}
const olderButton = (view: ReturnType<typeof render>) => view.getByRole("button", { name: "agent_feed_load_older" });

describe("AFP-17 feed feedback", () => {
  it("forwards a positive decreasing inverse index through the real core when virtual rows prepend", async () => {
    const observer = spyOn(scrollerCore, "MessageScrollerCore");
    try {
      const initial = agentFeedPageFromMessages("T", Array.from({ length: 120 }, (_, i) => page(141 + i).messages[0]!),
        { hasOlder: true, cursors: { before: "older", after: null } }, 141);
      const earlier = agentFeedPageFromMessages("T", Array.from({ length: 40 }, (_, i) => page(101 + i).messages[0]!), { head: initial.head }, 101);
      let calls = 0;
      const { view } = mount(async () => ++calls === 1 ? initial : earlier);
      // AFP-17 (CI_WEB_TIMING_FLAKES_REPORT, run 42580831178): the enabled
      // click precondition is a TWO-HOP settle — the feed data lands (rows +
      // button in one commit), then the scroller-element attach re-render
      // (scroll-area's useImperativeHandle → the core's attachScroller
      // setState) flips the strip's disabled gate. On a loaded runner the
      // conjunction of both hops outlived RTL's default 1s waitFor and the
      // park died with the rows already visible (Expected: false, Received:
      // true inside checkCallback). Park on the DATA terminal event first,
      // drain the attach hop with the file's act-flush idiom, and only then
      // park the unchanged click precondition — each waitFor targets ONE
      // arrival; no timeout is widened.
      await waitFor(() => expect(olderButton(view)).toBeDefined());
      await act(async () => {});
      await waitFor(() => expect((olderButton(view) as HTMLButtonElement).disabled).toBe(false));
      const before = observer.mock.calls.at(-1)![0].firstItemIndex;
      expect(typeof before).toBe("number");
      expect(before!).toBeGreaterThan(40);
      fireEvent.click(olderButton(view));
      await waitFor(() => expect(view.getByText("agent_feed_start")).toBeDefined());
      expect(observer.mock.calls.at(-1)![0].firstItemIndex).toBe(before! - 40);
      view.unmount();
    } finally { observer.mockRestore(); }
  });
  it("distinguishes initial loading/error/retry from a truly empty session", async () => {
    const pending = parked<AgentFeedResponse>();
    let calls = 0;
    const { view } = mount(async () => ++calls === 1 ? pending.promise : agentFeedPageFromMessages("T", []));
    expect(view.getByRole("status").textContent).toBe("agent_feed_loading");
    expect(view.queryByText("No history")).toBeNull();
    await act(async () => pending.reject(new Error("offline")));
    expect(view.getByRole("alert").textContent).toBe("agent_feed_load_error");
    expect(view.queryByText("No history")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "agent_retry" }));
    await waitFor(() => expect(view.getByText("No history")).toBeDefined());
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.queryByText("agent_feed_start")).toBeNull();
    expect(calls).toBe(2);
  });

  it("keeps the existing row mounted through an older-page failure and explicit retry to the true start", async () => {
    const pending = parked<AgentFeedResponse>();
    const calls: unknown[] = [];
    const { view } = mount(async (_id, query) => {
      calls.push(query);
      return calls.length === 1 ? page() : calls.length === 2 ? pending.promise : page(1, false);
    });
    await waitFor(() => expect(view.getByText("history 2")).toBeDefined());
    const existing = view.getByText("history 2");
    await waitFor(() => expect((olderButton(view) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(olderButton(view));
    expect(view.getByText("agent_feed_loading_older")).toBeDefined();
    expect((olderButton(view) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => pending.reject(new Error("offline")));
    expect(view.getByRole("alert").textContent).toBe("agent_feed_older_error");
    expect(view.getByText("history 2")).toBe(existing);
    expect(view.queryByText("agent_feed_start")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "agent_retry" }));
    await waitFor(() => expect(view.getByText("history 1")).toBeDefined());
    expect(view.getByText("history 2")).toBe(existing);
    expect(view.getByText("agent_feed_start")).toBeDefined();
    expect(view.queryByRole("button", { name: "agent_feed_load_older" })).toBeNull();
    expect(calls).toEqual([undefined, { before: "before-2" }, { before: "before-2" }]);
  });

  it("surfaces refresh failure without replacing loaded history with an empty or session-error screen", async () => {
    let calls = 0;
    const { view, feed } = mount(async () => { if (++calls === 2) throw new Error("offline"); return page(2, false); });
    await waitFor(() => expect(view.getByText("history 2")).toBeDefined());
    const existing = view.getByText("history 2");
    act(() => feed().refresh());
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe("agent_feed_refresh_error"));
    expect(view.getByText("history 2")).toBe(existing);
    fireEvent.click(view.getByRole("button", { name: "agent_retry" }));
    await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
    expect(calls).toBe(3);
    expect(view.getByText("history 2")).toBe(existing);
  });

  it("does not declare a stale oldest edge to be the start of history", async () => {
    const calls: unknown[] = [];
    const { view, feed } = mount(async (_id, query) => { calls.push(query); return page(2, false); });
    await waitFor(() => expect(view.getByText("agent_feed_start")).toBeDefined());
    act(() => feed().applyLocalOutcome({ editedMessageIds: ["m2"] }));
    expect(view.queryByText("agent_feed_start")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "agent_feed_revalidate" }));
    await waitFor(() => expect(view.getByText("agent_feed_start")).toBeDefined());
    expect(calls).toEqual([undefined, { aroundMessageId: "m2" }]);
  });

  it("surfaces a neighborhood reload error and retries that neighborhood without discarding rows", async () => {
    let calls = 0;
    const queries: unknown[] = [];
    const { view, feed } = mount(async (_id, query) => {
      queries.push(query);
      if (++calls === 2) throw new Error("offline");
      return page();
    });
    await waitFor(() => expect((olderButton(view) as HTMLButtonElement).disabled).toBe(false));
    const existing = view.getByText("history 2");
    act(() => feed().loadAround("m2"));
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe("agent_feed_around_error"));
    expect(view.getByText("history 2")).toBe(existing);
    fireEvent.click(view.getByRole("button", { name: "agent_retry" }));
    await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
    expect(queries).toEqual([undefined, { aroundMessageId: "m2" }, { aroundMessageId: "m2" }]);
    expect(view.getByText("history 2")).toBe(existing);
  });

  it("labels disjoint coverage honestly and bridges only after an explicit request", async () => {
    let calls = 0;
    const { view, feed } = mount(async (_id, query) => {
      calls++;
      if (query?.aroundMessageId) return { ...page(1, false), head: page(5).head,
        hasNewer: true, cursors: { before: null, after: "after-1" } };
      if (query?.before) return agentFeedPageFromMessages("T", [1, 2, 3, 4, 5].flatMap(n => page(n).messages), {}, 1);
      return page(5);
    });
    await waitFor(() => expect((olderButton(view) as HTMLButtonElement).disabled).toBe(false));
    act(() => feed().loadAround("m1"));
    await waitFor(() => expect(view.getByText("agent_feed_gap")).toBeDefined());
    expect(calls).toBe(2);
    expect(view.getByText("history 1")).toBeDefined();
    expect(view.getByText("history 5")).toBeDefined();
    fireEvent.click(view.getByRole("button", { name: "agent_feed_fill_gap" }));
    await waitFor(() => expect(view.queryByText("agent_feed_gap")).toBeNull());
    expect(calls).toBe(4);
    expect(view.getByText("history 3")).toBeDefined();
  });

  it("keeps hidden/zero-height tabs and panel resize from eagerly loading older history", async () => {
    let calls = 0;
    const { view, hide } = mount(async () => { calls++; return page(); });
    await waitFor(() => expect((olderButton(view) as HTMLButtonElement).disabled).toBe(false));
    const viewport = view.container.querySelector<HTMLElement>("[data-scroll-viewport]")!;
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 0 });
    hide(true);
    fireEvent.scroll(viewport);
    fireEvent.resize(viewport);
    await act(async () => {});
    hide(false);
    fireEvent.resize(viewport);
    await act(async () => {});
    expect(calls).toBe(1);
  });

  it("preserves the visible row's offset when an explicitly requested page prepends", async () => {
    const pending = parked<AgentFeedResponse>();
    let calls = 0;
    const { view } = mount(async () => ++calls === 1 ? page() : pending.promise);
    await waitFor(() => expect((olderButton(view) as HTMLButtonElement).disabled).toBe(false));
    const viewport = view.container.querySelector<HTMLElement>("[data-scroll-viewport]")!;
    const row = view.container.querySelector<HTMLElement>('[data-scroller-message-id="msg:m2"]')!;
    Object.defineProperties(viewport, { clientHeight: { configurable: true, value: 300 }, scrollHeight: { configurable: true, value: 2000 } });
    viewport.scrollTop = 100;
    let rowTop = 20;
    row.getBoundingClientRect = () => ({ top: rowTop, bottom: rowTop + 60 } as DOMRect);
    fireEvent.click(olderButton(view));
    rowTop = 120;
    await act(async () => pending.resolve(page(1, false)));
    expect(viewport.scrollTop).toBe(200);
    expect(view.container.querySelector('[data-scroller-message-id="msg:m2"]')).toBe(row);
  });
});

function detail(nextCursor: string | null): AgentEventDetailResponse {
  return { kind: "rp_sync", threadId: "T", eventId: "E", epoch: 1, fromPosition: 0, toPosition: 1, offset: 0, messages: [], nextCursor };
}
describe("AFP-17 frozen-detail feedback", () => {
  it("preserves the first page through a continuation failure, then reports the true detail end", async () => {
    let calls = 0;
    const src = { threadId: "T", epoch: 1, cache: createAgentEventDetailCache(), loadDetail: async () => {
      if (++calls === 2) throw new Error("offline");
      return detail(calls === 1 ? "next" : null);
    } };
    const view = render(<AgentEventDetail source={src} eventId="E" renderPage={value => <p>{value.nextCursor ? "First captured page" : "Last captured page"}</p>} />);
    await waitFor(() => expect(view.getByText("First captured page")).toBeDefined());
    fireEvent.click(view.getByRole("button", { name: "agent_event_detail_more" }));
    await waitFor(() => expect(view.getByRole("alert")).toBeDefined());
    expect(view.getByText("First captured page")).toBeDefined();
    expect(view.queryByText("agent_event_detail_end")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "agent_event_detail_retry" }));
    await waitFor(() => expect(view.getByText("agent_event_detail_end")).toBeDefined());
    expect(view.getByText("First captured page")).toBeDefined();
    expect(calls).toBe(3);
  });

  it("retries a stale detail through lifecycle refresh, never by resending its expired identity", async () => {
    let calls = 0, refreshes = 0;
    const src = { threadId: "T", epoch: 1, cache: createAgentEventDetailCache(),
      loadDetail: async () => { calls++; throw new AgentFeedStaleError("stale", "AGENT_EVENT_CURSOR_STALE", 2); },
      onStale: () => { refreshes++; } };
    const view = render(<AgentEventDetail source={src} eventId="E" renderPage={() => null} />);
    await waitFor(() => expect(view.getByRole("alert")).toBeDefined());
    expect(refreshes).toBe(1);
    fireEvent.click(view.getByRole("button", { name: "agent_event_detail_refresh" }));
    expect(refreshes).toBe(2);
    expect(calls).toBe(1);
  });
});
