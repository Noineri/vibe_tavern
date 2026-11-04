import { describe, expect, it, mock } from "bun:test";
import { createRef } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { MessageScrollerCoreApi } from "../../chat/message-scroller-core.js";

useDomEnv({ failOnNetwork: true });
const { act, fireEvent, render, waitFor } = await import("@testing-library/react");
const { AgentFeedScroll } = await import("./AgentFeedScroll.js");
const { AgentFeedScroller } = await import("./agent-feed-scroller.js");
const { ScrollArea } = await import("../scroll-area.js");

// L1: repo-relative imports only; no global patches/registries/i18n; waits assert
// resolved DOM state; no OS assumptions, module mocks, sleeps or database setup.
// Geometry is local to mounted elements (happy-dom does not perform layout).
function tallGeometry(view: ReturnType<typeof render>): HTMLElement {
  const viewport = view.container.querySelector<HTMLElement>("[data-scroll-viewport]")!;
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 2000 },
    clientWidth: { configurable: true, value: 300 },
    scrollWidth: { configurable: true, value: 300 },
  });
  return viewport;
}

function feed(resetKey = "thread-a", text = "History") {
  return <AgentFeedScroller
    resetKey={resetKey}
    displayIds={["msg:one", "msg:two"]}
    renderItem={(_index, id) => <div><button type="button">{text} {id}</button><input aria-label={`Draft ${id}`} defaultValue="Keep draft" /></div>}
    renderJumpToBottom={(jump) => <button type="button" onClick={jump}>Jump</button>}
  />;
}

describe("agent feed scroll surface", () => {
  it("characterizes the existing thin lane: one viewport owns the ref and scroll events", async () => {
    const ref = createRef<HTMLDivElement>();
    const onScroll = mock();
    const view = render(<AgentFeedScroll scrollRef={ref} onScroll={onScroll}><p>Existing history</p></AgentFeedScroll>);
    await act(async () => {});
    const viewport = view.container.querySelector<HTMLDivElement>("[data-scroll-viewport]")!;
    expect(ref.current).toBe(viewport);
    expect(view.container.querySelectorAll("[data-scroll-viewport]")).toHaveLength(1);
    expect(viewport.closest("[data-scroll-area]")!.getAttribute("data-scroll-area")).toBe("thin");
    fireEvent.scroll(viewport);
    expect(onScroll).toHaveBeenCalled();
    expect(viewport.textContent).toBe("Existing history");
  });

  it("forwards the core ref, virtualizer attributes/styles and scroll events to one shared viewport", async () => {
    let api: MessageScrollerCoreApi | undefined;
    const view = render(<AgentFeedScroller
      resetKey="thread"
      displayIds={["msg:one"]}
      renderItem={() => <p>Virtual history</p>}
      overlay={(value) => { api = value; return null; }}
      renderJumpToBottom={(jump) => <button type="button" onClick={jump}>Jump</button>}
    />);
    const viewport = tallGeometry(view);
    expect(api?.scrollerElement).toBe(viewport);
    expect(view.container.querySelector("[data-virtuoso-scroller]")).toBe(viewport);
    expect(view.container.querySelectorAll("[data-scroll-viewport]")).toHaveLength(1);
    expect(view.container.querySelectorAll("[data-virtuoso-scroller]")).toHaveLength(1);
    expect(viewport.id.length).toBeGreaterThan(0);
    expect(viewport.style.overflowY).toBe("auto");
    expect(viewport.style.overflowX).toBe("hidden");
    expect(viewport.classList.contains("scrollbar-hide")).toBe(true);
    const root = viewport.closest<HTMLElement>("[data-scroll-area]")!;
    expect(root.getAttribute("data-scroll-area")).toBe("thin");
    expect(root.classList.contains("overflow-hidden")).toBe(true);
    expect(root.querySelector("[data-message-stable-tail]")?.textContent).toBe("Virtual history");
    // No story-map role/import/setup and no nested overflow viewport.
    expect(view.queryByRole("scrollbar")).toBeNull();
    expect(viewport.querySelector("[data-scroll-viewport], [data-virtuoso-scroller]")).toBeNull();
    fireEvent.wheel(viewport, { deltaY: -100 });
    viewport.scrollTop = 200;
    fireEvent.scroll(viewport);
    expect(api?.pinned).toBe(false);
    await waitFor(() => expect(root.querySelector("[data-scroll-thumb]")).not.toBeNull());
    expect(root.querySelector("[data-scroll-track]")?.parentElement).toBe(root);
    expect(root.querySelectorAll("[data-scroll-track]")).toHaveLength(1);
    fireEvent.click(view.getByRole("button", { name: "Jump" }));
    expect(viewport.scrollTop).toBe(1600);
    expect(api?.pinned).toBe(true);
  });

  it.each(["wheel", "touch", "keyboard"] as const)("keeps %s input on the virtualizer viewport, with no remount or reading-position loss", async (intent) => {
    const view = render(feed());
    const viewport = tallGeometry(view);
    const draft = view.getByRole("textbox", { name: "Draft msg:one" });
    if (intent === "wheel") fireEvent.wheel(viewport, { deltaY: -100 });
    if (intent === "touch") fireEvent.touchMove(viewport);
    if (intent === "keyboard") fireEvent.keyDown(viewport, { key: "PageUp" });
    viewport.scrollTop = 200;
    fireEvent.scroll(viewport);
    expect(view.getByRole("button", { name: "Jump" })).toBeDefined();
    view.rerender(feed("thread-a", "Streaming update"));
    await act(async () => {});
    expect(view.container.querySelector("[data-virtuoso-scroller]")).toBe(viewport);
    expect(view.getByRole("textbox", { name: "Draft msg:one" })).toBe(draft);
    expect(viewport.scrollTop).toBe(200);
    expect(view.getByRole("button", { name: "Jump" })).toBeDefined();
    view.rerender(feed("thread-b"));
    expect(viewport.scrollTop).toBe(1600);
    expect(view.queryByRole("button", { name: "Jump" })).toBeNull();
  });

  it("forwards sibling-track intent without treating row controls or secondary clicks as scrolling", async () => {
    const view = render(feed());
    const viewport = tallGeometry(view);
    // A programmatic scroll while pinned is rejected, but it also lets Base UI
    // measure the overflow and mount its actual track/thumb (no library mock).
    viewport.scrollTop = 200;
    fireEvent.scroll(viewport);
    await waitFor(() => expect(view.container.querySelector("[data-scroll-thumb]")).not.toBeNull());
    expect(viewport.scrollTop).toBe(1600);
    const thumb = view.container.querySelector<HTMLElement>("[data-scroll-thumb]")!;
    const track = thumb.parentElement!;
    fireEvent.pointerDown(view.getByRole("button", { name: "History msg:one" }), { button: 0 });
    viewport.scrollTop = 200;
    fireEvent.scroll(viewport);
    expect(viewport.scrollTop).toBe(1600);
    fireEvent.pointerDown(thumb, { button: 2, pointerId: 1 });
    viewport.scrollTop = 200;
    fireEvent.scroll(viewport);
    expect(viewport.scrollTop).toBe(1600);
    // A thumb press is NOT a descendant of the viewport. Its bridge must reach
    // the hook before Base UI writes scrollTop, or bottom-follow fights drag.
    expect(viewport.contains(thumb)).toBe(false);
    fireEvent.pointerDown(thumb, { button: 0, pointerId: 2 });
    expect(track.hasAttribute("data-dragging")).toBe(true);
    viewport.scrollTop = 200;
    fireEvent.scroll(viewport);
    expect(viewport.scrollTop).toBe(200);
    expect(view.getByRole("button", { name: "Jump" })).toBeDefined();
    fireEvent.pointerCancel(thumb, { pointerId: 2 });
    expect(track.hasAttribute("data-dragging")).toBe(false);
    fireEvent.click(view.getByRole("button", { name: "Jump" }));
    expect(viewport.scrollTop).toBe(1600);
  });

  it("cleans up native follow listeners when the composed surface unmounts", () => {
    const view = render(feed());
    const viewport = tallGeometry(view);
    view.unmount();
    viewport.scrollTop = 200;
    fireEvent.scroll(viewport);
    expect(viewport.scrollTop).toBe(200);
    expect(viewport.isConnected).toBe(false);
  });

  it("does not forward a nested card's scrollbar intent to the outer feed", async () => {
    const view = render(<AgentFeedScroller
      resetKey="thread"
      displayIds={["event:snapshot"]}
      renderItem={() => <ScrollArea viewportProps={{ "aria-label": "Frozen detail" }}><p>Nested detail</p></ScrollArea>}
      renderJumpToBottom={(jump) => <button type="button" onClick={jump}>Jump</button>}
    />);
    const viewport = tallGeometry(view);
    const inner = view.getByLabelText("Frozen detail");
    Object.defineProperties(inner, {
      clientHeight: { value: 100 }, scrollHeight: { value: 1000 },
      clientWidth: { value: 200 }, scrollWidth: { value: 200 },
    });
    fireEvent.scroll(inner);
    const innerRoot = inner.closest("[data-scroll-area]")!;
    await waitFor(() => expect(innerRoot.querySelector("[data-scroll-thumb]")).not.toBeNull());
    fireEvent.pointerDown(innerRoot.querySelector("[data-scroll-thumb]")!, { button: 0, pointerId: 3 });
    viewport.scrollTop = 200;
    fireEvent.scroll(viewport);
    expect(viewport.scrollTop).toBe(1600);
    expect(view.queryByRole("button", { name: "Jump" })).toBeNull();
  });
});
