/**
 * AgentShellTabButton — SC-15 `onClose` extension (SIDECHAT_PLAN, Wave 4).
 *
 * Pins the plan's contract:
 * - WITHOUT `onClose` the rendered markup is byte-identical to the pre-SC-15
 *   output (full outerHTML equality, active + inactive) — the extension adds
 *   nothing to the existing path.
 * - WITH `onClose` the tab renders inside a wrapper with the × as a SIBLING
 *   button (never nested — a `<button>` cannot hold another): ≥ 44 px hit
 *   area, `closeLabel` as its aria-label + `CustomTooltip` content, clicking
 *   it fires `onClose` without firing the tab's `onClick`.
 *
 * Runner: bun:test with scoped happy-dom. No i18n (labels arrive as plain
 * strings), no fetch, no stores. The `CustomTooltip` mock only exposes the
 * tooltip content as a data attribute so the test can pin it — the real
 * Radix tooltip needs a provider the isolated render does not mount (the
 * `SidechatPanel.test.tsx` contract).
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const realTooltip = await import("../Tooltip.js");
mock.module("../Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children, content }: { children: React.ReactNode; content: React.ReactNode }) => (
    <span data-testid="tab-close-tooltip" data-content={String(content)}>
      {children}
    </span>
  ),
}));

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let AgentShellTabButton: typeof import("./AgentShellTabButton.js").AgentShellTabButton;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ AgentShellTabButton } = await import("./AgentShellTabButton.js"));
});

// Behavior change (font audit step 9a): the tab label was `text-[0.9rem]` (a
// fixed size deaf to --ui-fs — rem tracks the 16px browser root) → now
// `text-[var(--ui-fs)]` (0.9rem = 14.4px, |14 - 14.4| rounds to 0 — the bare
// variable). Basis: FIXED_FONT_SIZE_AUDIT_REPORT verdict.
const ACTIVE_CLASS =
  "relative flex min-h-0 min-w-0 flex-1 items-center justify-center gap-1.5 py-2.5 font-ui text-[var(--ui-fs)] font-medium transition-colors border-b-2 border-accent text-t1";
const INACTIVE_CLASS =
  "relative flex min-h-0 min-w-0 flex-1 items-center justify-center gap-1.5 py-2.5 font-ui text-[var(--ui-fs)] font-medium transition-colors border-b-2 border-transparent text-t3";

describe("AgentShellTabButton — no onClose renders as before (SC-15)", () => {
  it("active tab: byte-identical outerHTML", () => {
    const { container } = render(
      <AgentShellTabButton label="Chat" active onClick={() => {}} />,
    );
    expect(container.innerHTML).toBe(
      `<button type="button" role="tab" aria-selected="true" class="${ACTIVE_CLASS}">Chat</button>`,
    );
  });

  it("inactive tab: byte-identical outerHTML", () => {
    const { container } = render(
      <AgentShellTabButton label="Sidechat" active={false} onClick={() => {}} />,
    );
    expect(container.innerHTML).toBe(
      `<button type="button" role="tab" aria-selected="false" class="${INACTIVE_CLASS}">Sidechat</button>`,
    );
  });

  it("no wrapper, no close button without onClose", () => {
    const { container, queryByTestId } = render(
      <AgentShellTabButton label="Chat" active onClick={() => {}} />,
    );
    // The tab IS the root — no wrapper div around it, no × anywhere.
    expect(container.firstElementChild?.tagName).toBe("BUTTON");
    expect(queryByTestId("agent-shell-tab-close")).toBeNull();
    expect(queryByTestId("tab-close-tooltip")).toBeNull();
  });
});

describe("AgentShellTabButton — onClose sibling × (SC-15)", () => {
  it("renders the tab + sibling × in a wrapper (never nested)", () => {
    const { getByRole, getByTestId } = render(
      <AgentShellTabButton
        label="Sidechat"
        active
        onClick={() => {}}
        onClose={() => {}}
        closeLabel="Close sidechat"
      />,
    );
    const tab = getByRole("tab", { name: "Sidechat" });
    const close = getByTestId("agent-shell-tab-close");
    // Siblings under one wrapper — the × is NOT inside the tab button. (The
    // mock tooltip span stands in for Radix `Trigger asChild`, which adds no
    // DOM of its own, so the test asserts containment, not direct parent.)
    expect(tab.querySelector("button")).toBeNull();
    expect(tab.parentElement?.tagName).toBe("DIV");
    expect(tab.parentElement?.contains(close)).toBe(true);
    // The tab keeps its exact chrome inside the wrapper.
    expect(tab.getAttribute("class")).toBe(ACTIVE_CLASS);
  });

  it("× has the accessible name, tooltip, and a ≥ 44 px hit area", () => {
    const { getByTestId } = render(
      <AgentShellTabButton
        label="Sidechat"
        active
        onClick={() => {}}
        onClose={() => {}}
        closeLabel="Close sidechat"
      />,
    );
    const close = getByTestId("agent-shell-tab-close");
    expect(close.tagName).toBe("BUTTON");
    expect(close.getAttribute("aria-label")).toBe("Close sidechat");
    expect(getByTestId("tab-close-tooltip").getAttribute("data-content")).toBe("Close sidechat");
    // h-11 w-11 = 44 × 44 px (the plan-settled touch floor).
    expect(close.getAttribute("class")).toContain("h-11");
    expect(close.getAttribute("class")).toContain("w-11");
  });

  it("clicking × fires onClose without firing the tab onClick", () => {
    const onClick = mock(() => {});
    const onClose = mock(() => {});
    const { getByTestId } = render(
      <AgentShellTabButton
        label="Sidechat"
        active
        onClick={onClick}
        onClose={onClose}
        closeLabel="Close sidechat"
      />,
    );
    fireEvent.click(getByTestId("agent-shell-tab-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });
});
