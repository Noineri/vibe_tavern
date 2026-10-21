/**
 * Shared resizable side pane — behavioral tests (SIDECHAT_PLAN, SC-16b).
 *
 * Mounts the REAL `ResizableSidePane` with plain content (no stores, no i18n,
 * no fetch) — the only process-global state touched here is `localStorage`,
 * the viewport width and (per reduced-motion test) `window.matchMedia`, all
 * restored after each test.
 *
 * Pins (the five named SC-16b steps, plus the SC-14 drag/clamp contract the
 * primitive absorbs):
 *   - opening mounts at width 0 with the width transition armed, then glides
 *     to the stored width;
 *   - closing keeps the pane mounted at width 0 until the pane's own width
 *     `transitionend`, then unmounts and shows the closed view (a child
 *     transition never unmounts it);
 *   - reduced motion opens and closes instantly (no 0-phase, no wait);
 *   - while the drag line is held the transition is off and the width tracks
 *     the pointer;
 *   - double-click resets to the default through the clamp/write path;
 *   - drag persists and clamps (min, live 50% max), on either edge; a window
 *     resize re-clamps without touching the stored intent.
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
      closedView={<div data-testid={CLOSED}>closed</div>}
    >
      <div>content</div>
    </ResizableSidePane>
  );
}

/** Drain the open-kick `setTimeout(0)` inside `act` (a resolved-state wait, never a sleep). */
async function flushKick() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function classTokens(el: HTMLElement): string[] {
  return (el.getAttribute("class") ?? "").split(" ").filter(Boolean);
}

/**
 * Dispatch the pane's own width `transitionend`. happy-dom 20.14.5 ships
 * `TransitionEvent` but drops `propertyName` from its init dict (probed:
 * reads `undefined`), and RTL forwards init straight into the constructor —
 * so `fireEvent.transitionEnd(el, { propertyName })` can never satisfy the
 * pane's property filter. A plain bubbling Event with the expando assigned
 * is what real browsers deliver; dispatch inside `act` so React flushes.
 */
function endWidthTransition(el: HTMLElement, propertyName: string): void {
  const end = new Event("transitionend", { bubbles: true, cancelable: true }) as Event & {
    propertyName?: string;
  };
  end.propertyName = propertyName;
  act(() => {
    el.dispatchEvent(end);
  });
}

// ── Open / close animation ──────────────────────────────────────────────────

describe("resizable-side-pane — open/close glide (SC-16b)", () => {
  it("open mounts at width 0 with the width transition armed, then glides to the stored width", async () => {
    const utils = render(paneElement(false));
    expect(utils.queryByTestId(PANE)).toBeNull();
    expect(utils.getByTestId(CLOSED)).toBeDefined();

    utils.rerender(paneElement(true));
    // The opening commit mounts at width 0 with the glide armed...
    const pane = utils.getByTestId(PANE);
    expect(pane.style.width).toBe("0px");
    const tokens = classTokens(pane);
    expect(tokens).toContain("transition-[width_0.18s_ease-out]");
    expect(tokens).toContain("motion-reduce:transition-none");
    expect(tokens.includes("transition-none")).toBe(false);
    expect(utils.queryByTestId(CLOSED)).toBeNull();

    // ...and the kick glides it to the stored width.
    await flushKick();
    expect(utils.getByTestId(PANE).style.width).toBe("400px");
  });

  it("close keeps the pane mounted until the width transition ends, then shows the closed view", async () => {
    const utils = render(paneElement(true));
    await flushKick();
    expect(utils.getByTestId(PANE).style.width).toBe("400px");

    utils.rerender(paneElement(false));
    // Still mounted, gliding back to 0 — the closed view waits its turn.
    const closing = utils.getByTestId(PANE);
    expect(closing.style.width).toBe("0px");
    expect(utils.queryByTestId(CLOSED)).toBeNull();

    // A child transition never unmounts the pane (filtered by target + property).
    endWidthTransition(closing, "opacity");
    expect(utils.getByTestId(PANE)).toBeDefined();

    endWidthTransition(utils.getByTestId(PANE), "width");
    expect(utils.queryByTestId(PANE)).toBeNull();
    expect(utils.getByTestId(CLOSED)).toBeDefined();
  });

  it("reduced motion opens and closes instantly", async () => {
    stubMatchMedia(true);
    const utils = render(paneElement(false));
    expect(utils.getByTestId(CLOSED)).toBeDefined();

    utils.rerender(paneElement(true));
    // No 0-phase: the target applies on the opening commit itself.
    const pane = utils.getByTestId(PANE);
    expect(pane.style.width).toBe("400px");
    expect(classTokens(pane)).toContain("motion-reduce:transition-none");

    utils.rerender(paneElement(false));
    // No glide to wait for: unmounted on the closing commit.
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
    expect(classTokens(pane).includes("transition-none")).toBe(true);
    // Drag left grows the left-edge pane with the pointer, no lag.
    fireEvent.mouseMove(window, { clientX: 500 });
    expect(pane.style.width).toBe("500px");
    fireEvent.mouseUp(window);

    expect(classTokens(pane).includes("transition-none")).toBe(false);
    expect(classTokens(pane)).toContain("transition-[width_0.18s_ease-out]");
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
