/**
 * Co-author editor panel — behavioral tests (SIDECHAT_PLAN, SC-16c).
 *
 * Mounts the REAL `CoauthorEditorPanel` (which mounts the REAL shared
 * `ResizableSidePane` primitive) with the live editor form stubbed at the
 * module boundary — the form's own suite pins it (same shape as the
 * ScriptEditor suite's LinkBindingPopover double, `...real` spread first).
 * No fetch, no stores, no i18n initialized. The only process-global state
 * touched here is `localStorage` and the viewport width, both restored
 * after each test.
 *
 * Pins:
 *   - the drag line sits on the editor's LEFT edge at the 460 default, and
 *     the `hidden ... lg:flex` breakpoint stays on the plain wrapper;
 *   - drag persists under the panel's own key, clamps (320 min, half-window
 *     max), double-click resets 460;
 *   - NO collapse control (no chevron, no tab — the plan settles collapse
 *     for scripts/mini-apps only);
 *   - a window resize re-clamps the rendered width without touching the
 *     stored intent.
 *
 * L1: paths repo-relative; restores in beforeEach/afterAll (localStorage,
 * viewport); waits are the open-kick drain (never a sleep); queries via
 * render()'s returned utils; every assertion pins a stable state.
 *
 * Runner: bun:test with scoped happy-dom.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { CoauthorEditorPanel } from "./CoauthorEditorPanel.js";
import { COAUTHOR_EDITOR_WIDTH_KEY } from "./CoauthorEditorPanel.js";

useDomEnv();

// The live MD editor reads snapshot/coauthor stores and fires API fetches on
// mount — all pinned in its own suite. Stub it to a probe so this file pins
// only the panel chrome and wiring (no other test file mocks this module).
const realForm = await import("./CoauthorCharacterForm.js");
mock.module("./CoauthorCharacterForm.js", () => ({
  ...realForm,
  CoauthorCharacterForm: () => <div data-testid="coauthor-form-probe">editor</div>,
}));

// ── Viewport width control (the pane's 50% max reads window.innerWidth) ────
const innerWidthDescriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");
function setViewportWidth(value: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value });
}

let render: typeof import("@testing-library/react").render;
let act: typeof import("@testing-library/react").act;
let fireEvent: typeof import("@testing-library/react").fireEvent;

beforeAll(async () => {
  ({ render, act, fireEvent } = await import("@testing-library/react"));
});

beforeEach(() => {
  localStorage.clear();
  setViewportWidth(1024);
});

afterAll(() => {
  if (innerWidthDescriptor) Object.defineProperty(window, "innerWidth", innerWidthDescriptor);
});

/** Drain the open-kick `setTimeout(0)` inside `act` (a resolved-state wait, never a sleep). */
async function flushKick() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function classTokens(el: HTMLElement): string[] {
  return (el.getAttribute("class") ?? "").split(" ").filter(Boolean);
}

// ── Line, default, breakpoint ───────────────────────────────────────────────

describe("coauthor-editor-panel — drag line + breakpoint (SC-16c)", () => {
  it("the line sits on the editor's left edge at the 460 default; the lg breakpoint stays", async () => {
    const utils = render(<CoauthorEditorPanel />);
    await flushKick();

    const pane = utils.getByTestId("coauthor-editor-panel");
    expect(pane.style.width).toBe("460px");
    const strip = utils.getByTestId("coauthor-editor-resize");
    expect(strip.getAttribute("class") ?? "").toContain("left-0");

    // The breakpoint lives on a plain wrapper div (never as an appended
    // class on the primitive's flex aside, where `cn` would fight the base).
    const wrap = utils.getByTestId("coauthor-editor");
    expect(classTokens(wrap)).toContain("hidden");
    expect(classTokens(wrap)).toContain("lg:flex");

    expect(utils.getByTestId("coauthor-form-probe")).toBeDefined();
  });

  it("drags and persists under its own key, clamps 320..half-window, double-click resets 460", async () => {
    const utils = render(<CoauthorEditorPanel />);
    await flushKick();
    const pane = utils.getByTestId("coauthor-editor-panel");
    const strip = utils.getByTestId("coauthor-editor-resize");
    expect(pane.style.width).toBe("460px");

    // Left-edge drag: moving the line left widens the editor.
    fireEvent.mouseDown(strip, { button: 0, clientX: 600 });
    fireEvent.mouseMove(window, { clientX: 550 });
    fireEvent.mouseUp(window);
    expect(pane.style.width).toBe("510px");
    expect(localStorage.getItem(COAUTHOR_EDITOR_WIDTH_KEY)).toBe("510");

    // Clamp at half the window (1024 → 512).
    fireEvent.mouseDown(strip, { button: 0, clientX: 550 });
    fireEvent.mouseMove(window, { clientX: -5000 });
    fireEvent.mouseUp(window);
    expect(pane.style.width).toBe("512px");

    // Clamp at the 320 min.
    fireEvent.mouseDown(strip, { button: 0, clientX: -5000 });
    fireEvent.mouseMove(window, { clientX: 5500 });
    fireEvent.mouseUp(window);
    expect(pane.style.width).toBe("320px");

    // Double-click resets to the 460 default through the clamp/write path.
    fireEvent.doubleClick(strip);
    expect(pane.style.width).toBe("460px");
    expect(localStorage.getItem(COAUTHOR_EDITOR_WIDTH_KEY)).toBe("460");
  });

  it("has no collapse control and never hides itself", async () => {
    const utils = render(<CoauthorEditorPanel />);
    await flushKick();

    expect(utils.queryByTestId("assistant-collapse")).toBeNull();
    expect(utils.queryByTestId("assistant-closed")).toBeNull();
    expect(utils.queryByTestId("assistant-toggle")).toBeNull();
    expect(classTokens(utils.getByTestId("coauthor-editor-panel")).includes("hidden")).toBe(false);
  });

  it("a window resize re-clamps the rendered width without touching the stored intent", async () => {
    localStorage.setItem(COAUTHOR_EDITOR_WIDTH_KEY, "500");
    setViewportWidth(1200);
    const utils = render(<CoauthorEditorPanel />);
    await flushKick();
    expect(utils.getByTestId("coauthor-editor-panel").style.width).toBe("500px");

    setViewportWidth(800);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(utils.getByTestId("coauthor-editor-panel").style.width).toBe("400px");
    expect(localStorage.getItem(COAUTHOR_EDITOR_WIDTH_KEY)).toBe("500");
  });
});
