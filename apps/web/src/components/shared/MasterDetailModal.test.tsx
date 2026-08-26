/**
 * MasterDetailModal — characterization test.
 *
 * Pins the mobile detail-class override contract so the shared primitive
 * cannot regress when callers reduce outer mobile inset.
 *
 * What is pinned:
 *   - Desktop: detail pane uses `detailClassName` (default "p-6").
 *   - Mobile, no `mobileDetailClassName`: detail pane uses default "p-4".
 *   - Mobile, with `mobileDetailClassName="p-2 foo"`: detail pane uses
 *     "p-2 foo" instead of "p-4".
 *   - The master column follows `masterClassName` on desktop, "w-full" on mobile.
 *   - `scrollbar-hide` works as a plain CSS class passed through — it does
 *     not disable overflow scrolling (the overflow-y-auto is always present).
 *
 * Runner: bun:test + happy-dom.
 */
import { beforeAll, describe, it, expect, mock } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

// ── Mobile mock ─────────────────────────────────────────────────────────
const realUseMobile = await import("../../hooks/use-mobile.js");

let isMobile = false;
mock.module("../../hooks/use-mobile.js", () => ({
  ...realUseMobile,
  useIsMobile: () => isMobile,
}));

// CustomTooltip + Icons passthrough — Tooltip needs a provider ancestor this
// isolated render does not mount. Matches the convention in SegmentedControl,
// LorebookAccordion, and InjectionTable tests.
const realTooltip = await import("./Tooltip.js");
mock.module("./Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

let MasterDetailModal: typeof import("./MasterDetailModal.js").MasterDetailModal;
let MasterDetailFooter: typeof import("./MasterDetailModal.js").MasterDetailFooter;
beforeAll(async () => {
  ({ MasterDetailModal, MasterDetailFooter } = await import("./MasterDetailModal.js"));
});

// ── Helpers ─────────────────────────────────────────────────────────────

function master() {
  return <div data-testid="master">Master</div>;
}
function detail() {
  return <div data-testid="detail">Detail</div>;
}

describe("MasterDetailModal — desktop", () => {
  it("detail pane uses detailClassName on desktop (default p-6)", () => {
    isMobile = false;
    const { getByTestId } = render(
      <MasterDetailModal
        isOpen={true}
        onClose={() => {}}
        title="Test"
        masterContent={master()}
        detailContent={detail()}
      />,
    );

    const detailPane = getByTestId("detail").parentElement!;
    expect(detailPane.className).toContain("p-6");
    expect(detailPane.className).not.toContain("p-4");
    expect(detailPane.className).toContain("overflow-y-auto");
    expect(detailPane.className).toContain("min-w-0");
    expect(detailPane.className).toContain("flex-1");
  });

  it("detail pane uses custom detailClassName on desktop", () => {
    isMobile = false;
    const { getByTestId } = render(
      <MasterDetailModal
        isOpen={true}
        onClose={() => {}}
        title="Test"
        detailClassName="p-0"
        masterContent={master()}
        detailContent={detail()}
      />,
    );

    const detailPane = getByTestId("detail").parentElement!;
    expect(detailPane.className).toContain("p-0");
    expect(detailPane.className).not.toContain("p-6");
  });

  it("master column uses masterClassName on desktop", () => {
    isMobile = false;
    const { getByTestId } = render(
      <MasterDetailModal
        isOpen={true}
        onClose={() => {}}
        title="Test"
        masterContent={master()}
        detailContent={detail()}
      />,
    );

    const masterPane = getByTestId("master").parentElement!;
    expect(masterPane.className).toContain("w-[220px]");
    expect(masterPane.className).toContain("border-r");
  });
});

describe("MasterDetailModal — mobile", () => {
  it("detail pane uses default p-4 on mobile when mobileDetailClassName is not passed", () => {
    isMobile = true;
    const { getByTestId } = render(
      <MasterDetailModal
        isOpen={true}
        onClose={() => {}}
        title="Test"
        masterContent={({ openDetail }) => (
          <button data-testid="drill-btn" onClick={openDetail}>Drill</button>
        )}
        detailContent={detail()}
      />,
    );

    // Initial: detail is hidden (drill-down pattern).
    fireEvent.click(getByTestId("drill-btn"));

    // Now the detail pane is visible.
    const detailPane = getByTestId("detail").parentElement!;
    expect(detailPane.className).toContain("p-4");
    expect(detailPane.className).not.toContain("p-6");
    expect(detailPane.className).toContain("overflow-y-auto");
    expect(detailPane.className).toContain("min-w-0");
    expect(detailPane.className).toContain("flex-1");
  });

  it("detail pane uses mobileDetailClassName on mobile when passed, ignoring detailClassName", () => {
    isMobile = true;
    const { getByTestId } = render(
      <MasterDetailModal
        isOpen={true}
        onClose={() => {}}
        title="Test"
        detailClassName="p-0"
        mobileDetailClassName="p-2 scrollbar-hide"
        masterContent={({ openDetail }) => (
          <button data-testid="drill-btn" onClick={openDetail}>Drill</button>
        )}
        detailContent={detail()}
      />,
    );

    // Open detail via drill-down.
    fireEvent.click(getByTestId("drill-btn"));

    const detailPane = getByTestId("detail").parentElement!;
    expect(detailPane.className).toContain("p-2");
    expect(detailPane.className).toContain("scrollbar-hide");
    expect(detailPane.className).not.toContain("p-0");  // detailClassName must not leak to mobile
    expect(detailPane.className).not.toContain("p-4");  // default must not leak
    expect(detailPane.className).not.toContain("p-6");  // desktop default must not leak
    // scrollbar-hide must coexist with overflow-y-auto (hides chrome, preserves touch/wheel/keyboard scroll)
    expect(detailPane.className).toContain("overflow-y-auto");
  });

  it("master column covers full width on mobile, detail is hidden until drill-down", () => {
    isMobile = true;
    const { getByTestId, queryByTestId } = render(
      <MasterDetailModal
        isOpen={true}
        onClose={() => {}}
        title="Test"
        masterContent={master()}
        detailContent={detail()}
      />,
    );

    // Master is visible and full-width on mobile main screen.
    const masterPane = getByTestId("master").parentElement!;
    expect(masterPane.className).toContain("w-full");
    expect(masterPane.className).not.toContain("w-[220px]");

    // Detail is not rendered until drill-down opens (isDetailOpen starts false).
    // On initial mobile render, the detail column is conditionally excluded,
    // so its content doesn't appear in the DOM.
    expect(queryByTestId("detail")).toBeNull();
  });

  it("mobile full-screen container classes are always applied", () => {
    isMobile = true;
    const { getByTestId } = render(
      <MasterDetailModal
        isOpen={true}
        onClose={() => {}}
        title="Test"
        containerClassName="some-desktop-class"
        masterContent={master()}
        detailContent={detail()}
      />,
    );

    // The outer wrapper (child of Modal backdrop) gets full-screen mobile classes.
    const masterPane = getByTestId("master").parentElement!;
    // Walk up to find the outermost flex container (the one with the containerClassName branch).
    const outer = masterPane.parentElement!.parentElement!;
    expect(outer.className).toContain("h-[100dvh]");
    expect(outer.className).toContain("w-[100dvw]");
    expect(outer.className).not.toContain("some-desktop-class");
  });
});

// ── Frost layer (R-8) ─────────────────────────────────────────────────────
// Any non-none backdrop-filter on the panel — even blur(0) in opaque themes —
// makes the panel a containing block for position:fixed descendants, so
// dnd-kit's DragOverlay (fixed, rendered inline in the panel tree) resolved
// against the panel box and dragged rows appeared offset right/down of the
// cursor in every master-detail list (PromptManager presets/regex/canvas,
// provider profiles). The frost therefore lives on a z:-1 ::before underlayer
// (.glass-blur-under); this pins that the panel itself never re-gains the
// on-element .glass-blur class.
describe("MasterDetailModal — frost layer (R-8)", () => {
  it("panel carries glass-blur-under, never on-element glass-blur", () => {
    isMobile = false;
    render(
      <MasterDetailModal
        isOpen={true}
        onClose={() => {}}
        title="Test"
        masterContent={master()}
        detailContent={detail()}
      />,
    );

    const panel = document.querySelector(".glass-blur-under");
    expect(panel).toBeTruthy();
    expect([...panel!.classList]).not.toContain("glass-blur");
    // The translucent fill moved to the underlayer too — no double fill.
    expect([...panel!.classList]).not.toContain("bg-glass-bg");
  });
});

// ── Header tabs (declarative `tabs` prop) ──────────────────────────────────
// The optional tabs element renders a SegmentedControl at the bottom of the
// global header — on desktop AND on the mobile main view (not the drill-down
// header). Switching must call back with the option's value, fully typed.
describe("MasterDetailModal — header tabs", () => {
  type TestTab = "presets" | "regex" | "service";

  it("renders tab labels with the active segment checked", () => {
    isMobile = false;
    const { getByText } = render(
      <MasterDetailModal<TestTab>
        isOpen={true}
        onClose={() => {}}
        title="Test"
        masterContent={master()}
        detailContent={detail()}
        tabs={{
          items: [
            { value: "presets", label: "Presets" },
            { value: "regex", label: "Regex" },
            { value: "service", label: "Service" },
          ],
          active: "regex",
          onChange: () => {},
        }}
      />,
    );

    expect(getByText("Presets")).toBeTruthy();
    expect(getByText("Regex")).toBeTruthy();
    expect(getByText("Service")).toBeTruthy();
    const active = getByText("Regex").closest('[role="radio"]')!;
    expect(active.getAttribute("aria-checked")).toBe("true");
    const inactive = getByText("Presets").closest('[role="radio"]')!;
    expect(inactive.getAttribute("aria-checked")).toBe("false");
  });

  it("clicking another tab calls onChange with its value", () => {
    isMobile = false;
    const calls: string[] = [];
    const { getByText } = render(
      <MasterDetailModal<TestTab>
        isOpen={true}
        onClose={() => {}}
        title="Test"
        masterContent={master()}
        detailContent={detail()}
        tabs={{
          items: [
            { value: "presets", label: "Presets" },
            { value: "regex", label: "Regex" },
          ],
          active: "presets",
          onChange: (v: TestTab) => { calls.push(v); },
        }}
      />,
    );

    fireEvent.click(getByText("Regex"));
    expect(calls).toEqual(["regex"]);
  });

  it("tabs stay on the mobile main view and disappear in the drill-down", () => {
    isMobile = true;
    const { getByText, getByTestId, queryByText } = render(
      <MasterDetailModal<TestTab>
        isOpen={true}
        onClose={() => {}}
        title="Test"
        detailTitle="Detail"
        masterContent={({ openDetail }: { openDetail: () => void }) => (
          <div data-testid="master">
            <button type="button" data-testid="open-detail" onClick={openDetail}>
              open
            </button>
          </div>
        )}
        detailContent={detail()}
        tabs={{
          items: [
            { value: "presets", label: "Presets" },
            { value: "regex", label: "Regex" },
          ],
          active: "presets",
          onChange: () => {},
        }}
      />,
    );

    // Main view: tabs visible.
    expect(getByText("Regex")).toBeTruthy();
    // Open the drill-down: master header (with tabs) is replaced by the
    // drill-down header, so the tab control is gone.
    fireEvent.click(getByTestId("open-detail"));
    expect(queryByText("Regex")).toBeNull();
  });
});

// ── MasterDetailFooter (SP-11) ──────────────────────────────────────────

describe("MasterDetailFooter — footer chrome primitive", () => {
  it("desktop: icon-text actions left, Close + right slot in ml-auto group", () => {
    isMobile = false;
    let closed = false;
    const { container } = render(
      <MasterDetailFooter
        actions={[
          { icon: <span data-testid="ico-copy" />, label: "Copy me", onClick: () => {} },
          { icon: <span data-testid="ico-trash" />, label: "Delete me", onClick: () => {} },
        ]}
        onClose={() => { closed = true; }}
        right={<button type="button" data-testid="save">save</button>}
      />,
    );
    const bar = container.firstElementChild as HTMLElement;
    expect(bar.className).toContain("border-t");
    // Actions render as icon-text spans, in order, before the ml-auto group.
    const spans = bar.querySelectorAll("span.cursor-pointer");
    expect(spans.length).toBe(2);
    expect(spans[0]?.textContent).toContain("Copy me");
    expect(spans[1]?.textContent).toContain("Delete me");
    // Right group: Close button + custom right content, after the actions.
    const rightGroup = bar.querySelector("div.ml-auto") as HTMLElement;
    expect(rightGroup).toBeTruthy();
    expect(rightGroup.querySelector('[data-testid="save"]')).toBeTruthy();
    const close = Array.from(rightGroup.querySelectorAll("button")).find((b) => b.textContent === "close");
    expect(close).toBeTruthy();
    fireEvent.click(close as HTMLElement);
    expect(closed).toBe(true);
    // Ordering: the ml-auto group must come AFTER the action spans (Save right).
    expect(bar.textContent?.indexOf("Copy me")).toBeLessThan(bar.textContent?.indexOf("save") ?? -1);
  });

  it("mobile: actions collapse to 9x9 icon buttons, no Close", () => {
    isMobile = true;
    const { container } = render(
      <MasterDetailFooter
        actions={[{ icon: <span data-testid="ico-copy" />, label: "Copy me", onClick: () => {} }]}
        onClose={() => {}}
        right={<button type="button" data-testid="save">save</button>}
      />,
    );
    const bar = container.firstElementChild as HTMLElement;
    expect(bar.className).toContain("px-3");
    const iconBtn = bar.querySelector("button.h-9.w-9") as HTMLElement;
    expect(iconBtn).toBeTruthy();
    expect(iconBtn.getAttribute("aria-label")).toBe("Copy me");
    expect(bar.textContent?.includes("Copy me")).toBe(false);
    expect(bar.querySelector('[data-testid="save"]')).toBeTruthy();
    // Close is desktop-only.
    expect(bar.textContent?.includes("close")).toBe(false);
  });
});
