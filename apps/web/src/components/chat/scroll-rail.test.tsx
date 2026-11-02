import { describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import type { RailEntry } from "./scroll-rail-model.js";

useDomEnv();
const { render, fireEvent } = await import("@testing-library/react");
const { ScrollRail } = await import("./scroll-rail.js");
const { SidechatHandle } = await import("./sidechat/SidechatHandle.js");
const { ResizableSidePane } = await import("../shared/resizable-side-pane.js");
const { TooltipProvider } = await import("../shared/Tooltip.js");
const { MessageScroller } = await import("./MessageScroller.js");
const layoutCss = await Bun.file(`${import.meta.dir}/chat-rail-layout.css`).text();

const entries: RailEntry[] = Array.from({ length: 12 }, (_, i) => ({
  id: `m${i}`, displayIndex: i + 2, number: i + 120,
  role: i % 2 ? "user" : "assistant", author: i % 2 ? "Noah" : "Keith", snippet: `Scene ${i}`,
}));

function setup(isMobile = false, opener = true, width = 600) {
  const scroller = document.createElement("div");
  scroller.id = "transcript";
  Object.defineProperties(scroller, {
    clientHeight: { value: 400 }, scrollHeight: { value: 2000 }, clientWidth: { value: width },
  });
  const onJump = mock();
  const onTick = mock();
  const content = (showOpener: boolean) => <TooltipProvider>
    <style>{layoutCss}</style>
    <div className="chat-shell">
      <main><div className="chat-rail-layout">
        <ScrollRail entries={entries} scroller={scroller} onJump={onJump} isMobile={isMobile} onTick={onTick} />
      </div></main>
      {showOpener && <SidechatHandle variant="desktop" label="Open sidechat" onOpen={() => {}} />}
    </div>
  </TooltipProvider>;
  const view = render(content(opener));
  const rail = view.getByRole("scrollbar");
  rail.getBoundingClientRect = () => new DOMRect(width - (isMobile ? 28 : 64), 20, isMobile ? 24 : 36, 400);
  rail.setPointerCapture = () => {};
  rail.releasePointerCapture = () => {};
  rail.hasPointerCapture = () => true;
  return { view, rail, scroller, onJump, onTick, setOpener: (show: boolean) => view.rerender(content(show)) };
}

describe("desktop scroll rail", () => {
  it("keeps the full-height hit lane left of the 24px edge toggle with a 4px gap", () => {
    const { rail, onJump } = setup();
    expect(getComputedStyle(rail).right).toBe("28px");
    expect(getComputedStyle(rail).width).toBe("36px");
    // The rail retains the message at the toggle's vertical midpoint.
    fireEvent.pointerDown(rail, { clientY: 220, pointerId: 1, button: 0, pointerType: "mouse" });
    expect(onJump).toHaveBeenLastCalledWith(8);
    fireEvent.pointerUp(rail, { pointerId: 1, pointerType: "mouse" });
  });

  it("starts quiet, previews canonical entries on hover, and closes on leave", () => {
    const { view, rail } = setup();
    expect(view.queryByRole("tooltip")).toBeNull();
    expect(rail.getAttribute("aria-controls")).toBe("transcript");
    fireEvent.pointerMove(rail, { clientY: 220, pointerType: "mouse" });
    const card = view.getByRole("tooltip");
    expect(card.style.maxWidth).toBe("min(360px, max(0px, calc(600px - var(--chat-rail-preview-clearance))))");
    expect(card.textContent).toContain("#126");
    expect(card.textContent).toContain("Keith");
    expect(card.textContent).toContain("Scene 6");
    fireEvent.pointerMove(rail, { clientY: 250, pointerType: "mouse" });
    expect(view.getByRole("tooltip")).toBe(card);
    fireEvent.pointerLeave(rail);
    expect(view.queryByRole("tooltip")).toBeNull();
  });

  it("clicks and live drags use display indices and stop after pointer cancellation", () => {
    const { rail, onJump } = setup();
    fireEvent.pointerDown(rail, { clientY: 20, pointerId: 1, button: 0, pointerType: "mouse" });
    expect(onJump).toHaveBeenLastCalledWith(2);
    fireEvent.pointerMove(rail, { clientY: 419, pointerId: 1, pointerType: "mouse" });
    expect(onJump).toHaveBeenLastCalledWith(13);
    fireEvent.pointerCancel(rail, { pointerId: 1 });
    fireEvent.pointerMove(rail, { clientY: 120, pointerId: 1, pointerType: "mouse" });
    expect(onJump).toHaveBeenCalledTimes(2);
  });

  it("supports keyboard navigation without interpreting canonical numbers as indices", () => {
    const { rail, onJump } = setup();
    fireEvent.focus(rail);
    fireEvent.keyDown(rail, { key: "End" });
    expect(onJump).toHaveBeenLastCalledWith(13);
    fireEvent.keyDown(rail, { key: "Home" });
    expect(onJump).toHaveBeenLastCalledWith(2);
    fireEvent.keyDown(rail, { key: "ArrowDown" });
    expect(onJump).toHaveBeenLastCalledWith(3);
    expect(rail.getAttribute("aria-valuenow")).toBe("2");
  });

  it("has no navigation surface when there are no persisted entries", () => {
    const view = render(<ScrollRail entries={[]} scroller={null} onJump={() => {}} isMobile={false} />);
    expect(view.queryByRole("scrollbar")).toBeNull();
  });

  it("budgets the desktop preview for the inboard offset in a narrow chat pane", () => {
    const { view, rail, setOpener } = setup(false, true, 320);
    fireEvent.pointerMove(rail, { clientY: 220, pointerType: "mouse" });
    const card = view.getByRole("tooltip");
    // happy-dom substitutes custom properties but leaves CSS math unevaluated:
    // these are the same 236px bound with the opener, and 264px without it.
    expect(getComputedStyle(card).maxWidth).toBe("min(360px, max(0px, calc(320px - calc(28px + 36px + 2px + 18px))))");
    expect(getComputedStyle(card).right).toBe("calc(36px + 2px)");
    setOpener(false);
    expect(view.getByRole("tooltip")).toBe(card);
    expect(getComputedStyle(card).maxWidth).toBe("min(360px, max(0px, calc(320px - calc(0px + 36px + 2px + 18px))))");
  });

  it("does not read a removed active entry when the message snapshot shrinks", () => {
    const { view, rail, scroller, onJump } = setup();
    fireEvent.pointerMove(rail, { clientY: 419, pointerType: "mouse" });
    expect(view.getByRole("tooltip").textContent).toContain("#131");
    view.rerender(<ScrollRail entries={entries.slice(0, 2)} scroller={scroller} onJump={onJump} isMobile={false} />);
    expect(view.getByRole("scrollbar").getAttribute("aria-valuemax")).toBe("2");
    expect(view.queryByRole("tooltip")).toBeNull();
  });

  it("hugs the boundary with an open or absent sidechat and reacts to opener replacement without remounting", () => {
    const { view, rail, setOpener, onJump } = setup(false, false);
    expect(getComputedStyle(rail).right).toBe("0px");
    setOpener(true);
    expect(view.getByRole("scrollbar")).toBe(rail);
    expect(getComputedStyle(rail).right).toBe("28px");
    setOpener(false);
    expect(getComputedStyle(rail).right).toBe("0px");
    fireEvent.pointerDown(rail, { clientY: 220, pointerId: 1, button: 0, pointerType: "mouse" });
    expect(onJump).toHaveBeenLastCalledWith(8);
  });

  it("waits for the real close-slide completion before reserving the opener lane", () => {
    const content = (open: boolean) => <TooltipProvider>
      <style>{layoutCss}</style>
      <div className="chat-shell">
        <main><div className="chat-rail-layout"><ScrollRail entries={entries} scroller={null} onJump={() => {}} isMobile={false} /></div></main>
        <ResizableSidePane open={open} storageKey="rail-layout-test-width" defaultWidth={400} minWidth={320} resizeEdge="left"
          slideTestId="slide" closedView={<SidechatHandle variant="desktop" label="Open sidechat" onOpen={() => {}} />}>
          <SidechatHandle variant="panel-close" label="Close sidechat" onToggle={() => {}} />
        </ResizableSidePane>
      </div>
    </TooltipProvider>;
    const view = render(content(true));
    const rail = view.getByRole("scrollbar");
    expect(getComputedStyle(rail).right).toBe("0px");
    view.rerender(content(false));
    expect(getComputedStyle(rail).right).toBe("0px");
    const end = new Event("transitionend", { bubbles: true });
    Object.defineProperty(end, "propertyName", { value: "transform" });
    fireEvent(view.getByTestId("slide"), end);
    expect(view.getByTestId("sidechat-closed").hasAttribute("data-sidechat-opener")).toBe(true);
    expect(getComputedStyle(rail).right).toBe("28px");
    view.rerender(content(true));
    expect(getComputedStyle(rail).right).toBe("0px");
  });

  it("moves the real bottom button with the opener and retains its scroll action", () => {
    const content = (opener: boolean) => <TooltipProvider>
      <style>{layoutCss}</style>
      <div className="chat-shell">
        <main><MessageScroller displayIds={["m0"]} renderItem={() => <div>Message</div>} /></main>
        {opener && <SidechatHandle variant="desktop" label="Open sidechat" onOpen={() => {}} />}
      </div>
    </TooltipProvider>;
    const view = render(content(true));
    const scroller = view.container.querySelector<HTMLElement>("[data-virtuoso-scroller]")!;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 400 }, scrollHeight: { configurable: true, value: 2000 },
    });
    fireEvent.wheel(scroller, { deltaY: -100 });
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    const button = view.container.querySelector<HTMLButtonElement>(".chat-rail-bottom-button")!;
    expect(button).not.toBeNull();
    expect(getComputedStyle(button).right).toBe("calc(28px + 36px + 24px)");
    view.rerender(content(false));
    expect(getComputedStyle(button).right).toBe("calc(0px + 36px + 24px)");
    fireEvent.click(button);
    expect(scroller.scrollTop).toBe(1600);
    expect(view.container.querySelector(".chat-rail-bottom-button")).toBeNull();
  });
});

describe("mobile scroll rail", () => {
  it("scrubs only from the inboard handle, shares the preview, and ticks once per selected message", () => {
    const { view, rail, onJump, onTick } = setup(true);
    expect(rail.classList.contains("pointer-events-none")).toBe(true);
    const handle = rail.querySelector<HTMLElement>("[data-rail-handle]")!;
    expect(handle.classList.contains("touch-none")).toBe(true);
    expect(rail.classList.contains("right-1")).toBe(true);
    fireEvent.pointerDown(rail, { pointerId: 1, clientY: 220, pointerType: "touch", button: 0 });
    expect(onJump).not.toHaveBeenCalled();
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 220, pointerType: "touch", button: 0 });
    expect(view.getByRole("tooltip").textContent).toContain("#126");
    expect(onTick).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(rail, { pointerId: 2, clientY: 20, pointerType: "touch" });
    expect(onJump).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(rail, { pointerId: 1, clientY: 221, pointerType: "touch" });
    expect(onTick).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(rail, { pointerId: 1, clientY: 419, pointerType: "touch" });
    expect(onJump).toHaveBeenLastCalledWith(13);
    expect(onTick).toHaveBeenCalledTimes(2);
    fireEvent.pointerUp(rail, { pointerId: 1, pointerType: "touch" });
    expect(view.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerMove(rail, { pointerId: 1, clientY: 20, pointerType: "touch" });
    expect(onJump).toHaveBeenCalledTimes(2);
  });

  it("pointer cancellation ends a scrub and permits a fresh capture", () => {
    const { view, rail, onJump } = setup(true);
    const handle = rail.querySelector<HTMLElement>("[data-rail-handle]")!;
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 20, pointerType: "touch", button: 0 });
    fireEvent.pointerCancel(rail, { pointerId: 1, pointerType: "touch" });
    expect(view.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerDown(handle, { pointerId: 2, clientY: 419, pointerType: "touch", button: 0 });
    expect(onJump).toHaveBeenLastCalledWith(13);
    expect(view.getByRole("tooltip").textContent).toContain("#131");
  });
});
