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

function setup() {
  const scroller = document.createElement("div");
  scroller.id = "transcript";
  Object.defineProperties(scroller, {
    clientHeight: { value: 400 }, scrollHeight: { value: 2000 }, clientWidth: { value: 600 },
  });
  const onJump = mock();
  const view = render(<ScrollRail entries={entries} scroller={scroller} onJump={onJump} isMobile={false} />);
  const rail = view.getByRole("scrollbar");
  rail.getBoundingClientRect = () => new DOMRect(564, 20, 36, 400);
  rail.setPointerCapture = () => {};
  rail.releasePointerCapture = () => {};
  rail.hasPointerCapture = () => true;
  return { view, rail, onJump };
}

describe("desktop scroll rail", () => {
  it("starts quiet, previews canonical entries on hover, and closes on leave", () => {
    const { view, rail } = setup();
    expect(view.queryByRole("tooltip")).toBeNull();
    expect(rail.getAttribute("aria-controls")).toBe("transcript");
    fireEvent.pointerMove(rail, { clientY: 220, pointerType: "mouse" });
    const card = view.getByRole("tooltip");
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
});
