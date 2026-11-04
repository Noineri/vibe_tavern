import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { MessageScrollerCoreApi } from "../../chat/message-scroller-core.js";
import { isScrollLayoutNotification } from "../../chat/scroll-layout-notification.js";

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

function controlledLayout(view: ReturnType<typeof render>) {
  const observers = new Map<ResizeObserver, { callback: ResizeObserverCallback; targets: Set<Element> }>();
  globalThis.ResizeObserver = class implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) { observers.set(this, { callback, targets: new Set() }); }
    observe(target: Element) { observers.get(this)!.targets.add(target); }
    unobserve(target: Element) { observers.get(this)!.targets.delete(target); }
    disconnect() { observers.delete(this); }
  };
  // Ref callbacks observe with the controlled observer on the new mount.
  view.rerender(feed("controlled"));
  const tail = view.container.querySelector("[data-message-stable-tail]")!;
  return () => act(() => {
    const matches = [...observers].filter(([, value]) => value.targets.has(tail));
    expect(matches.length).toBeGreaterThan(0);
    for (const [observer, value] of matches) value.callback([], observer);
  });
}

describe("agent feed scroll surface", () => {
  it("the real shared default core releases on a 1px first frame without another input event", () => {
    let api: MessageScrollerCoreApi | undefined;
    const view = render(<MessageScrollerCore resetKey="rp-small" displayIds={["m1"]}
      renderItem={() => <p>RP</p>} overlay={(value) => { api = value; return null; }} />);
    const viewport = view.container.querySelector<HTMLElement>("[data-virtuoso-scroller]")!;
    Object.defineProperties(viewport, { clientHeight: { value: 400 }, scrollHeight: { value: 2000 } });
    act(() => api!.scrollToBottom());
    fireEvent.wheel(viewport, { deltaY: -12 });
    viewport.scrollTop = 1599;
    fireEvent.scroll(viewport);
    expect(api?.pinned).toBe(false);
    viewport.scrollTop = 1590;
    fireEvent.scroll(viewport);
    expect(viewport.scrollTop).toBe(1590);
    expect(api?.pinned).toBe(false);
  });

  it.each(["wheel", "touch", "keyboard", "thumb"] as const)("retains small continuous %s movement through lane measurement and streaming", async (input) => {
    // Install before mount, then acquire observers through the real tail seam.
    const view = render(<></>);
    const resize = controlledLayout(view);
    await act(async () => {});
    const viewport = tallGeometry(view);
    view.rerender(feed("controlled-reset"));
    expect(viewport.scrollTop).toBe(1600);
    fireEvent.scroll(viewport);
    if (input === "wheel") fireEvent.wheel(viewport, { deltaY: -12 });
    if (input === "touch") fireEvent.touchMove(viewport);
    if (input === "keyboard") fireEvent.keyDown(viewport, { key: "ArrowUp" });
    let thumb: Element | null = null;
    if (input === "thumb") {
      await waitFor(() => expect(view.container.querySelector("[data-scroll-thumb]")).not.toBeNull());
      thumb = view.container.querySelector("[data-scroll-thumb]")!;
      fireEvent.pointerDown(thumb, { button: 0, pointerId: 9 });
    }
    resize(); // Measurement between input and native movement must not steal intent.
    viewport.scrollTop = 1588;
    fireEvent.scroll(viewport);
    expect(view.getByRole("button", { name: "Jump" })).toBeDefined();
    resize(); // Layout after the sub-threshold first movement cannot re-pin.
    expect(viewport.scrollTop).toBe(1588);
    viewport.scrollTop = 1576;
    fireEvent.scroll(viewport);
    expect(viewport.scrollTop).toBe(1576);
    view.rerender(feed("controlled-reset", "Streaming update"));
    resize();
    expect(viewport.scrollTop).toBe(1576);
    viewport.scrollTop = 1480;
    fireEvent.scroll(viewport);
    expect(viewport.scrollTop).toBe(1480);
    if (thumb) fireEvent.pointerCancel(thumb, { pointerId: 9 });
    fireEvent.click(view.getByRole("button", { name: "Jump" }));
    expect(viewport.scrollTop).toBe(1600);
    await act(async () => {});
  });

  it("a measurement between wheel input and a large native movement preserves user ownership", async () => {
    const view = render(<></>);
    const resize = controlledLayout(view);
    await act(async () => {});
    const viewport = tallGeometry(view);
    view.rerender(feed("controlled-reset"));
    fireEvent.wheel(viewport, { deltaY: -120 });
    resize();
    viewport.scrollTop = 1480;
    fireEvent.scroll(viewport);
    expect(viewport.scrollTop).toBe(1480);
    expect(view.getByRole("button", { name: "Jump" })).toBeDefined();
    await act(async () => {});
  });

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
    await act(async () => {});
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

  it.each(["wheel", "touch", "keyboard", "editor"] as const)("does not grant outer scroll ownership to nested %s input", async (input) => {
    const view = render(<AgentFeedScroller resetKey="nested" displayIds={["event:snapshot"]}
      renderItem={() => <ScrollArea viewportProps={{ "aria-label": "Frozen detail", style: { overflowY: "auto" } }}>
        <p>Nested detail</p><input aria-label="Inner editor" />
      </ScrollArea>} renderJumpToBottom={(jump) => <button type="button" onClick={jump}>Jump</button>} />);
    await act(async () => {});
    const viewport = tallGeometry(view);
    const inner = view.getByLabelText("Frozen detail");
    Object.defineProperties(inner, { clientHeight: { value: 100 }, scrollHeight: { value: 1000 } });
    inner.scrollTop = 200;
    if (input === "wheel") fireEvent.wheel(inner, { deltaY: -12 });
    if (input === "touch") fireEvent.touchMove(inner);
    if (input === "keyboard") fireEvent.keyDown(inner, { key: "ArrowUp" });
    if (input === "editor") fireEvent.keyDown(view.getByLabelText("Inner editor"), { key: "ArrowUp" });
    viewport.scrollTop = 1588;
    fireEvent.scroll(viewport);
    expect(viewport.scrollTop).toBe(1600);
    expect(view.queryByRole("button", { name: "Jump" })).toBeNull();
    await act(async () => {});
  });

  it("preserves strict 40px versus 2px return geometry without overriding upward reading", () => {
    const agent = render(feed());
    const viewport = tallGeometry(agent);
    fireEvent.wheel(viewport, { deltaY: -100 });
    viewport.scrollTop = 1500;
    fireEvent.scroll(viewport);
    fireEvent.wheel(viewport, { deltaY: 100 });
    viewport.scrollTop = 1560; // Exactly 40px: return still detached.
    fireEvent.scroll(viewport);
    expect(agent.getByRole("button", { name: "Jump" })).toBeDefined();
    viewport.scrollTop = 1560.5; // Returning within 40px re-pins.
    fireEvent.scroll(viewport);
    expect(agent.queryByRole("button", { name: "Jump" })).toBeNull();
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
    const onMeasuredScroll = mock((event: Event) => {
      expect(isScrollLayoutNotification(event)).toBe(true);
    });
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
