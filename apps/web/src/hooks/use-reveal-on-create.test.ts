/**
 * useRevealOnCreate — characterization tests for the PR-11 auto-reveal logic.
 *
 * happy-dom has NO layout engine (scrollHeight/clientHeight/scrollTop are all
 * 0, and its ResizeObserver stub never fires on real size changes), so the
 * report's originally-prescribed render-based "assert the scroll container is
 * pinned to scrollHeight - clientHeight" test would be a meaningless 0===0.
 * Instead the hook is characterized at its contract level: ResizeObserver is
 * replaced with a mock that captures the callback (so the test can fire it),
 * and the container's scrollHeight is controlled via Object.defineProperty.
 * This pins the two load-bearing behaviors the extraction (step 5) must keep:
 * the reveal pins the container to its bottom, and the dirty-gate (PR-11 rev 2)
 * stops re-pinning once the user is editing.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRevealOnCreate } from "./use-reveal-on-create.js";

// Captured ResizeObserver callback — the mock stores it here on `observe`.
let fireResize: null | (() => void) = null;

beforeEach(() => {
  fireResize = null;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(cb: () => void) {
      fireResize = cb;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

/** Build a fake scroll container: a real <div> with a controllable scrollHeight
 *  and a spied scrollTo (plain DOM props won't report layout under happy-dom). */
function makeBody(scrollHeight: number): { body: HTMLDivElement; scrollTo: ReturnType<typeof vi.fn> } {
  const body = document.createElement("div");
  Object.defineProperty(body, "scrollHeight", { configurable: true, get: () => scrollHeight });
  const scrollTo = vi.fn();
  body.scrollTo = scrollTo;
  return { body, scrollTo };
}

describe("useRevealOnCreate", () => {
  test("pins the scroll container to its bottom when the created card resizes (reveal phase)", () => {
    const { body, scrollTo } = makeBody(1000);
    const card = document.createElement("div");
    const { result } = renderHook(() => useRevealOnCreate("p_new", false));

    result.current.containerRef.current = body;
    // Mounting the created card attaches the observer (captures fireResize).
    result.current.cardRef("p_new", card);
    expect(fireResize).not.toBeNull();
    fireResize!();

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });
  });

  test("DIRTY-GATE: stops re-pinning once the user is editing (isDirty=true)", () => {
    const { body, scrollTo } = makeBody(1000);
    const card = document.createElement("div");
    const { result, rerender } = renderHook(
      ({ id, dirty }: { id: string | null; dirty: boolean }) => useRevealOnCreate(id, dirty),
      { initialProps: { id: "p_new", dirty: false } },
    );

    result.current.containerRef.current = body;
    result.current.cardRef("p_new", card);

    // Reveal phase (not dirty): each resize pins to the bottom.
    fireResize!();
    expect(scrollTo).toHaveBeenCalledTimes(1);

    // User starts editing → isDirty flips true on rerender; resizes must NO-OP
    // so typing doesn't yank the scroll back to the bottom.
    rerender({ id: "p_new", dirty: true });
    fireResize!();
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  test("re-pins repeatedly through the reveal phase while still clean (collapsed→expand→auto-resize)", () => {
    // The whole point of the ResizeObserver over a one-shot scrollIntoView:
    // every height change during reveal re-computes against the CURRENT height.
    const { body, scrollTo } = makeBody(1200);
    const card = document.createElement("div");
    const { result } = renderHook(() => useRevealOnCreate("p_new", false));
    result.current.containerRef.current = body;
    result.current.cardRef("p_new", card);

    fireResize!();
    fireResize!();
    fireResize!();
    expect(scrollTo).toHaveBeenCalledTimes(3);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1200, behavior: "smooth" });
  });

  test("does not observe a card that is not the created one", () => {
    const { body, scrollTo } = makeBody(1000);
    const otherCard = document.createElement("div");
    const { result } = renderHook(() => useRevealOnCreate("p_new", false));
    result.current.containerRef.current = body;

    // A different card mounting must not attach the observer.
    result.current.cardRef("p_other", otherCard);
    expect(fireResize).toBeNull();
    // Even if something were to fire, no scrollTo happens (no observer wired).
    expect(scrollTo).not.toHaveBeenCalled();
  });

  test("no-ops when the container ref is not set yet (defensive guard)", () => {
    const card = document.createElement("div");
    const { result } = renderHook(() => useRevealOnCreate("p_new", false));
    // containerRef.current is null (never assigned); the observer's `if (!body)
    // return` must short-circuit instead of throwing.
    result.current.cardRef("p_new", card);
    expect(fireResize).not.toBeNull();
    expect(() => fireResize!()).not.toThrow();
  });
});
