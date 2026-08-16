import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";
import type { ExperienceCopilotContextMetrics } from "@vibe-tavern/api-contracts";

useDomEnv();

// CustomTooltip wraps children in a Radix Tooltip that never anchors under
// happy-dom (same reason the shell test mocks it). Render children inline — the
// meter test pins the track/segment/control contract, not tooltip internals.
mock.module("../../../../components/shared/Tooltip.js", () => ({
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// The shared Toggle wraps Radix Switch; mock it to a plain button so the meter
// test drives it deterministically without Radix's happy-dom anchoring.
// (Toggle's own behaviour is pinned in Toggle.test.tsx — a full replacement
// here cannot leak because apps/web runs each test file in its own process.)
mock.module("../../../../components/shared/Toggle.js", () => ({
  Toggle: ({
    checked,
    onChange,
    disabled,
  }: {
    checked: boolean;
    onChange: (v: boolean) => void;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      data-testid="copilot-context-autocompact-toggle"
      data-checked={checked ? "true" : "false"}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  ),
}));

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let ExperienceContextMeter: typeof import("./ExperienceContextMeter.js").ExperienceContextMeter;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ ExperienceContextMeter } = await import("./ExperienceContextMeter.js"));
});

function metrics(over: Partial<ExperienceCopilotContextMetrics> = {}): ExperienceCopilotContextMetrics {
  return {
    systemTokens: 2500,
    digestTokens: 1000,
    historyTokens: 500,
    totalTokens: 4000,
    budgetTokens: 10000,
    reserveTokens: 1000,
    source: "estimate",
    measuredAt: "2026-08-15T00:00:00.000Z",
    ...over,
  };
}

function renderMeter(over: Partial<Parameters<typeof ExperienceContextMeter>[0]> = {}) {
  const props = {
    metrics: metrics(),
    autoCompact: true,
    isCompacting: false,
    isSending: false,
    onCompact: mock(),
    onToggleAutoCompact: mock(),
    ...over,
  };
  const utils = render(<ExperienceContextMeter {...props} />);
  return { ...utils, props };
}

describe("ExperienceContextMeter", () => {
  it("renders proportional segments (system/digest/history/reserve) against budget", () => {
    const { getByTestId } = renderMeter();

    const system = getByTestId("copilot-context-segment-system");
    const digest = getByTestId("copilot-context-segment-digest");
    const history = getByTestId("copilot-context-segment-history");
    const reserve = getByTestId("copilot-context-segment-reserve");

    expect(system.style.width).toBe("25%");
    expect(digest.style.width).toBe("10%");
    expect(history.style.width).toBe("5%");
    expect(reserve.style.width).toBe("10%");
  });

  it("renders an unmetered label when budget is 0 (no misleading zero bar)", () => {
    const { getByText, queryByTestId } = renderMeter({ metrics: metrics({ budgetTokens: 0 }) });

    expect(getByText("copilot_context_unmetered")).toBeDefined();
    expect(queryByTestId("copilot-context-track")).toBeNull();
  });

  it("renders the no-metrics label (distinct from unmetered) when there is no measurement yet", () => {
    const { getByText, queryByTestId } = renderMeter({ metrics: null });

    expect(getByText("copilot_context_no_metrics")).toBeDefined();
    expect(queryByTestId("copilot-context-track")).toBeNull();
  });

  it("marks the compact button urgent at >= 80% of budget and not below", () => {
    const urgent = renderMeter({ metrics: metrics({ totalTokens: 8000 }) });
    expect(urgent.getByTestId("copilot-context-compact-btn").getAttribute("data-urgent")).toBe("true");
    urgent.unmount();

    const calm = renderMeter({ metrics: metrics({ totalTokens: 7999 }) });
    expect(calm.getByTestId("copilot-context-compact-btn").getAttribute("data-urgent")).toBe("false");
    calm.unmount();
  });

  it("disables the compact button while sending or already compacting", () => {
    const sending = renderMeter({ isSending: true });
    expect((sending.getByTestId("copilot-context-compact-btn") as HTMLButtonElement).disabled).toBe(true);
    sending.unmount();

    const compacting = renderMeter({ isCompacting: true });
    expect((compacting.getByTestId("copilot-context-compact-btn") as HTMLButtonElement).disabled).toBe(true);
    compacting.unmount();
  });

  it("fires onCompact when the button is clicked", () => {
    const onCompact = mock();
    const { getByTestId } = renderMeter({ onCompact });

    fireEvent.click(getByTestId("copilot-context-compact-btn"));
    expect(onCompact).toHaveBeenCalledTimes(1);
  });

  it("forwards the toggle state and fires onToggleAutoCompact with the flipped value", () => {
    const onToggleAutoCompact = mock();
    const { getByTestId } = renderMeter({ autoCompact: true, onToggleAutoCompact });

    const toggle = getByTestId("copilot-context-autocompact-toggle");
    expect(toggle.getAttribute("data-checked")).toBe("true");

    fireEvent.click(toggle);
    expect(onToggleAutoCompact).toHaveBeenCalledTimes(1);
    expect(onToggleAutoCompact).toHaveBeenCalledWith(false);
  });
});
