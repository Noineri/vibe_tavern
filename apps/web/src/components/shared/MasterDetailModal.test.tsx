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
beforeAll(async () => {
  ({ MasterDetailModal } = await import("./MasterDetailModal.js"));
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
