import { describe, expect, it, mock } from "bun:test";
import { createRef } from "react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();
const { act, fireEvent, render, waitFor } = await import("@testing-library/react");
const { ScrollArea } = await import("./scroll-area.js");

describe("ScrollArea", () => {
  it("preserves a semantic root and keeps viewport/content layout separate", async () => {
    const view = render(<ScrollArea render={<section />} className="max-h-[50%]" contentClassName="py-2" scrollbarSize="thin">
      <button type="button">Choose character</button>
    </ScrollArea>);
    await act(async () => {});
    const root = view.container.firstElementChild!;
    expect(root.tagName).toBe("SECTION");
    expect(root.classList.contains("max-h-[50%]")).toBe(true);
    const viewport = root.querySelector<HTMLElement>("[data-scroll-viewport]")!;
    expect(viewport.classList.contains("scrollbar-hide")).toBe(true);
    expect(viewport.style.overflowX).toBe("hidden");
    const content = viewport.querySelector("[data-scroll-content]")!;
    expect(content.classList.contains("py-2")).toBe(true);
    expect(content.contains(view.getByRole("button", { name: "Choose character" }))).toBe(true);
  });

  it.each([["thin", "w-[3px]"], ["regular", "w-2"]] as const)("uses %s custom chrome on a native scroll viewport", async (scrollbarSize, widthClass) => {
    const ref = createRef<HTMLDivElement>();
    const onScroll = mock();
    const view = render(<ScrollArea scrollbarSize={scrollbarSize} viewportProps={{ ref, onScroll }}><p>Story list</p></ScrollArea>);
    const viewport = ref.current!;
    expect(viewport.hasAttribute("data-scroll-viewport")).toBe(true);
    Object.defineProperties(viewport, {
      clientHeight: { value: 100 }, scrollHeight: { value: 1000 },
      clientWidth: { value: 200 }, scrollWidth: { value: 200 },
    });
    await act(async () => { viewport.scrollTop = 200; fireEvent.scroll(viewport); });
    await waitFor(() => expect(view.container.querySelector("[data-scroll-thumb]")).not.toBeNull());
    const track = view.container.querySelector("[data-scroll-track]")!;
    expect(track.classList.contains(widthClass)).toBe(true);
    expect(track.getAttribute("aria-hidden")).toBe("true");
    expect(viewport.tabIndex).toBe(0);
    expect(viewport.scrollTop).toBe(200);
    expect(onScroll).toHaveBeenCalled();
    expect(view.container.querySelector("[data-scroll-content]")!.textContent).toBe("Story list");
  });

  it("has no scrollbar or keyboard stop without overflow and keeps children mounted on updates", async () => {
    const view = render(<ScrollArea><input aria-label="Draft" defaultValue="Keep me" /></ScrollArea>);
    await act(async () => {});
    const input = view.getByRole("textbox");
    expect(view.container.querySelector("[data-scroll-track]")).toBeNull();
    expect(view.container.querySelector<HTMLElement>("[data-scroll-viewport]")!.tabIndex).toBe(-1);
    view.rerender(<ScrollArea scrollbarSize="thin"><input aria-label="Draft" defaultValue="Keep me" /></ScrollArea>);
    await act(async () => {});
    expect(view.getByRole("textbox")).toBe(input);
  });
});
