/**
 * Shared resizable side pane — behavioral tests (SIDECHAT_PLAN, SC-16b;
 * slide rework SC-16e).
 *
 * Mounts the REAL `ResizableSidePane` with plain content (no stores, no i18n,
 * no fetch) — the only process-global state touched here is `localStorage`,
 * the viewport width and (per reduced-motion test) `window.matchMedia`, all
 * restored after each test.
 *
 * Pins (the SC-16b steps as reworked by SC-16e, plus the SC-14 drag/clamp
 * contract the primitive absorbs):
 *   - opening takes the final width in ONE step (no width transition
 *     remains on the pane) while the slider parks off-screen, then slides
 *     to rest on the 0.18 s transform curve only after the paint gate (the
 *     opening-commit offset + the post-kick rest);
 *   - closing holds the final width while the slider glides out, then
 *     unmounts at the slider's own transform `transitionend` and shows the
 *     closed view (a child transition never unmounts it);
 *   - reduced motion opens and closes instantly (no slide, no wait);
 *   - while the drag line is held the transition is off and the width tracks
 *     the pointer;
 *   - double-click resets to the default through the clamp/write path;
 *   - drag persists and clamps (min, live 50% max), on either edge; a window
 *     resize re-clamps without touching the stored intent.
 *   - SC-16c `keepMounted`: a closed pane stays mounted and hidden (children
 *   alive, the strip mounted but inert, `closedView` ignored) and reopens
 *   onto the stored width; without it the SC-16b unmount contract above is
 *   unchanged.
 *
 * Runner: bun:test with scoped happy-dom.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { ResizableSidePane } from "./resizable-side-pane.js";

useDomEnv();

/** Storage key for the suite (never the sidechat's real key). */
const WIDTH_KEY = "vt.test.sidepane.width";

const PANE = "pane";
const RESIZE = "resize";
const SLIDE = "slide";
const CLOSED = "closed";

/** The reduced-motion query the pane reads (kept as the assertion seam). */
const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

// ── Viewport width control (the pane's 50% max reads window.innerWidth) ────
const innerWidthDescriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");
function setViewportWidth(value: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value });
}

// ── Reduced-motion control (happy-dom ships no matchMedia — stub it) ───────
let realMatchMedia: typeof window.matchMedia | undefined;
let hadMatchMedia = false;
function stubMatchMedia(reduced: boolean): void {
  window.matchMedia = ((query: string) =>
    ({
      matches: query === REDUCED_QUERY ? reduced : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as unknown as typeof window.matchMedia;
}
function restoreMatchMedia(): void {
  if (hadMatchMedia && realMatchMedia !== undefined) window.matchMedia = realMatchMedia;
  else delete (window as unknown as { matchMedia?: unknown }).matchMedia;
}

let render: typeof import("@testing-library/react").render;
let act: typeof import("@testing-library/react").act;
let fireEvent: typeof import("@testing-library/react").fireEvent;

beforeAll(async () => {
  ({ render, act, fireEvent } = await import("@testing-library/react"));
  hadMatchMedia = typeof window.matchMedia === "function";
  realMatchMedia = window.matchMedia;
});

beforeEach(() => {
  restoreMatchMedia();
  localStorage.clear();
  setViewportWidth(1024);
});

afterEach(() => {
  restoreMatchMedia();
});

afterAll(() => {
  restoreMatchMedia();
  if (innerWidthDescriptor) Object.defineProperty(window, "innerWidth", innerWidthDescriptor);
});

function paneElement(open: boolean, edge: "left" | "right" = "left") {
  return (
    <ResizableSidePane
      open={open}
      storageKey={WIDTH_KEY}
      defaultWidth={400}
      minWidth={320}
      resizeEdge={edge}
      panelTestId={PANE}
      resizeHandleTestId={RESIZE}
      slideTestId={SLIDE}
      closedView={<div data-testid={CLOSED}>closed</div>}
    >
      <div>content</div>
    </ResizableSidePane>
  );
}

/** Drain the paint-gate slide kick `setTimeout(0)` inside `act` (a resolved-state wait, never a sleep). */
async function flushKick() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function classTokens(el: HTMLElement): string[] {
  return (el.getAttribute("class") ?? "").split(" ").filter(Boolean);
}

/**
 * Dispatch the slider's own transform `transitionend` (SC-16e: the close
 * path moved from the pane's width transition to the slider's transform
 * transition). happy-dom 20.14.5 ships
 * `TransitionEvent` but drops `propertyName` from its init dict (probed:
 * reads `undefined`), and RTL forwards init straight into the constructor —
 * so `fireEvent.transitionEnd(el, { propertyName })` can never satisfy the
 * slider's property filter. A plain bubbling Event with the expando assigned
 * is what real browsers deliver; dispatch inside `act` so React flushes.
 * Dispatch ON the slider: the handler filters `target === currentTarget`.
 */
function endSlideTransition(el: HTMLElement, propertyName: string): void {
  const end = new Event("transitionend", { bubbles: true, cancelable: true }) as Event & {
    propertyName?: string;
  };
  end.propertyName = propertyName;
  act(() => {
    el.dispatchEvent(end);
  });
}

// ── Open / close animation ──────────────────────────────────────────────────

describe("resizable-side-pane — open/close slide (SC-16b, SC-16e)", () => {
  it("open takes the final width in one step; the slider parks off-screen, then slides to rest after the paint gate", async () => {
    const utils = render(paneElement(false));
    expect(utils.queryByTestId(PANE)).toBeNull();
    expect(utils.getByTestId(CLOSED)).toBeDefined();

    utils.rerender(paneElement(true));
    // Was (SC-16b): the opening commit mounted at width 0 with a width
    // transition armed, gliding 0 → target. Now (SC-16e): the box takes the
    // final width on the opening commit itself — the neighbour steps once —
    // while the slider parks off-screen inside the clip frame.
    const pane = utils.getByTestId(PANE);
    expect(pane.style.width).toBe("400px");
    const tokens = classTokens(pane);
    expect(tokens.includes("transition-[width_0.18s_ease-out]")).toBe(false);
    expect(tokens.includes("transition-none")).toBe(false);
    expect(utils.queryByTestId(CLOSED)).toBeNull();
    const slide = utils.getByTestId(SLIDE);
    expect(slide.style.transform).toBe("translateX(100%)");
    const slideTokens = classTokens(slide);
    expect(slideTokens).toContain("transition-[transform_0.18s_ease-out]");
    expect(slideTokens).toContain("motion-reduce:transition-none");
    expect(slideTokens.includes("transition-none")).toBe(false);

    // ...and the paint-gate kick slides it to rest (same 0.18 s curve).
    await flushKick();
    expect(utils.getByTestId(PANE).style.width).toBe("400px");
    expect(utils.getByTestId(SLIDE).style.transform).toBe("");
  });

  it("a right-edge pane parks off-screen to the left", async () => {
    const utils = render(paneElement(false, "right"));
    utils.rerender(paneElement(true, "right"));
    expect(utils.getByTestId(PANE).style.width).toBe("400px");
    expect(utils.getByTestId(SLIDE).style.transform).toBe("translateX(-100%)");
    await flushKick();
    expect(utils.getByTestId(SLIDE).style.transform).toBe("");
  });

  it("close holds the final width while the slider glides out, then unmounts at the transform transition end", async () => {
    const utils = render(paneElement(true));
    await flushKick();
    expect(utils.getByTestId(PANE).style.width).toBe("400px");

    utils.rerender(paneElement(false));
    // Was (SC-16b): the box glided back to 0 (width 0 mid-close). Now
    // (SC-16e): the box HOLDS the final width — the neighbour stays narrow
    // — while the slider glides out; the closed view waits its turn.
    const closing = utils.getByTestId(PANE);
    expect(closing.style.width).toBe("400px");
    expect(utils.getByTestId(SLIDE).style.transform).toBe("translateX(100%)");
    expect(utils.queryByTestId(CLOSED)).toBeNull();

    // A child transition never unmounts the pane (filtered by target + property).
    endSlideTransition(utils.getByTestId(SLIDE), "opacity");
    expect(utils.getByTestId(PANE)).toBeDefined();

    endSlideTransition(utils.getByTestId(SLIDE), "transform");
    expect(utils.queryByTestId(PANE)).toBeNull();
    expect(utils.getByTestId(CLOSED)).toBeDefined();
  });

  it("reduced motion opens and closes instantly", async () => {
    stubMatchMedia(true);
    const utils = render(paneElement(false));
    expect(utils.getByTestId(CLOSED)).toBeDefined();

    utils.rerender(paneElement(true));
    // No parked offset: the target applies on the opening commit itself and
    // the slider sits at rest (the motion-reduce class kills the CSS too).
    const pane = utils.getByTestId(PANE);
    expect(pane.style.width).toBe("400px");
    expect(utils.getByTestId(SLIDE).style.transform).toBe("");
    expect(classTokens(utils.getByTestId(SLIDE))).toContain("motion-reduce:transition-none");

    utils.rerender(paneElement(false));
    // No slide to wait for: unmounted on the closing commit.
    expect(utils.queryByTestId(PANE)).toBeNull();
    expect(utils.getByTestId(CLOSED)).toBeDefined();
  });
});

// ── Drag: no-transition tracking, reset, clamp ──────────────────────────────

describe("resizable-side-pane — drag line (SC-16b)", () => {
  it("no transition while the line is held; the width tracks the pointer", async () => {
    const utils = render(paneElement(true));
    await flushKick();
    const pane = utils.getByTestId(PANE);

    fireEvent.mouseDown(utils.getByTestId(RESIZE), { button: 0, clientX: 600 });
    // Was (SC-16b): the transition lived on the pane's width. Now (SC-16e):
    // the box never transitions; the slider drops its transform transition
    // while held and sits at rest so the clip never fights the pointer.
    const slide = utils.getByTestId(SLIDE);
    expect(classTokens(pane).includes("transition-none")).toBe(false);
    expect(classTokens(pane).join(" ")).not.toContain("transition-[");
    expect(classTokens(slide).includes("transition-none")).toBe(true);
    expect(slide.style.transform).toBe("");
    // Drag left grows the left-edge pane with the pointer, no lag.
    fireEvent.mouseMove(window, { clientX: 500 });
    expect(pane.style.width).toBe("500px");
    fireEvent.mouseUp(window);

    expect(classTokens(utils.getByTestId(SLIDE)).includes("transition-none")).toBe(false);
    expect(classTokens(utils.getByTestId(SLIDE))).toContain("transition-[transform_0.18s_ease-out]");
    expect(localStorage.getItem(WIDTH_KEY)).toBe("500");
  });

  it("double-click resets to the default through the clamp path", async () => {
    localStorage.setItem(WIDTH_KEY, "500");
    const utils = render(paneElement(true));
    await flushKick();
    expect(utils.getByTestId(PANE).style.width).toBe("500px");

    fireEvent.doubleClick(utils.getByTestId(RESIZE));
    expect(utils.getByTestId(PANE).style.width).toBe("400px");
    expect(localStorage.getItem(WIDTH_KEY)).toBe("400");
  });

  it("the drag clamps at the live 50% max and persists", async () => {
    setViewportWidth(1024);
    const utils = render(paneElement(true));
    await flushKick();
    const pane = utils.getByTestId(PANE);

    fireEvent.mouseDown(utils.getByTestId(RESIZE), { button: 0, clientX: 600 });
    fireEvent.mouseMove(window, { clientX: 0 });
    fireEvent.mouseUp(window);
    expect(pane.style.width).toBe("512px");
    expect(localStorage.getItem(WIDTH_KEY)).toBe("512");
  });

  it("a right-edge pane grows when the line moves right", async () => {
    const utils = render(paneElement(true, "right"));
    await flushKick();
    const pane = utils.getByTestId(PANE);
    expect(pane.style.width).toBe("400px");

    fireEvent.mouseDown(utils.getByTestId(RESIZE), { button: 0, clientX: 600 });
    fireEvent.mouseMove(window, { clientX: 700 });
    fireEvent.mouseUp(window);
    expect(pane.style.width).toBe("500px");
    expect(localStorage.getItem(WIDTH_KEY)).toBe("500");
  });
});

// ── Width: restore + clamp (the absorbed SC-14 contract) ────────────────────

describe("resizable-side-pane — width restore + clamp (SC-14)", () => {
  it("restores the stored width (default 400 when absent)", async () => {
    localStorage.setItem(WIDTH_KEY, "450");
    const first = render(paneElement(true));
    await flushKick();
    expect(first.getByTestId(PANE).style.width).toBe("450px");
    first.unmount();

    localStorage.removeItem(WIDTH_KEY);
    const second = render(paneElement(true));
    await flushKick();
    expect(second.getByTestId(PANE).style.width).toBe("400px");
    second.unmount();
  });

  it("clamps a stored width below the 320 min", async () => {
    localStorage.setItem(WIDTH_KEY, "100");
    const utils = render(paneElement(true));
    await flushKick();
    expect(utils.getByTestId(PANE).style.width).toBe("320px");
  });

  it("a window resize re-clamps the rendered width without touching the stored intent", async () => {
    localStorage.setItem(WIDTH_KEY, "500");
    setViewportWidth(1200);
    const utils = render(paneElement(true));
    await flushKick();
    expect(utils.getByTestId(PANE).style.width).toBe("500px");

    setViewportWidth(800);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(utils.getByTestId(PANE).style.width).toBe("400px");
    expect(localStorage.getItem(WIDTH_KEY)).toBe("500");
  });
});

// ── keepMounted: the SC-16c assistant-pane contract ─────────────────────────

describe("resizable-side-pane — keepMounted collapse (SC-16c)", () => {
  function mountedPaneElement(open: boolean) {
    return (
      <ResizableSidePane
        open={open}
        keepMounted
        storageKey={WIDTH_KEY}
        defaultWidth={400}
        minWidth={320}
        resizeEdge="right"
        panelTestId={PANE}
        resizeHandleTestId={RESIZE}
        slideTestId={SLIDE}
        closedView={<div data-testid={CLOSED}>closed</div>}
      >
        <div>content</div>
      </ResizableSidePane>
    );
  }

  it("close slides out at full width, then stays mounted and hidden with no closed view", async () => {
    const utils = render(mountedPaneElement(true));
    await flushKick();
    expect(utils.getByTestId(PANE).style.width).toBe("400px");

    utils.rerender(mountedPaneElement(false));
    // Was (SC-16b): the close glide headed to width 0. Now (SC-16e): the
    // box holds the final width while the slider glides out (a right-edge
    // pane parks to the left).
    const closing = utils.getByTestId(PANE);
    expect(closing.style.width).toBe("400px");
    expect(utils.getByTestId(SLIDE).style.transform).toBe("translateX(-100%)");
    expect(utils.queryByTestId(CLOSED)).toBeNull();

    endSlideTransition(utils.getByTestId(SLIDE), "transform");
    // Settled: the same aside flipped to hidden — children alive, the strip
    // mounted but inert under display:none, and the closed view never
    // renders (the caller overlays its own expand tab).
    const hidden = utils.getByTestId(PANE);
    expect(hidden.style.width).toBe("0px");
    expect(classTokens(hidden)).toContain("hidden");
    expect(classTokens(hidden).includes("flex")).toBe(false);
    expect(hidden.textContent).toContain("content");
    expect(utils.queryByTestId(CLOSED)).toBeNull();
    expect(utils.getByTestId(RESIZE)).toBeDefined();
  });

  it("a keepMounted pane closed on first mount renders hidden, then reopens onto the stored width", async () => {
    localStorage.setItem(WIDTH_KEY, "450");
    const utils = render(mountedPaneElement(false));
    // No glide to wait for on first mount: hidden immediately, intent kept.
    const hidden = utils.getByTestId(PANE);
    expect(classTokens(hidden)).toContain("hidden");
    expect(hidden.textContent).toContain("content");
    expect(utils.queryByTestId(CLOSED)).toBeNull();

    utils.rerender(mountedPaneElement(true));
    // Was (SC-16b): the box reopened at width 0, then glided to the target.
    // Now (SC-16e): the box takes the stored width on the reopening commit
    // while the slider parks off-screen, then slides to rest after the kick.
    expect(utils.getByTestId(PANE).style.width).toBe("450px");
    expect(utils.getByTestId(SLIDE).style.transform).toBe("translateX(-100%)");
    await flushKick();
    const pane = utils.getByTestId(PANE);
    expect(pane.style.width).toBe("450px");
    expect(utils.getByTestId(SLIDE).style.transform).toBe("");
    expect(classTokens(pane).includes("hidden")).toBe(false);
    expect(utils.getByTestId(RESIZE)).toBeDefined();
  });
});
