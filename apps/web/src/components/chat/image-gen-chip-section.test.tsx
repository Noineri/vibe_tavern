import { describe, expect, it, mock, afterAll, afterEach } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

// The shell self-forks its caret placement on `useIsMobile` (ICR-1: caret
// FIRST on desktop, LAST on mobile) — mock it to a controllable flag (the
// chip test's ...real pattern).
const realMobile = await import("../../hooks/use-mobile.js");
let mobileOverride = false;
mock.module("../../hooks/use-mobile.js", () => ({
  ...realMobile,
  useIsMobile: () => mobileOverride,
}));

const { ImageGenChipSection } = await import("./image-gen-chip-section.js");
const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");

afterEach(() => {
  cleanup();
  mobileOverride = false;
});
afterAll(() => {
  mock.restore();
});

function renderSection(node: React.ReactElement): ReturnType<typeof render> {
  return render(node);
}

describe("ImageGenChipSection — the chip's collapsible card shell (ICR-1)", () => {
  it("disclosure variant: the header is the toggle button — aria-expanded flips, the body exists only while open", async () => {
    const view = renderSection(
      <ImageGenChipSection
        variant="disclosure"
        title="LoRA"
        summary="Включено: 1"
        titleTestId="sec-title"
        summaryTestId="sec-summary"
        testIds={{ root: "sec-root", header: "sec-header", body: "sec-body" }}
      >
        <span>body cell</span>
      </ImageGenChipSection>,
    );

    // The card: bordered, NO background of its own (glass themes show
    // through — the mockup's Coffee palette is preview-only).
    const root = view.getByTestId("sec-root");
    expect(root.className).toContain("rounded-lg");
    expect(root.className).toContain("border-border");
    expect(root.className).not.toContain("bg-");

    // The header is a button carrying the disclosure semantics; the title
    // and the summary ride inside it (authored title wraps, summary
    // truncates — user data).
    const header = view.getByTestId("sec-header");
    expect(header.tagName).toBe("BUTTON");
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(within(header).getByText("LoRA")).toBeTruthy();
    expect(within(header).getByText("Включено: 1")).toBeTruthy();
    // ICR-4 pass-through hooks: the title/summary testids land on their
    // own elements (the hires-label and loras-count pins).
    expect(view.getByTestId("sec-title").textContent).toBe("LoRA");
    expect(view.getByTestId("sec-summary").textContent).toBe("Включено: 1");
    expect(header.className).toContain("min-h-9");
    expect(header.className).toContain("cursor-pointer");

    // Collapsed: no body in the DOM (AnimatedDisclosure unmounts).
    expect(view.queryByTestId("sec-body")).toBeNull();

    act(() => {
      fireEvent.click(header);
    });
    // No onOpenChange wired in this render — the state is the caller's;
    // with it wired (next test) the body appears. Here the pin is the
    // click target being the header itself, proven by the wired twin below.
    expect(view.queryByTestId("sec-body")).toBeNull();
  });

  it("disclosure variant with state wired: a header click opens the body (two-column grid classes) and flips aria-expanded", async () => {
    function Case() {
      const [open, setOpen] = React.useState(false);
      return (
        <ImageGenChipSection
          variant="disclosure"
          title="Настройки семплеров"
          open={open}
          onOpenChange={setOpen}
          testIds={{ header: "sec-header", body: "sec-body" }}
        >
          <span>cell a</span>
          <span>cell b</span>
        </ImageGenChipSection>
      );
    }
    const view = renderSection(<Case />);

    const header = view.getByTestId("sec-header");
    act(() => {
      fireEvent.click(header);
    });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    const body = view.getByTestId("sec-body");
    expect(body.className).toContain("grid-cols-1");
    expect(body.className).toContain("@min-[480px]:grid-cols-2");
    // The section is a bordered box: its body is inset like the header
    // (px-3) and closes with pb-3, so controls never touch the border
    // (owner-found 2026-10-01; the plan's item-1 spec).
    expect(body.className.split(" ")).toContain("px-3");
    expect(body.className.split(" ")).toContain("pb-3");
    expect(within(body).getByText("cell a")).toBeTruthy();

    act(() => {
      fireEvent.click(header);
    });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    // Re-close: AnimatedDisclosure animates height→0 then unmounts (250 ms).
    // Under happy-dom the exit frames never advance, so the exiting wrapper
    // lingers mounted — the deterministic pin is the CLOSED target framer
    // applied synchronously (height 0 / opacity 0); the unmount itself is
    // the browser-only tail of the same transition.
    const exiting = view.getByTestId("sec-body");
    expect(exiting.getAttribute("style")).toContain("height: 0px");
    expect(exiting.getAttribute("style")).toContain("opacity: 0");
  });

  it("toggle variant: the header is a row with the shared Toggle last; the body follows checked, not clicks on the header", async () => {
    function Case() {
      const [checked, setChecked] = React.useState(false);
      return (
        <ImageGenChipSection
          variant="toggle"
          title="Hires fix"
          summary="выкл"
          checked={checked}
          onCheckedChange={setChecked}
          testIds={{ root: "sec-root", header: "sec-header", body: "sec-body" }}
        >
          <span>knob</span>
        </ImageGenChipSection>
      );
    }
    const view = renderSection(<Case />);

    // The header is NOT a button (nothing to disclose — the switch is the
    // control) and carries the title, summary, and the switch LAST.
    const header = view.getByTestId("sec-header");
    expect(header.tagName).toBe("DIV");
    expect(header.className).not.toContain("cursor-pointer");
    const switchEl = view.getByRole("switch", { name: "Hires fix" });
    expect(header.lastElementChild?.contains(switchEl)).toBe(true);
    expect(view.queryByTestId("sec-body")).toBeNull();

    act(() => {
      fireEvent.click(switchEl);
    });
    expect(view.getByTestId("sec-body")).toBeTruthy();
    expect(within(view.getByTestId("sec-body")).getByText("knob")).toBeTruthy();

    act(() => {
      fireEvent.click(switchEl);
    });
    // Same happy-dom exit note as the disclosure twin above: the collapsed
    // body sits at height 0 while its unmount transition waits for frames.
    const exiting = view.getByTestId("sec-body");
    expect(exiting.getAttribute("style")).toContain("height: 0px");
  });

  it("toggle variant: toggleDisabled disables the switch; the hint renders under the header", async () => {
    const view = renderSection(
      <ImageGenChipSection
        variant="toggle"
        title="Проход детализации"
        summary="недоступно"
        checked={false}
        onCheckedChange={() => {}}
        toggleDisabled
        hint={<span data-testid="sec-hint">установите расширение</span>}
        testIds={{ header: "sec-header" }}
      >
        <span>never</span>
      </ImageGenChipSection>,
    );

    const switchEl = view.getByRole("switch", { name: "Проход детализации" });
    // The shared Toggle renders the native disabled attribute (not
    // aria-disabled) — R8's plain-DOM check.
    expect(switchEl.hasAttribute("disabled")).toBe(true);
    const hint = view.getByTestId("sec-hint");
    // The hint sits inside the card, after the header row.
    expect(hint.closest("div")?.previousElementSibling).toBe(view.getByTestId("sec-header"));
  });

  it("caret placement: FIRST on desktop, LAST on mobile (the mockup's two layouts)", async () => {
    function Case() {
      const [open, setOpen] = React.useState(false);
      return (
        <ImageGenChipSection
          variant="disclosure"
          title="LoRA"
          open={open}
          onOpenChange={setOpen}
          testIds={{ header: "sec-header" }}
        >
          <span>x</span>
        </ImageGenChipSection>
      );
    }
    const view = renderSection(<Case />);
    const header = view.getByTestId("sec-header");
    // Desktop (mobileOverride=false): the caret SVG is the header's FIRST
    // child, the title block last.
    expect(header.firstElementChild?.tagName).toBe("svg");
    expect(header.lastElementChild?.tagName).not.toBe("svg");

    // Mobile: caret LAST.
    cleanup();
    mobileOverride = true;
    const viewM = renderSection(<Case />);
    const headerM = viewM.getByTestId("sec-header");
    expect(headerM.lastElementChild?.tagName).toBe("svg");
    expect(headerM.firstElementChild?.tagName).not.toBe("svg");
  });

  it("no summary prop: the header renders the title alone (no empty summary span)", async () => {
    const view = renderSection(
      <ImageGenChipSection variant="disclosure" title="LoRA" testIds={{ header: "sec-header" }}>
        <span>x</span>
      </ImageGenChipSection>,
    );
    const header = view.getByTestId("sec-header");
    expect(within(header).getByText("LoRA")).toBeTruthy();
    // The title block has exactly ONE child (the title span).
    const titleBlock = header.querySelector("span");
    expect(titleBlock?.childElementCount).toBe(1);
  });
});
