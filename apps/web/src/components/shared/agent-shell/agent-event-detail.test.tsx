import { describe, expect, it } from "bun:test";
import type { AgentEventDetailResponse, AgentFeedEventSummary } from "@vibe-tavern/api-contracts";
import { useDomEnv } from "../../../../test/dom-env.js";
import { AgentFeedStaleError } from "../../../api/agent-feed-api.js";
import { createAgentEventDetailCache } from "./agent-event-detail-cache.js";
import { AgentEventDetailProvider, type AgentEventDetailSource } from "./agent-event-detail.js";
import { AgentFeedUiStateProvider } from "./agent-feed-ui-state.js";
useDomEnv({ failOnNetwork: true });
const { render, fireEvent, waitFor, act } = await import("@testing-library/react");
const { AgentTimelineSeparator } = await import("./AgentTimelineSeparator.js");
// L1: relative imports; no global/env/registry/i18n patches; parked promises
// and resolved DOM states, no sleeps; no OS assumptions; real cache/row/frame
// through loader DI (no module mocks); stable state pins; no DB/heavy setup.
const event: AgentFeedEventSummary = { id: "E", seq: 1, createdAt: "2026-11-05", beforeMessageId: null,
  detailAvailable: true, kind: "rp_sync", fromPosition: 0, toPosition: 99, messageCount: 100 };
function page(offset = 0, epoch = 1): AgentEventDetailResponse {
  return { kind: "rp_sync", threadId: "T", eventId: "E", epoch, offset, fromPosition: 0, toPosition: 99,
    messages: Array.from({ length: 50 }, (_, i) => ({ id: `rp-${offset + i}`, position: offset + i, role: "assistant", authorName: null,
      variantId: null, model: null, preset: null, text: `captured ${offset + i}` })), nextCursor: offset === 0 ? "next" : null };
}
function tree(source: AgentEventDetailSource, mounted = true, summary = event) {
  return <AgentEventDetailProvider source={source}><AgentFeedUiStateProvider sessionKey="T">
    {mounted && <AgentTimelineSeparator event={summary} />}
  </AgentFeedUiStateProvider></AgentEventDetailProvider>;
}
function source(loadDetail: AgentEventDetailSource["loadDetail"]): AgentEventDetailSource {
  return { threadId: "T", epoch: 1, loadDetail, cache: createAgentEventDetailCache() };
}

describe("AFP-16 lazy frozen detail", () => {
  it("does not fetch closed summaries, loads one bounded page on open, and continues only on demand", async () => {
    const calls: (string | undefined)[] = [];
    const src = source(async (_thread, _event, cursor) => { calls.push(cursor); return page(cursor ? 50 : 0); });
    const view = render(tree(src));
    await act(async () => {});
    expect(calls).toEqual([]);
    fireEvent.click(view.getByTestId("timeline-separator-toggle"));
    await waitFor(() => expect(view.getByText("captured 0")).toBeDefined());
    expect(calls).toEqual([undefined]);
    expect(view.queryByText("captured 50")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "agent_event_detail_more" }));
    await waitFor(() => expect(view.getByText("captured 99")).toBeDefined());
    expect(view.getByText("captured 0")).toBeDefined();
    expect(calls).toEqual([undefined, "next"]);
    fireEvent.click(view.getByTestId("timeline-separator-toggle"));
    await waitFor(() => expect(view.queryByText("captured 0")).toBeNull());
  });
  it("remembers disclosure across actual unmount, never fetching offscreen remembered-open rows", async () => {
    let calls = 0;
    const src = source(async () => { calls++; return page(); });
    const view = render(tree(src));
    fireEvent.click(view.getByTestId("timeline-separator-toggle"));
    await waitFor(() => expect(view.getByText("captured 0")).toBeDefined());
    view.rerender(tree(src, false));
    expect(view.queryByText("captured 0")).toBeNull();
    expect(calls).toBe(1);
    view.rerender(tree(src));
    await waitFor(() => expect(view.getByText("captured 0")).toBeDefined());
    expect(calls).toBe(1);
    expect(view.getByTestId("timeline-separator-toggle").getAttribute("aria-expanded")).toBe("true");
  });
  it("retains exact frozen bytes, not a current RP message, and isolates epoch replacement", async () => {
    const old = page();
    const src = source(async () => old);
    const view = render(tree(src));
    fireEvent.click(view.getByTestId("timeline-separator-toggle"));
    await waitFor(() => expect(view.getByText("captured 0")).toBeDefined());
    const next = page(0, 2);
    if (next.kind !== "rp_sync") throw new Error("Expected rp_sync");
    next.messages[0]!.text = "rewritten frozen event";
    view.rerender(tree({ ...src, epoch: 2, loadDetail: async () => next }));
    await waitFor(() => expect(view.getByText("rewritten frozen event")).toBeDefined());
    expect(view.queryByText("captured 0")).toBeNull();
    expect(old.kind === "rp_sync" && old.messages[0]?.text).toBe("captured 0");
  });
  it("remembers explicitly requested continuation cursors after cache eviction and actual unmount", async () => {
    let calls = 0;
    const src = { ...source(async (_thread, _event, cursor) => { calls++; return page(cursor ? 50 : 0); }), cache: createAgentEventDetailCache({ maxBytes: 1 }) };
    const view = render(tree(src));
    fireEvent.click(view.getByTestId("timeline-separator-toggle"));
    await waitFor(() => expect(view.getByText("captured 0")).toBeDefined());
    fireEvent.click(view.getByRole("button", { name: "agent_event_detail_more" }));
    await waitFor(() => expect(view.getByText("captured 99")).toBeDefined());
    view.rerender(tree(src, false));
    expect(src.cache.stats().entries).toBe(0);
    expect(calls).toBe(2);
    view.rerender(tree(src));
    await waitFor(() => expect(view.getByText("captured 99")).toBeDefined());
    expect(calls).toBe(4);
  });
  it("shows a failed read and retries without clearing the summary", async () => {
    let calls = 0;
    const src = source(async () => { if (++calls === 1) throw new Error("offline"); return page(); });
    const view = render(tree(src));
    fireEvent.click(view.getByTestId("timeline-separator-toggle"));
    await waitFor(() => expect(view.getByRole("alert")).toBeDefined());
    fireEvent.click(view.getByRole("button", { name: "agent_event_detail_retry" }));
    await waitFor(() => expect(view.getByText("captured 0")).toBeDefined());
    expect(calls).toBe(2);
  });
  it("surfaces typed stale and notifies the lifecycle without automatically restarting every page", async () => {
    let calls = 0, stale = 0;
    const src = { ...source(async () => { calls++; throw new AgentFeedStaleError("stale", "AGENT_EVENT_CURSOR_STALE", 2); }), onStale: (epoch: number) => { stale = epoch; } };
    const view = render(tree(src));
    fireEvent.click(view.getByTestId("timeline-separator-toggle"));
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe("agent_event_detail_stale"));
    expect(stale).toBe(2);
    expect(calls).toBe(1);
  });
  it("does not fetch corrupt summaries or non-expandable provenance events", async () => {
    let calls = 0;
    const src = source(async () => { calls++; return page(); });
    const view = render(tree(src, true, { ...event, detailAvailable: false, messageCount: null }));
    fireEvent.click(view.getByTestId("timeline-separator-toggle"));
    expect(view.getByRole("alert").textContent).toBe("agent_event_detail_unavailable");
    view.rerender(tree(src, true, { id: "fork", kind: "branch_forked", seq: 2, createdAt: "2026-11-05", beforeMessageId: null, detailAvailable: true, at: 0 }));
    expect(view.queryByTestId("timeline-separator-toggle")).toBeNull();
    await act(async () => {});
    expect(calls).toBe(0);
  });
});
