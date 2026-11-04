import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installAgentMessageMarkdownSeam } from "../../../../test/agent-message-markdown-seam.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";
import { useAgentLiveStreamStore } from "../../../stores/agent-live-stream-store.js";

useDomEnv();
installI18nContextSeam();
installAgentMessageMarkdownSeam();
const { act, fireEvent, render, waitFor } = await import("@testing-library/react");
const { AgentMessageList } = await import("./AgentMessageList.js");
const { TooltipProvider } = await import("../Tooltip.js");
const { AgentFeedUiStateProvider, useAgentFeedUiStateStore } = await import("./agent-feed-ui-state.js");
const feedModel = await import("./agent-feed-model.js");
const markdown = await import("../../../lib/markdown.js");
import type { AgentFeedUiStateStore } from "./agent-feed-ui-state.js";

// L1: relative imports only; store state captured/restored; no global patches,
// environment changes, real i18n, registries or file-order assumptions; shared
// existing seams only; resolved-state assertions, no sleeps; no DB/heavy setup.
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

const turnRow = { onCopy: () => {}, onRegenerate: () => {}, onRequestDelete: () => {} };
let retainedStore: AgentFeedUiStateStore;
function StateProbe() {
  retainedStore = useAgentFeedUiStateStore();
  return null;
}
function session(messages: ExperienceCopilotMessageWire[], options: { key?: string; visible?: boolean; busy?: boolean; mobileHidden?: boolean } = {}) {
  return <TooltipProvider><AgentFeedUiStateProvider sessionKey={options.key ?? "thread"}>
    <StateProbe />
    <div className={options.mobileHidden ? "hidden" : "flex"}>
      {options.visible !== false && <AgentMessageList kind="experience" threadId={options.key ?? "thread"}
        messages={messages} pendingUserContent="" turnRow={turnRow} isSending={options.busy}
        onEditAssistant={async () => false} onEditLast={() => {}} />}
    </div>
  </AgentFeedUiStateProvider></TooltipProvider>;
}

function editFixture(): ExperienceCopilotMessageWire[] {
  return [message("u"), { ...message("a", "assistant"), reasoning: "Kept reasoning", reasoningDurationMs: 100 }];
}
function retiredFixture(messages: ExperienceCopilotMessageWire[]): ExperienceCopilotMessageWire[] {
  return [...messages, ...Array.from({ length: 240 }, (_, i) => message(`later-${i}`))];
}

function message(id: string, role: "user" | "assistant" = "user"): ExperienceCopilotMessageWire {
  return { id, threadId: "thread", role, content: `Body ${id}`, toolCallsJson: null, toolCallId: null,
    reasoning: null, reasoningDurationMs: null, createdAt: "" };
}

describe("real agent feed virtualization", () => {
  it("characterizes the existing short-feed event, text and live handover boundary before the port", () => {
    const messages = [message("u"), message("a", "assistant")];
    const view = render(<AgentMessageList kind="experience" threadId="thread" messages={messages} pendingUserContent="" />);
    const first = view.getByText("Body u");
    act(() => useAgentLiveStreamStore.getState().appendLiveDeltas("experience", "thread", { text: "New streamed reply" }));
    expect(view.getByText("New streamed reply")).toBeDefined();
    expect(view.getAllByTestId("copilot-host-caption")).toHaveLength(1);
    act(() => useAgentLiveStreamStore.setState({ liveByThread: {} }));
    view.rerender(<AgentMessageList kind="experience" threadId="thread" messages={[...messages, { ...message("a2", "assistant"), content: "New streamed reply" }]} pendingUserContent="" />);
    expect(view.getAllByText("New streamed reply")).toHaveLength(1);
    expect(view.getByText("Body u")).toBe(first);
  });

  it("10k loaded messages mount a bounded tail; delta bursts rebuild neither history nor historical message bodies", async () => {
    const modelProbe = spyOn(feedModel, "memoizedAgentFeedModel");
    const bodyProbe = spyOn(markdown, "Markdown");
    restoreProbes = () => { modelProbe.mockRestore(); bodyProbe.mockRestore(); };
    const messages = Array.from({ length: 10_000 }, (_, i) => message(`m${i}`));
    const view = render(<AgentMessageList kind="experience" threadId="thread" messages={messages} pendingUserContent="" isSending />);
    await act(async () => {});
    const calls = modelProbe.mock.calls.length;
    expect(calls).toBeGreaterThan(0); // Prove the probe fires (R11).
    const model = modelProbe.mock.results.at(-1)?.value as ReturnType<typeof feedModel.memoizedAgentFeedModel>;
    expect(model?.visibleMessages).toHaveLength(10_000);
    const historicalBodies = () => bodyProbe.mock.calls.filter(([props]) => props.text.startsWith("Body m")).length;
    const bodiesBefore = historicalBodies();
    expect(bodiesBefore).toBeGreaterThan(0);
    const mounted = view.container.querySelectorAll("[data-scroller-message-id]").length;
    expect(mounted).toBeLessThanOrEqual(100); // happy-dom has no prefix layout.
    expect(view.getByText("Body m9999")).toBeDefined();
    expect(view.queryByText("Body m0")).toBeNull();
    const viewport = view.container.querySelector("[data-virtuoso-scroller]");
    for (let i = 0; i < 20; i++) {
      act(() => {
        useAgentTurnStore.getState().appendTextDelta("experience", "thread", "live ");
        useAgentLiveStreamStore.getState().appendLiveDeltas("experience", "thread", { text: "live " });
      });
    }
    expect(modelProbe.mock.calls).toHaveLength(calls);
    expect(historicalBodies()).toBe(bodiesBefore);
    expect(view.container.querySelector("[data-virtuoso-scroller]")).toBe(viewport);
    expect(model?.visibleMessages).toHaveLength(10_000);
  });

  it("a dirty draft and reasoning disclosure survive ACTUAL virtual unmount and prepend", () => {
    const messages = editFixture();
    const view = render(session(messages));
    fireEvent.click(view.getByText("reasoning"));
    fireEvent.click(view.getByTestId("copilot-assistant-edit"));
    fireEvent.change(view.container.querySelector("textarea")!, { target: { value: "Unfinished edit" } });
    const row = view.container.querySelector('[data-scroller-message-id="msg:a"]')!;
    view.rerender(session(retiredFixture(messages)));
    expect(row.isConnected).toBe(false);
    expect(view.queryByTestId("copilot-edit-message")).toBeNull();
    expect(retainedStore.getRowState("msg:a")?.draft).toBe("Unfinished edit");
    const older = Array.from({ length: 30 }, (_, i) => message(`older-${i}`));
    view.rerender(session([...older, ...messages.map((m) => ({ ...m, content: "Refetched server text" }))]));
    expect(view.container.querySelector("textarea")!.value).toBe("Unfinished edit");
    expect(view.getByText("Kept reasoning")).toBeDefined();
    // New measured row DOM: this is not a React-key-only identity assertion.
    expect(view.container.querySelector('[data-scroller-message-id="msg:a"]')).not.toBe(row);
  });

  it.each(["busy", "delete"] as const)("%s clears an offscreen draft instead of resurrecting it on return", (operation) => {
    const messages = editFixture();
    const view = render(session(messages));
    fireEvent.click(view.getByTestId("copilot-assistant-edit"));
    fireEvent.change(view.container.querySelector("textarea")!, { target: { value: "Discard this draft" } });
    const retired = retiredFixture(messages);
    view.rerender(session(retired));
    expect(view.queryByTestId("copilot-edit-message")).toBeNull();
    if (operation === "busy") view.rerender(session(retired, { busy: true }));
    else view.rerender(session(retired.filter((m) => m.id !== "a")));
    expect(retainedStore.getRowState("msg:a")?.draft).toBeUndefined();
    view.rerender(session(messages));
    expect(view.queryByTestId("copilot-edit-message")).toBeNull();
  });

  it("hidden mobile-tab return and viewport recovery retain state; only a real session switch clears it", async () => {
    const messages = editFixture();
    const view = render(session(messages));
    fireEvent.click(view.getByText("reasoning"));
    fireEvent.click(view.getByTestId("copilot-assistant-edit"));
    fireEvent.change(view.container.querySelector("textarea")!, { target: { value: "Mobile draft" } });
    const viewport = view.container.querySelector("[data-virtuoso-scroller]");
    view.rerender(session(messages, { mobileHidden: true }));
    view.rerender(session(messages));
    expect(view.container.querySelector("[data-virtuoso-scroller]")).toBe(viewport);
    expect(view.container.querySelector("textarea")!.value).toBe("Mobile draft");
    // Same scope as translate recovery: only the feed subtree remounts.
    view.rerender(session(messages, { visible: false }));
    expect(view.queryByTestId("copilot-message-list")).toBeNull();
    view.rerender(session(messages));
    expect(view.container.querySelector("textarea")!.value).toBe("Mobile draft");
    expect(view.getByText("Kept reasoning")).toBeDefined();
    view.rerender(session(messages, { key: "other-thread" }));
    expect(view.queryByTestId("copilot-edit-message")).toBeNull();
    await waitFor(() => expect(view.queryByText("Kept reasoning")).toBeNull());
  });
});
