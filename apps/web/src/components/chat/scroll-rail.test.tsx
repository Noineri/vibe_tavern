import { describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import type { RailEntry } from "./scroll-rail-model.js";

useDomEnv();
const { render, fireEvent } = await import("@testing-library/react");
const { ScrollRail } = await import("./scroll-rail.js");

const entries: RailEntry[] = Array.from({ length: 12 }, (_, i) => ({
  id: `m${i}`, displayIndex: i + 2, number: i + 120,
  role: i % 2 ? "user" : "assistant", author: i % 2 ? "Noah" : "Keith", snippet: `Scene ${i}`,
}));

function setup(isMobile = false) {
  const scroller = document.createElement("div");
  scroller.id = "transcript";
  Object.defineProperties(scroller, {
    clientHeight: { value: 400 }, scrollHeight: { value: 2000 }, clientWidth: { value: 600 },
  });
  const onJump = mock();
  const onTick = mock();
  const view = render(<ScrollRail entries={entries} scroller={scroller} onJump={onJump} isMobile={isMobile} onTick={onTick} />);
  const rail = view.getByRole("scrollbar");
  rail.getBoundingClientRect = () => new DOMRect(isMobile ? 572 : 536, 20, isMobile ? 24 : 36, 400);
  rail.setPointerCapture = () => {};
  rail.releasePointerCapture = () => {};
  rail.hasPointerCapture = () => true;
  return { view, rail, scroller, onJump, onTick };
}

describe("desktop scroll rail", () => {
  it("keeps the full-height hit lane left of the 24px edge toggle with a 4px gap", () => {
    const { rail, onJump } = setup();
    expect(rail.classList.contains("right-7")).toBe(true);
    expect(rail.classList.contains("right-0")).toBe(false);
    expect(rail.classList.contains("w-9")).toBe(true);
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
    expect(card.style.maxWidth).toBe("360px");
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
    const scroller = document.createElement("div");
    Object.defineProperties(scroller, {
      clientHeight: { value: 400 }, scrollHeight: { value: 2000 }, clientWidth: { value: 320 },
    });
    const view = render(<ScrollRail entries={entries} scroller={scroller} onJump={() => {}} isMobile={false} />);
    const rail = view.getByRole("scrollbar");
    rail.getBoundingClientRect = () => new DOMRect(256, 20, 36, 400);
    fireEvent.pointerMove(rail, { clientY: 220, pointerType: "mouse" });
    expect(view.getByRole("tooltip").style.maxWidth).toBe("236px");
  });

  it("does not read a removed active entry when the message snapshot shrinks", () => {
    const { view, rail, scroller, onJump } = setup();
    fireEvent.pointerMove(rail, { clientY: 419, pointerType: "mouse" });
    expect(view.getByRole("tooltip").textContent).toContain("#131");
    view.rerender(<ScrollRail entries={entries.slice(0, 2)} scroller={scroller} onJump={onJump} isMobile={false} />);
    expect(view.getByRole("scrollbar").getAttribute("aria-valuemax")).toBe("2");
    expect(view.queryByRole("tooltip")).toBeNull();
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
