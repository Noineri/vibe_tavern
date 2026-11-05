import { describe, expect, it } from "bun:test";
import type { AgentFeedBoundary, AgentFeedOrderPosition, AgentFeedResponse, ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { useDomEnv } from "../../../../test/dom-env.js";
import { buildAgentFeedModel, EMPTY_AGENT_FEED_LIVE_TOOL_CALL_IDS } from "./agent-feed-model.js";
import { applyAgentFeedPage, initAgentFeedState, type AgentFeedWindow } from "./agent-feed-reconcile.js";

useDomEnv({ failOnNetwork: true });
const { render, act, fireEvent } = await import("@testing-library/react");
const { AgentMessageList } = await import("./AgentMessageList.js");
const { AgentFeedUiStateProvider } = await import("./agent-feed-ui-state.js");
// L1: relative paths only; no process-global patches/registries/i18n; no waits
// or sleeps in pure pins, DOM pins use resolved state; no platform assumptions;
// no module mocks/shared mutable fixtures; stable model/DOM state; no DB setup.
const NOW = "2026-11-05T12:00:00Z";
const pos = (id: string, seq: number): AgentFeedOrderPosition => ({ id, seq, createdAt: NOW, record: "message" });
function msg(id: string, seq: number, role: ExperienceCopilotMessageWire["role"] = "assistant", extra: Partial<ExperienceCopilotMessageWire> = {}): ExperienceCopilotMessageWire {
  return { id, threadId: "T", role, content: id, toolCallsJson: null, toolCallId: null, reasoning: null, reasoningDurationMs: null, createdAt: NOW, ...extra };
}
function window(messages: ExperienceCopilotMessageWire[], sequences: number[], boundary: Partial<AgentFeedBoundary> = {}): AgentFeedWindow {
  return { messages, events: [], oldest: pos(messages[0]!.id, sequences[0]!), newest: pos(messages.at(-1)!.id, sequences.at(-1)!),
    before: "before", after: null, stale: false, hasOlder: true, hasNewer: false,
    boundary: { startsMidTurn: false, endsMidTurn: false, turnOpenerMessageId: null, continuedToolCalls: [], lastUserMessageId: null,
      digest: { totalInThread: 0, unloadedOlderCount: 0, lastAnchor: null }, ...boundary } };
}
const modelOf = (windows: AgentFeedWindow[]) => buildAgentFeedModel({ messages: [], events: [], liveToolCallIds: EMPTY_AGENT_FEED_LIVE_TOOL_CALL_IDS, windows });

describe("AFP-15 partial feed boundaries", () => {
  it("keeps an open partial-turn accordion open when prepend changes its first loaded tool", async () => {
    const call = (id: string, seq: number) => msg(`call-${id}`, seq, "assistant", { content: "", toolCallsJson: JSON.stringify([{ type: "tool-call", toolCallId: id, toolName: "read_skill_file", input: {} }]) });
    const result = (id: string, seq: number) => msg(`result-${id}`, seq, "tool", { toolCallId: id, content: JSON.stringify({ path: "skill.md", content: `frozen-${id}` }) });
    const partial = window([call("two", 5), result("two", 6), msg("answer", 7)], [5, 6, 7], { startsMidTurn: true, turnOpenerMessageId: "u" });
    const draw = (w: AgentFeedWindow) => <AgentFeedUiStateProvider sessionKey="T"><AgentMessageList kind="experience" threadId="T" pendingUserContent=""
      pageWindows={[w]} renderEventSummary={e => <span>{e.id}</span>} /></AgentFeedUiStateProvider>;
    const view = render(draw(partial));
    fireEvent.click(view.getByTestId("copilot-tool-accordion-toggle"));
    expect(view.getByTestId("copilot-tool-accordion-toggle").getAttribute("aria-expanded")).toBe("true");
    view.rerender(draw(window([msg("u", 1, "user"), call("one", 2), result("one", 3), ...partial.messages], [1, 2, 3, 5, 6, 7])));
    expect(view.getByTestId("copilot-tool-accordion-toggle").getAttribute("aria-expanded")).toBe("true");
    await act(async () => {});
  });
  it("the real list interleaves an event-only window before newer history without mounting a second scroller", async () => {
    const gap = window([msg("placeholder", 5)], [5]);
    gap.messages = [];
    gap.events = [{ id: "snapshot", kind: "branch_forked", at: 0, seq: 5, createdAt: NOW, beforeMessageId: "outside", detailAvailable: true }];
    const view = render(<AgentMessageList kind="experience" threadId="T" pendingUserContent=""
      pageWindows={[gap, window([msg("new", 20)], [20])]} renderEventSummary={e => <span>{e.id}</span>} />);
    await act(async () => {});
    expect([...view.container.querySelectorAll("[data-scroller-message-id]")].map(e => e.getAttribute("data-scroller-message-id"))).toEqual(["event:snapshot", "msg:new"]);
    expect(view.container.querySelectorAll("[data-virtuoso-scroller]")).toHaveLength(1);
  });

  it("the real list keeps older turn actions away from the last-turn regenerate gate", async () => {
    const w = window([msg("old", 2)], [2], { lastUserMessageId: "new-user", pageFacts: {
      lastUserPosition: pos("new-user", 9), lastDigestAnchorPosition: null, firstAssistantMessageId: "old", messagePositions: [pos("old", 2)], digestCounts: [],
    } });
    w.hasNewer = true;
    const view = render(<AgentMessageList kind="experience" threadId="T" pendingUserContent="" pageWindows={[w]}
      renderEventSummary={e => <span>{e.id}</span>} turnRow={{ onCopy: () => {}, onRegenerate: () => {}, onRequestDelete: () => {} }} />);
    await act(async () => {});
    expect(view.queryByTestId("copilot-turn-regenerate")).toBeNull();
    expect(view.getByText("old")).toBeDefined();
  });
  it("keeps legacy full-history digest order and counts", () => {
    const messages = [msg("u", 0, "user"), msg("a", 1), msg("d", 2, "digest", { toolCallId: "a" })];
    const model = buildAgentFeedModel({ messages, events: [], liveToolCallIds: EMPTY_AGENT_FEED_LIVE_TOOL_CALL_IDS });
    expect(model.visibleMessages.map(e => [e.message.id, e.coveredCount])).toEqual([["u", null], ["a", null], ["d", 1]]);
  });

  it("uses full counts and an older unloaded digest anchor instead of declaring every loaded row covered", () => {
    const w = window([msg("a", 10), msg("d", 11, "digest", { toolCallId: "unloaded" })], [10, 11], {
      lastUserMessageId: "u", digest: { totalInThread: 2, unloadedOlderCount: 1, lastAnchor: "unloaded" },
      pageFacts: { lastUserPosition: pos("u", 1), lastDigestAnchorPosition: pos("unloaded", 5), firstAssistantMessageId: "a",
        messagePositions: [pos("a", 10), pos("d", 11)], digestCounts: [{ id: "d", coveredCount: 7 }] },
    });
    const model = modelOf([w]);
    expect(model.visibleMessages.map(e => [e.message.id, e.coveredCount])).toEqual([["a", null], ["d", 7]]);
    expect(model.boundaries).toEqual({ lastUserVisibleIndex: -1, lastDigestAnchorVisibleIndex: 0 });
    w.boundary.pageFacts!.lastDigestAnchorPosition = pos("newer-anchor", 20);
    expect(modelOf([w]).boundaries.lastDigestAnchorVisibleIndex).toBe(2);
    w.boundary.digest.lastAnchor = "dangling";
    w.boundary.pageFacts!.lastDigestAnchorPosition = null;
    expect(modelOf([w]).boundaries.lastDigestAnchorVisibleIndex).toBe(2);
  });

  it("does not treat an older window's last user as the thread's last turn", () => {
    const w = window([msg("u", 1, "user"), msg("old-answer", 2)], [1, 2], {
      lastUserMessageId: "new-user", pageFacts: { lastUserPosition: pos("new-user", 9), lastDigestAnchorPosition: null,
        firstAssistantMessageId: "old-answer", messagePositions: [pos("u", 1), pos("old-answer", 2)], digestCounts: [] },
    });
    expect(modelOf([w]).boundaries.lastUserVisibleIndex).toBe(2);
  });

  it("uses frozen split-call names with the existing ask/permission/proposal parser", () => {
    const tool = msg("result", 4, "tool", { toolCallId: "call", content: JSON.stringify({ path: "skill.md", content: "Read body" }) });
    const w = window([tool, msg("answer", 5)], [4, 5], { startsMidTurn: true, turnOpenerMessageId: "u",
      continuedToolCalls: [{ toolCallId: "call", toolName: "read_skill_file" }] });
    const model = modelOf([w]);
    const item = model.anchorItems.get("answer")?.[0];
    expect(item?.kind).toBe("accordion");
    if (item?.kind !== "accordion") throw new Error("Expected tool group");
    expect(item.activities[0]?.toolName).toBe("read_skill_file");
    expect(model.captions.stateKeys.get("answer")).toBe("u");
  });

  it("keeps event-only intervals at their own window rather than moving them after newer history", () => {
    const gap = window([msg("placeholder", 5)], [5]);
    gap.messages = [];
    gap.events = [{ id: "e", kind: "rp_sync", seq: 5, createdAt: NOW, beforeMessageId: "not-loaded", detailAvailable: true,
      fromPosition: 0, toPosition: 1, messageCount: 2 }];
    const model = modelOf([gap, window([msg("new", 20)], [20])]);
    expect(model.segments).toHaveLength(2);
    expect(model.segments?.[0]?.trailingSummaryEvents.map(e => e.id)).toEqual(["e"]);
    expect(model.trailingSummaryEvents).toEqual([]);
  });

  it("reconciliation retains older digest facts when adjacent coverage coalesces", () => {
    const older = window([msg("d", 3, "digest")], [3], { pageFacts: { lastUserPosition: null, lastDigestAnchorPosition: null,
      firstAssistantMessageId: null, messagePositions: [pos("d", 3)], digestCounts: [{ id: "d", coveredCount: 9 }] } });
    const newer = window([msg("a", 4)], [4], { pageFacts: { lastUserPosition: null, lastDigestAnchorPosition: null,
      firstAssistantMessageId: "a", messagePositions: [pos("a", 4)], digestCounts: [] } });
    const page = (w: AgentFeedWindow): AgentFeedResponse => ({ threadId: "T", historyEpoch: 0, head: newer.newest,
      range: { oldest: w.oldest, newest: w.newest }, messages: w.messages, events: w.events,
      hasOlder: w.hasOlder, hasNewer: w.hasNewer, cursors: { before: w.before, after: w.after }, boundary: w.boundary });
    const state = applyAgentFeedPage(initAgentFeedState("T"), page(newer));
    const merged = applyAgentFeedPage(state, page(older), { target: state.windows[0] });
    expect(merged.windows[0]?.boundary.pageFacts?.digestCounts).toEqual([{ id: "d", coveredCount: 9 }]);
    expect(modelOf(merged.windows).visibleMessages[0]?.coveredCount).toBe(9);
  });
});
