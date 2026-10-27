import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv({ failOnNetwork: true });

const { act, render } = await import("@testing-library/react");
const { MobileVariantCarousel } = await import("./mobile-variant-carousel.js");

const originalObserver = globalThis.ResizeObserver;
const originalWindowObserver = window.ResizeObserver;
const originalScrollEnd = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "onscrollend");
const observers = new Set<MeasuredResizeObserver>();

class MeasuredResizeObserver implements ResizeObserver {
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); observers.delete(this); }
}

function restoreBrowserBoundaries() {
  globalThis.ResizeObserver = originalObserver;
  window.ResizeObserver = originalWindowObserver;
  if (originalScrollEnd) Object.defineProperty(HTMLElement.prototype, "onscrollend", originalScrollEnd);
  else Reflect.deleteProperty(HTMLElement.prototype, "onscrollend");
}

beforeEach(() => {
  restoreBrowserBoundaries();
  globalThis.ResizeObserver = MeasuredResizeObserver;
  window.ResizeObserver = MeasuredResizeObserver;
  // happy-dom does not implement scrolling physics. Exercise the real native
  // event wiring here; deterministic fallback cases live in the core tests.
  Object.defineProperty(HTMLElement.prototype, "onscrollend", { configurable: true, value: null });
});
afterEach(restoreBrowserBoundaries);
afterAll(restoreBrowserBoundaries);

const variants = Array.from({ length: 7 }, (_, index) => ({
  id: `variant-${index}`,
  content: `Variant **${index}**`,
}));

function mount(overrides: Partial<Parameters<typeof MobileVariantCarousel>[0]> = {}) {
  const onSelectVariant = mock((_index: number, _direction: -1 | 1) => {});
  let props = { variants, selectedVariantIndex: 2, isBusy: false, onSelectVariant, ...overrides };
  const view = render(<MobileVariantCarousel {...props} />);
  const viewport = view.getByTestId("mobile-variant-carousel");
  const heights = new Map(variants.map((_, index) => [index, 100 + index * 50]));
  let width = 320;

  function slots() { return [...viewport.querySelectorAll<HTMLElement>("[data-variant-index]")]; }
  function notify(target: Element) {
    for (const observer of [...observers]) {
      if (observer.targets.has(target)) observer.callback([], observer);
    }
  }
  // Geometry is local to these instances; no prototype layout patches.
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, width, 0);
  viewport.style.columnGap = "12px";
  for (const slot of slots()) {
    slot.getBoundingClientRect = () => new DOMRect(0, 0, width, heights.get(Number(slot.dataset.variantIndex)) ?? 0);
  }
  act(() => { notify(viewport); for (const slot of slots()) notify(slot); });

  return {
    ...view, viewport, slots, heights, onSelectVariant,
    update(next: Partial<typeof props>) {
      props = { ...props, ...next };
      view.rerender(<MobileVariantCarousel {...props} />);
    },
    resize(nextWidth: number) {
      width = nextWidth;
      act(() => { notify(viewport); });
    },
    measurePanel(index: number) { act(() => { const slot = slots()[index]; if (slot) notify(slot); }); },
    scroll(left: number) {
      act(() => { viewport.scrollLeft = left; viewport.dispatchEvent(new Event("scroll")); });
    },
    settle() { act(() => { viewport.dispatchEvent(new Event("scrollend")); }); },
  };
}

describe("MobileVariantCarousel — native pager", () => {
  test("uses equal full-width snap slots, with only current ±1 content mounted", () => {
    const s = mount();
    expect(s.slots().length).toBe(7);
    expect(s.viewport.classList.contains("overflow-x-auto")).toBe(true);
    expect(s.viewport.classList.contains("overflow-y-hidden")).toBe(true);
    expect(s.viewport.classList.contains("snap-x")).toBe(true);
    expect(s.viewport.classList.contains("snap-mandatory")).toBe(true);
    expect(s.viewport.classList.contains("gap-3")).toBe(true);
    expect(s.viewport.classList.contains("scrollbar-hide")).toBe(true);
    expect(s.viewport.classList.contains("overscroll-x-contain")).toBe(true);
    expect(s.viewport.style.userSelect).not.toBe("none");
    expect(s.viewport.style.touchAction).not.toBe("pan-y");
    for (const [index, slot] of s.slots().entries()) {
      expect(slot.classList.contains("w-full")).toBe(true);
      expect(slot.classList.contains("shrink-0")).toBe(true);
      expect(slot.classList.contains("snap-start")).toBe(true);
      expect(slot.classList.contains("snap-always")).toBe(true);
      expect(slot.className).not.toMatch(/(?:^|\s)p[lr]-/);
      expect(slot.textContent).toBe(index >= 1 && index <= 3 ? `Variant ${index}` : "");
    }
  });

  test("hides every neighbor from accessibility, translation and interaction", () => {
    const s = mount();
    for (const [index, slot] of s.slots().entries()) {
      expect(slot.getAttribute("aria-hidden")).toBe(index === 2 ? null : "true");
      expect(slot.getAttribute("translate")).toBe(index === 2 ? "yes" : "no");
      expect(slot.hasAttribute("inert")).toBe(index !== 2);
      expect(slot.classList.contains("pointer-events-none")).toBe(index !== 2);
    }
  });

  test("waits for settle, ignores cancellation noise, and includes the track gap in the index", () => {
    const s = mount();
    s.scroll(800);
    act(() => { s.viewport.dispatchEvent(new Event("pointercancel")); });
    expect(s.onSelectVariant.mock.calls).toEqual([]);
    s.scroll(996); // 3 × (320 + 12).
    s.settle();
    s.settle();
    expect(s.onSelectVariant.mock.calls).toEqual([[3, 1]]);
  });

  test("retains overlapping variant panels and supports the next swipe immediately", () => {
    const s = mount();
    const previousCurrent = s.slots()[2];
    const previousNeighbor = s.slots()[3];
    s.scroll(996);
    s.settle();
    s.update({ selectedVariantIndex: 3 });
    expect(s.slots()[2]).toBe(previousCurrent);
    expect(s.slots()[3]).toBe(previousNeighbor);
    expect(s.slots()[1]?.textContent).toBe("");
    expect(s.slots()[4]?.textContent).toBe("Variant 4");
    s.scroll(664);
    s.settle();
    expect(s.onSelectVariant.mock.calls).toEqual([[3, 1], [2, -1]]);
  });

  test("aligns on mount, resize, external selection and deletion, not on a height-only resize", () => {
    const s = mount();
    expect(s.viewport.scrollLeft).toBe(664);
    s.resize(360);
    expect(s.viewport.scrollLeft).toBe(744);
    s.scroll(800);
    s.resize(360);
    s.measurePanel(2);
    expect(s.viewport.scrollLeft).toBe(800);
    s.update({ selectedVariantIndex: 3 });
    expect(s.viewport.scrollLeft).toBe(1116);
    const selectedPanel = s.slots()[3];
    s.update({ variants: variants.slice(1), selectedVariantIndex: 2 });
    expect(s.slots()[2]).toBe(selectedPanel);
    expect(s.viewport.scrollLeft).toBe(744);
    expect(s.onSelectVariant.mock.calls).toEqual([]);
  });

  test("fits the current panel, stays locked during drag, and observes the newly selected height", () => {
    const s = mount();
    expect(s.viewport.style.height).toBe("200px");
    s.scroll(996);
    expect(s.viewport.style.height).toBe("200px");
    s.settle();
    s.update({ selectedVariantIndex: 3 });
    expect(s.viewport.style.height).toBe("250px");
    s.heights.set(3, 600);
    s.measurePanel(3);
    expect(s.viewport.style.height).toBe("600px");
  });

  test("locks text swipes while busy, including an already moving track", () => {
    const s = mount();
    s.scroll(996);
    s.update({ isBusy: true });
    expect(s.viewport.classList.contains("overflow-x-hidden")).toBe(true);
    expect(s.viewport.classList.contains("overflow-x-auto")).toBe(false);
    expect(s.viewport.scrollLeft).toBe(664);
    s.scroll(996);
    s.settle();
    expect(s.onSelectVariant.mock.calls).toEqual([]);
    expect(s.viewport.scrollLeft).toBe(664);
    s.update({ isBusy: false });
    s.scroll(996);
    s.settle();
    expect(s.onSelectVariant.mock.calls).toEqual([[3, 1]]);
  });

  test("allows image-slot swipes while busy and uses the latest completion callback", () => {
    const s = mount({ isBusy: true, swipeWhileBusy: true });
    const latest = mock((_index: number, _direction: -1 | 1) => {});
    s.update({ onSelectVariant: latest });
    expect(s.viewport.classList.contains("overflow-x-auto")).toBe(true);
    s.scroll(996);
    s.settle();
    expect(s.onSelectVariant.mock.calls).toEqual([]);
    expect(latest.mock.calls).toEqual([[3, 1]]);
  });

  test("renders custom image panels through the same bounded window", () => {
    const s = mount({ renderPanel: (position) => <button type="button">Image {position}</button> });
    expect(s.slots()[1]?.textContent).toBe("Image 1");
    expect(s.slots()[2]?.textContent).toBe("Image 2");
    expect(s.slots()[3]?.textContent).toBe("Image 3");
    expect(s.slots()[0]?.textContent).toBe("");
    expect(s.viewport.textContent).not.toContain("Variant");
  });

  test("unmount disconnects measurement and settle listeners", () => {
    const s = mount();
    s.scroll(996);
    s.unmount();
    s.settle();
    expect(s.onSelectVariant.mock.calls).toEqual([]);
    expect(observers.size).toBe(0);
  });
});
