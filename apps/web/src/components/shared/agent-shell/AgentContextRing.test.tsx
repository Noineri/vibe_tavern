/**
 * AgentContextRing (AGENT_SHELL_POLISH AP-14) — the header's compact context
 * trigger: a ring with the used % between the session switcher and the gear;
 * clicking opens the EXISTING `AgentContextMeter` body in a Radix popover on
 * desktop and a BottomSheet on the phone.
 *
 * Render states (the contract):
 * - no usage data yet (`metrics === null`) → NO ring; the slot keeps today's
 *   `copilot_context_no_metrics` text and opens nothing;
 * - unmetered profile (`budgetTokens === 0`) → the token COUNT instead of a
 *   percentage, still opening the meter body;
 * - metered → ring + `%`, the meter's own urgent band (80%) driving the
 *   shared warn/ok state, click opening the unchanged meter body (bar,
 *   segments, compact, auto) on BOTH arms.
 *
 * The shared Radix Switch is stubbed to a plain button (its behaviour is
 * pinned in Toggle.test.tsx — the AgentContextMeter.test.tsx precedent); the
 * tooltip is a passthrough (the AgentChatPane.test.tsx `...real` pattern), so
 * the slot text and the meter body stay queryable. `t()` echoes keys (no
 * LocaleProvider — the meter-test precedent).
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installToggleSeam } from "../../../../test/toggle-seam.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import type { ExperienceCopilotContextMetrics } from "@vibe-tavern/api-contracts";

useDomEnv();

// Co-load seam (identity spec): this suite pins the raw-key echo of
// provider-less renders (`context_usage_percent` etc.) — without its own
// registration a hand-bundled run would inherit a sibling's interpolating
// spec (MobileInputArea's "Context: {n}%") and the raw-key pins would break.
// Behavior is byte-identical to the real default context for these renders.
installI18nContextSeam();

const realTooltip = await import("../../../components/shared/Tooltip.js");
mock.module("../../../components/shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// The shared Toggle wraps Radix Switch; stub it to a plain button via the
// shared toggle seam so the ring test drives the auto toggle deterministically
// without Radix's happy-dom anchoring (same registration as
// AgentContextMeter.test.tsx). CO-LOAD CONTRACT: the former inline full
// replacement was R4-less AND poisoned every real-arm rider
// (`getByRole("switch", …)`) process-globally in a hand-bundled run.
installToggleSeam({ stub: true });

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let AgentContextRing: typeof import("./AgentContextRing.js").AgentContextRing;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ AgentContextRing } = await import("./AgentContextRing.js"));
});

function metrics(over: Partial<ExperienceCopilotContextMetrics> = {}): ExperienceCopilotContextMetrics {
  return {
    systemTokens: 2500,
    digestTokens: 1000,
    historyTokens: 500,
    attachedTokens: 0,
    totalTokens: 4000,
    budgetTokens: 10000,
    reserveTokens: 1000,
    source: "estimate",
    measuredAt: "2026-08-15T00:00:00.000Z",
    ...over,
  };
}

function renderRing(over: Partial<Parameters<typeof AgentContextRing>[0]> = {}) {
  const props = {
    metrics: metrics(),
    autoCompact: true,
    isCompacting: false,
    isSending: false,
    onCompact: mock(),
    onToggleAutoCompact: mock(),
    ...over,
  };
  const utils = render(<AgentContextRing {...props} />);
  return { ...utils, props };
}

describe("AgentContextRing idle state (no usage data yet)", () => {
  it("renders no ring — the slot keeps today's no-metrics text", () => {
    const { getByTestId, queryByTestId } = renderRing({ metrics: null });

    expect(queryByTestId("copilot-context-ring")).toBeNull();
    expect(getByTestId("copilot-context-ring-idle").textContent).toBe("copilot_context_no_metrics");
  });

  it("the idle slot opens nothing (the meter body stays unmounted)", () => {
    const { getByTestId, queryByTestId } = renderRing({ metrics: null });

    fireEvent.click(getByTestId("copilot-context-ring-idle"));

    expect(queryByTestId("copilot-context-meter")).toBeNull();
    expect(queryByTestId("copilot-context-compact-btn")).toBeNull();
  });
});

describe("AgentContextRing metered state (ring + %)", () => {
  it("renders the shared ring drawing with the used percent beside it", () => {
    const { getByTestId, container } = renderRing();

    expect(getByTestId("copilot-context-ring").textContent).toContain("40%");
    // The ring drawing is the SHARED ContextRing (no hand-rolled SVG): the
    // -90° start rotation lives INSIDE the SVG, never as a CSS class.
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("class") ?? "").not.toContain("rotate");
    expect(svg.querySelector("circle")?.getAttribute("transform")).toBe("rotate(-90 9 9)");
  });

  it("colors calm with the shared ok state (accent arc, default % text)", () => {
    const { getByTestId, container } = renderRing();

    const circles = Array.from(container.querySelectorAll("circle"));
    expect(circles[1]?.getAttribute("class")).toBe("stroke-accent");
    expect(getByTestId("copilot-context-ring").querySelector("span")?.className).not.toContain(
      "text-danger-text",
    );
  });

  it("colors urgent (>= 80% of budget) with the shared warn state — the meter's own band", () => {
    const { getByTestId, container } = renderRing({ metrics: metrics({ totalTokens: 8000 }) });

    // WAS (meter row): the compact button glowed urgent at >= 80% — the SAME
    // `isMeterUrgent` derivation now drives the ring arc + the % text.
    expect(getByTestId("copilot-context-ring").textContent).toContain("80%");
    const circles = Array.from(container.querySelectorAll("circle"));
    expect(circles[1]?.getAttribute("class")).toBe("stroke-danger-text");
    expect(getByTestId("copilot-context-ring").querySelector("span")?.className).toContain(
      "text-danger-text",
    );
  });
});

describe("AgentContextRing unmetered state (budget 0)", () => {
  it("shows the token count instead of a percentage, equally compact", () => {
    const { getByTestId } = renderRing({ metrics: metrics({ budgetTokens: 0 }) });

    const trigger = getByTestId("copilot-context-ring");
    expect(trigger.getAttribute("data-metered")).toBe("false");
    expect(trigger.textContent).toBe((4000).toLocaleString());
    expect(trigger.textContent).not.toContain("%");
    expect(trigger.querySelector("svg")).toBeNull();
  });

  it("the count trigger still opens the meter body (which keeps the unmetered label)", () => {
    const { getByTestId, getByText, queryByTestId } = renderRing({
      metrics: metrics({ budgetTokens: 0 }),
    });

    expect(queryByTestId("copilot-context-meter")).toBeNull();
    fireEvent.click(getByTestId("copilot-context-ring"));

    expect(getByTestId("copilot-context-meter")).toBeDefined();
    expect(getByText("copilot_context_unmetered")).toBeDefined();
    expect(queryByTestId("copilot-context-track")).toBeNull();
  });
});

describe("AgentContextRing desktop arm (Radix popover)", () => {
  it("click opens the EXISTING meter body — bar, segments, compact, auto — unchanged", () => {
    const { getByTestId, queryByTestId } = renderRing();

    expect(queryByTestId("copilot-context-meter")).toBeNull();
    fireEvent.click(getByTestId("copilot-context-ring"));

    // Every meter state the meter tests pin is reachable here (same component).
    expect(getByTestId("copilot-context-segment-system").style.width).toBe("25%");
    expect(getByTestId("copilot-context-segment-digest").style.width).toBe("10%");
    expect(getByTestId("copilot-context-segment-history").style.width).toBe("5%");
    expect(getByTestId("copilot-context-segment-reserve").style.width).toBe("10%");
    expect(getByTestId("copilot-context-compact-btn")).toBeDefined();
    expect(getByTestId("copilot-context-autocompact-toggle").getAttribute("data-checked")).toBe("true");
  });

  it("the compact button and the auto toggle forward through the popover body", () => {
    const onCompact = mock();
    const onToggleAutoCompact = mock();
    const { getByTestId } = renderRing({ autoCompact: true, onCompact, onToggleAutoCompact });

    fireEvent.click(getByTestId("copilot-context-ring"));
    fireEvent.click(getByTestId("copilot-context-compact-btn"));
    expect(onCompact).toHaveBeenCalledTimes(1);

    fireEvent.click(getByTestId("copilot-context-autocompact-toggle"));
    expect(onToggleAutoCompact).toHaveBeenCalledTimes(1);
    expect(onToggleAutoCompact).toHaveBeenCalledWith(false);
  });
});

describe("AgentContextRing mobile arm (BottomSheet)", () => {
  it("click opens the SAME meter body in a BottomSheet titled with the usage figure", () => {
    const { getByTestId, getByText, queryByTestId } = renderRing({ mobile: true });

    expect(queryByTestId("copilot-context-meter")).toBeNull();
    fireEvent.click(getByTestId("copilot-context-ring"));

    expect(getByTestId("copilot-context-meter")).toBeDefined();
    expect(getByTestId("copilot-context-segment-system").style.width).toBe("25%");
    expect(getByTestId("copilot-context-compact-btn")).toBeDefined();
    expect(getByTestId("copilot-context-autocompact-toggle")).toBeDefined();
    expect(getByText("context_label")).toBeDefined();
  });

  it("the unmetered count trigger opens the sheet body too (never a desktop-only gate)", () => {
    const { getByTestId, getByText } = renderRing({
      mobile: true,
      metrics: metrics({ budgetTokens: 0 }),
    });

    fireEvent.click(getByTestId("copilot-context-ring"));

    expect(getByTestId("copilot-context-meter")).toBeDefined();
    expect(getByText("copilot_context_unmetered")).toBeDefined();
  });
});
