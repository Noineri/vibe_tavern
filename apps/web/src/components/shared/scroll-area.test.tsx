import { describe, expect, it, mock } from "bun:test";
import { createRef } from "react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();
const { act, fireEvent, render, waitFor } = await import("@testing-library/react");
const { ScrollArea } = await import("./scroll-area.js");

describe("ScrollArea", () => {
  it("declares mobile content-track hiding separately from native chrome; only composer lanes survive", async () => {
    const css = await Bun.file(`${import.meta.dir}/../../styles.css`).text();
    expect(css).toContain("@media (max-width: 768px), (hover: none) and (pointer: coarse)");
    expect(css).toContain(":where(:not(textarea)) { scrollbar-width: none; }");
    expect(css).toContain(":not(textarea)::-webkit-scrollbar { display: none; }");
    // Owner ruling 2026-11-02 (CNR-8n rider on CNR-8o): phones hide EVERY DOM
    // lane except the composer family's — the selector excludes exactly the
    // composer marker, not editor roots (flipped form fields hide too).
    expect(css).toContain("[data-scroll-area]:not([data-scroll-composer]) > [data-scroll-track]");
    const view = render(<>
      <ScrollArea viewportProps={{ "aria-label": "List" }}>Characters</ScrollArea>
      <ScrollArea scrollbarSize="thin" viewportRender={<textarea aria-label="Draft" readOnly value="Keep this draft" />} />
    </>);
    await act(async () => {});
    expect(view.getByLabelText("List").closest("[data-scroll-area]")!.hasAttribute("data-scroll-editor")).toBe(false);
    const textarea = view.getByRole("textbox");
    // `data-scroll-editor` still marks editor roots (the textarea IS the
    // viewport), but it no longer earns phone visibility — only the composer
    // marker does, and this plain editor root carries no such marker.
    expect(textarea.closest("[data-scroll-area]")!.hasAttribute("data-scroll-editor")).toBe(true);
    expect(textarea.closest("[data-scroll-area]")!.hasAttribute("data-scroll-composer")).toBe(false);
    expect(textarea.hasAttribute("data-scroll-viewport")).toBe(true);
  });

  it.each(["thin", "regular"] as const)("maps the %s geometry through the stylesheet custom-property contract", async (scrollbarSize) => {
    const css = await Bun.file(`${import.meta.dir}/../../styles.css`).text();
    // jsdom/happy-dom does not apply real CSS; pin the contract where it lives:
    // the variant budgets (3/5/5px thin — minimal default lane, owner ruling
    // 2026-11-02, static 8px regular) in styles.css, keyed off the root
    // data-scroll-area variant the component renders.
    if (scrollbarSize === "thin") {
      expect(css).toContain('[data-scroll-area="thin"]');
      expect(css).toContain("--vt-scrollbar-thumb: 3px;");
      expect(css).toContain("--vt-scrollbar-thumb-hover: 5px;");
      expect(css).toContain("--vt-scrollbar-lane: 5px;");
    } else {
      // `regular` is the default: the bare root selector carries the static 8px
      // mapping, so unmigrated consumers keep today's exact appearance.
      expect(css).toContain('[data-scroll-area="thin"]');
      expect(css).toContain("--vt-scrollbar-thumb: 8px;");
      expect(css).toContain("--vt-scrollbar-thumb-hover: 8px;");
      expect(css).toContain("--vt-scrollbar-lane: 8px;");
    }
    expect(css).toContain('[data-scroll-track][data-orientation="vertical"] { width: var(--vt-scrollbar-lane); }');
    expect(css).toContain('[data-scroll-track][data-orientation="horizontal"] { height: var(--vt-scrollbar-lane); }');
    expect(css).toContain('@media (hover: hover)');
    expect(css).toContain('[data-orientation="vertical"]:hover > [data-scroll-thumb] { width: var(--vt-scrollbar-thumb-hover); }');
    expect(css).toContain('[data-orientation="horizontal"]:hover > [data-scroll-thumb] { height: var(--vt-scrollbar-thumb-hover); }');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    // The override must MATCH the base transition rules' specificity
    // ([data-scroll-track][data-orientation=…] > thumb): a lower-specificity
    // selector never wins and the 120ms transition survives reduce (found in
    // the CNR-8q/8r browser batch — same bug in the frame script CSS).
    expect(css).toContain(
      '[data-scroll-track][data-orientation] > [data-scroll-thumb] { transition: none; }',
    );
  });

  it.each(["thin", "regular"] as const)("overrides intrinsic Content sizing with the vertical viewport width (%s)", async (scrollbarSize) => {
    const name = "LongUnbrokenCharacterName".repeat(20);
    const view = render(<ScrollArea scrollbarSize={scrollbarSize} style={{ width: 247 }} contentClassName="flex flex-col px-2">
      <span className="truncate">{name}</span>
      <button type="button">Row actions</button>
    </ScrollArea>);
    await act(async () => {});
    const content = view.container.querySelector<HTMLElement>("[data-scroll-content]")!;
    // Pin the rendered inline override: a utility cannot beat Base UI's inline fit-content.
    // Browser acceptance separately checks computed layout, ellipsis and pointer reachability.
    expect(Number.parseFloat(content.style.minWidth)).toBe(0);
    expect(content.style.width).toBe("100%");
    expect(content.classList.contains("px-2")).toBe(true);
    expect(content.textContent).toContain(name);
  });

  it("uses a textarea itself as viewport and remeasures value changes without replacing it", async () => {
    const ref = createRef<HTMLTextAreaElement>();
    const node = (value: string) => <ScrollArea scrollbarSize="thin" viewportRender={<textarea ref={ref} aria-label="Native draft" value={value} readOnly />} />;
    const view = render(node("Short draft"));
    await act(async () => {});
    const textarea = view.getByRole("textbox");
    expect(ref.current === textarea).toBe(true);
    expect(textarea.hasAttribute("data-scroll-viewport")).toBe(true);
    expect(textarea.tabIndex).toBe(0);
    expect(view.container.querySelector("[data-scroll-content]")).toBeNull();
    let height = 100;
    Object.defineProperties(textarea, {
      clientHeight: { value: 100 }, scrollHeight: { get: () => height },
      clientWidth: { value: 200 }, scrollWidth: { value: 200 },
    });
    height = 1000;
    await act(async () => view.rerender(node("Long draft")));
    await waitFor(() => expect(view.container.querySelector("[data-scroll-thumb]")).not.toBeNull());
    expect(view.getByRole("textbox")).toBe(textarea);
    expect(textarea.scrollTop).toBe(0);
    height = 100;
    await act(async () => view.rerender(node("")));
    await waitFor(() => expect(view.container.querySelector("[data-scroll-track]")).toBeNull());
    expect(textarea.tabIndex).toBe(0);
  });

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

  it("mounts a vertical lane with the library orientation state on a native scroll viewport", async () => {
    const ref = createRef<HTMLDivElement>();
    const onScroll = mock();
    const view = render(<ScrollArea scrollbarSize="thin" viewportProps={{ ref, onScroll }}><p>Story list</p></ScrollArea>);
    const viewport = ref.current!;
    expect(viewport.hasAttribute("data-scroll-viewport")).toBe(true);
    Object.defineProperties(viewport, {
      clientHeight: { value: 100 }, scrollHeight: { value: 1000 },
      clientWidth: { value: 200 }, scrollWidth: { value: 200 },
    });
    await act(async () => { viewport.scrollTop = 200; fireEvent.scroll(viewport); });
    await waitFor(() => expect(view.container.querySelector("[data-scroll-thumb]")).not.toBeNull());
    const root = view.container.querySelector<HTMLElement>("[data-scroll-area]")!;
    const track = view.container.querySelector<HTMLElement>("[data-scroll-track]")!;
    // Geometry lives in the stylesheet keyed off these hooks: the variant on the
    // root, the orientation the installed library already mirrors per track.
    expect(root.getAttribute("data-scroll-area")).toBe("thin");
    expect(track.getAttribute("data-orientation")).toBe("vertical");
    expect(track.getAttribute("aria-hidden")).toBe("true");
    expect(track.querySelector<HTMLElement>("[data-scroll-thumb]")!.classList.contains("ms-auto")).toBe(true);
    expect(viewport.tabIndex).toBe(0);
    expect(viewport.scrollTop).toBe(200);
    expect(onScroll).toHaveBeenCalled();
    expect(view.container.querySelector("[data-scroll-content]")!.textContent).toBe("Story list");
  });

  it("renders exactly two lanes and one corner over one biaxial scroller", async () => {
    const view = render(<ScrollArea orientation="both" scrollbarSize="thin"><pre>{"wide\ncode".repeat(40)}</pre></ScrollArea>);
    await act(async () => {});
    const viewport = view.container.querySelector<HTMLElement>("[data-scroll-viewport]")!;
    Object.defineProperties(viewport, {
      clientHeight: { value: 100 }, scrollHeight: { value: 1000 },
      clientWidth: { value: 200 }, scrollWidth: { value: 2000 },
    });
    await act(async () => { viewport.scrollTop = 100; viewport.scrollLeft = 100; fireEvent.scroll(viewport); });
    await waitFor(() => expect(view.container.querySelectorAll("[data-scroll-track]")).toHaveLength(2));
    const tracks = [...view.container.querySelectorAll<HTMLElement>("[data-scroll-track]")];
    expect(tracks.map((track) => track.getAttribute("data-orientation")).sort()).toEqual(["horizontal", "vertical"]);
    const corner = view.container.querySelector<HTMLElement>("[data-scroll-corner]")!;
    expect(corner.getAttribute("aria-hidden")).toBe("true");
    expect(corner.classList.contains("pointer-events-none")).toBe(true);
    // One scroller: biaxial never clips an axis and keeps Base UI's inline
    // fit-content Content so wide content really overflows the viewport.
    expect(view.container.querySelectorAll("[data-scroll-viewport]")).toHaveLength(1);
    expect(viewport.style.overflowX).toBe("");
    expect(viewport.style.overflowY).toBe("");
    const content = view.container.querySelector<HTMLElement>("[data-scroll-content]")!;
    expect(content.style.width).toBe("");
    expect(content.style.minWidth).toBe("fit-content");
  });

  it("renders a single horizontal lane that clips the vertical axis", async () => {
    const view = render(<ScrollArea orientation="horizontal" scrollbarSize="thin"><div className="w-[2000px]">Row</div></ScrollArea>);
    await act(async () => {});
    const viewport = view.container.querySelector<HTMLElement>("[data-scroll-viewport]")!;
    expect(viewport.style.overflowY).toBe("hidden");
    expect(viewport.style.overflowX).toBe("");
    Object.defineProperties(viewport, {
      clientHeight: { value: 100 }, scrollHeight: { value: 100 },
      clientWidth: { value: 200 }, scrollWidth: { value: 2000 },
    });
    await act(async () => { viewport.scrollLeft = 100; fireEvent.scroll(viewport); });
    await waitFor(() => expect(view.container.querySelector('[data-scroll-track][data-orientation="horizontal"]')).not.toBeNull());
    expect(view.container.querySelectorAll("[data-scroll-track]")).toHaveLength(1);
    expect(view.container.querySelector("[data-scroll-corner]")).toBeNull();
    expect(view.container.querySelector<HTMLElement>("[data-scroll-thumb]")!.classList.contains("mt-auto")).toBe(true);
  });

  it("holds the expanded-thumb drag latch from lane pointerdown until release", async () => {
    const view = render(<ScrollArea scrollbarSize="thin"><p>Long story list</p></ScrollArea>);
    await act(async () => {});
    const viewport = view.container.querySelector<HTMLElement>("[data-scroll-viewport]")!;
    Object.defineProperties(viewport, {
      clientHeight: { value: 100 }, scrollHeight: { value: 1000 },
      clientWidth: { value: 200 }, scrollWidth: { value: 200 },
    });
    await act(async () => { viewport.scrollTop = 200; fireEvent.scroll(viewport); });
    await waitFor(() => expect(view.container.querySelector("[data-scroll-track]")).not.toBeNull());
    const track = view.container.querySelector<HTMLElement>("[data-scroll-track]")!;
    // Base UI 1.9.0 has no dragging state; data-dragging is the named
    // approximation (see scroll-area.tsx) that CSS keys the 5px thumb on.
    expect(track.hasAttribute("data-dragging")).toBe(false);
    fireEvent.pointerDown(track, { button: 2, pointerId: 1 });
    expect(track.hasAttribute("data-dragging")).toBe(false);
    fireEvent.pointerDown(track, { button: 0, pointerId: 1 });
    expect(track.hasAttribute("data-dragging")).toBe(true);
    fireEvent.pointerCancel(track, { pointerId: 1 });
    expect(track.hasAttribute("data-dragging")).toBe(false);
    fireEvent.pointerDown(track, { button: 0, pointerId: 2 });
    expect(track.hasAttribute("data-dragging")).toBe(true);
    fireEvent.pointerUp(track, { pointerId: 2 });
    expect(track.hasAttribute("data-dragging")).toBe(false);
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
