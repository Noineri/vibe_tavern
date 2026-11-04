import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { MessageScrollerCoreApi } from "../../chat/message-scroller-core.js";

useDomEnv({ failOnNetwork: true });
const { act, fireEvent, render, waitFor } = await import("@testing-library/react");
const { AgentFeedScroller } = await import("./agent-feed-scroller.js");
const { ScrollArea } = await import("../scroll-area.js");
const { MessageScrollerCore } = await import("../../chat/message-scroller-core.js");

const originalResizeObserver = globalThis.ResizeObserver;
beforeEach(() => { globalThis.ResizeObserver = originalResizeObserver; });
afterEach(() => { globalThis.ResizeObserver = originalResizeObserver; });
afterAll(() => { globalThis.ResizeObserver = originalResizeObserver; });

// L1: repo-relative imports only; the geometry observer patch is restored in
// beforeEach/afterEach/afterAll; no registries/i18n; waits assert
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
  it("keeps the characterized thin-lane boundary: the core's ref and scroll intent use the same viewport", async () => {
    let api: MessageScrollerCoreApi | undefined;
    const view = render(<AgentFeedScroller resetKey="thread" displayIds={["msg:one"]}
      renderItem={() => <p>Existing history</p>} overlay={(value) => { api = value; return null; }} />);
    await act(async () => {});
    const viewport = tallGeometry(view);
    expect(api?.scrollerElement).toBe(viewport);
    expect(view.container.querySelectorAll("[data-scroll-viewport]")).toHaveLength(1);
    expect(viewport.closest("[data-scroll-area]")!.getAttribute("data-scroll-area")).toBe("thin");
    fireEvent.wheel(viewport, { deltaY: -100 });
    viewport.scrollTop = 200;
    fireEvent.scroll(viewport);
    expect(api?.pinned).toBe(false);
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

  it("preserves the agent's strict 40px near-bottom policy without changing the RP core's 2px rule", () => {
    const agent = render(feed());
    const viewport = tallGeometry(agent);
    fireEvent.wheel(viewport, { deltaY: -100 });
    viewport.scrollTop = 1560.5; // 39.5px from the bottom: still agent-pinned.
    fireEvent.scroll(viewport);
    expect(agent.queryByRole("button", { name: "Jump" })).toBeNull();
    fireEvent.wheel(viewport, { deltaY: -100 });
    viewport.scrollTop = 1560; // Exactly 40px: detached, as in the old hook.
    fireEvent.scroll(viewport);
    expect(agent.getByRole("button", { name: "Jump" })).toBeDefined();
    agent.unmount();
    const rp = render(<MessageScrollerCore resetKey="rp" displayIds={["m1"]} renderItem={() => <p>RP</p>}
      renderJumpToBottom={(jump) => <button type="button" onClick={jump}>RP jump</button>} />);
    const rpViewport = rp.container.querySelector<HTMLElement>("[data-virtuoso-scroller]")!;
    Object.defineProperties(rpViewport, { clientHeight: { value: 400 }, scrollHeight: { value: 2000 } });
    fireEvent.wheel(rpViewport, { deltaY: -100 });
    rpViewport.scrollTop = 1560.5;
    fireEvent.scroll(rpViewport);
    expect(rp.getByRole("button", { name: "RP jump" })).toBeDefined();
  });

  it("remeasures the lane on observed virtual-content growth without moving a detached reader", () => {
    const observers = new Map<ResizeObserver, { callback: ResizeObserverCallback; targets: Set<Element> }>();
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) { observers.set(this, { callback, targets: new Set() }); }
      observe(target: Element) { observers.get(this)!.targets.add(target); }
      unobserve(target: Element) { observers.get(this)!.targets.delete(target); }
      disconnect() { observers.delete(this); }
    };
    const view = render(feed());
    const viewport = tallGeometry(view);
    fireEvent.wheel(viewport, { deltaY: -100 });
    viewport.scrollTop = 200;
    fireEvent.scroll(viewport);
    const onMeasuredScroll = mock();
    viewport.addEventListener("scroll", onMeasuredScroll);
    const tail = view.container.querySelector("[data-message-stable-tail]")!;
    const tailObservers = [...observers].filter(([, value]) => value.targets.has(tail));
    expect(tailObservers.length).toBeGreaterThan(0); // Prove the geometry seam.
    act(() => {
      for (const [observer, { callback }] of tailObservers) callback([], observer);
    });
    expect(onMeasuredScroll).toHaveBeenCalled();
    expect(viewport.scrollTop).toBe(200);
    expect(view.getByRole("button", { name: "Jump" })).toBeDefined();
    view.unmount();
    expect([...observers.values()].some((value) => value.targets.has(tail))).toBe(false);
    viewport.removeEventListener("scroll", onMeasuredScroll);
  });
});
