import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { ExperienceCopilotContextMetrics } from "@vibe-tavern/api-contracts";

useDomEnv();

// CustomTooltip wraps children in a Radix Tooltip that never anchors under
// happy-dom (same reason the shell test mocks it). Render children AND the
// tooltip content inline — SC-0j pins the kind-provided segment LABELS, which
// surface only in the tooltip rows, so the content must render for those
// assertions (the track/segment/control contract stays the primary pin).
mock.module("../../../components/shared/Tooltip.js", () => ({
  CustomTooltip: ({ children, content }: { children: ReactNode; content: ReactNode }) => (
    <>
      {children}
      {content}
    </>
  ),
}));

// The shared Toggle wraps Radix Switch; mock it to a plain button so the meter
// test drives it deterministically without Radix's happy-dom anchoring.
// (Toggle's own behaviour is pinned in Toggle.test.tsx — a full replacement
// here cannot leak because apps/web runs each test file in its own process.)
mock.module("../../../components/shared/Toggle.js", () => ({
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
let AgentContextMeter: typeof import("./AgentContextMeter.js").AgentContextMeter;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ AgentContextMeter } = await import("./AgentContextMeter.js"));
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

function renderMeter(over: Partial<Parameters<typeof AgentContextMeter>[0]> = {}) {
  const props = {
    metrics: metrics(),
    autoCompact: true,
    isCompacting: false,
    isSending: false,
    onCompact: mock(),
    onToggleAutoCompact: mock(),
    ...over,
  };
  const utils = render(<AgentContextMeter {...props} />);
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

describe("AgentContextMeter kind-provided segments (SC-0j)", () => {
  // Fixture descriptor labels: EXISTING i18n keys (this unit defines zero new
  // keys — no host provides segments yet, so tests pair fixture metrics with
  // a fixture label map). Under test `t()` falls back to the key itself.
  const labels = {
    lore: "copilot_context_segment_system",
    summaries: "copilot_context_segment_digest",
    messages: "copilot_context_segment_history",
  } as const;

  function customMetrics() {
    return metrics({
      segments: [
        { key: "lore", tokens: 2500 },
        { key: "summaries", tokens: 1000 },
        { key: "messages", tokens: 500 },
      ],
    });
  }

  it("renders custom segments with host-provided labels and proportional widths", () => {
    const { getByTestId, getByText, queryByTestId } = renderMeter({
      metrics: customMetrics(),
      segmentLabels: { ...labels },
    });

    expect(getByTestId("copilot-context-segment-lore").style.width).toBe("25%");
    expect(getByTestId("copilot-context-segment-summaries").style.width).toBe("10%");
    expect(getByTestId("copilot-context-segment-messages").style.width).toBe("5%");
    expect(getByText("copilot_context_segment_system")).toBeDefined();
    expect(getByText("copilot_context_segment_digest")).toBeDefined();
    expect(getByText("copilot_context_segment_history")).toBeDefined();
    // The fixed segments are gone on the custom path.
    expect(queryByTestId("copilot-context-segment-system")).toBeNull();
    expect(queryByTestId("copilot-context-segment-digest")).toBeNull();
    expect(queryByTestId("copilot-context-segment-history")).toBeNull();
  });

  it("sums the custom segments to the displayed total", () => {
    const m = customMetrics();
    const { getByTestId, getByText } = renderMeter({ metrics: m, segmentLabels: { ...labels } });

    const widths = ["lore", "summaries", "messages"].map(
      (key) => parseFloat(getByTestId(`copilot-context-segment-${key}`).style.width),
    );
    const rendered = widths.reduce((a, b) => a + b, 0);
    expect(rendered).toBe((m.totalTokens / m.budgetTokens) * 100);
    expect(m.segments?.reduce((a, s) => a + s.tokens, 0)).toBe(m.totalTokens);
    expect(getByText("copilot_context_total")).toBeDefined();
  });

  it("renders the raw key when the label map misses a segment (wiring bug stays visible)", () => {
    const { getByText } = renderMeter({
      metrics: customMetrics(),
      segmentLabels: { lore: labels.lore },
    });

    expect(getByText("summaries")).toBeDefined();
    expect(getByText("copilot_context_segment_system")).toBeDefined();
  });

  it("falls back to the fixed segments when metrics carry no segments (labels passed anyway)", () => {
    const { getByTestId } = renderMeter({ metrics: metrics(), segmentLabels: { ...labels } });

    expect(getByTestId("copilot-context-segment-system").style.width).toBe("25%");
    expect(getByTestId("copilot-context-segment-digest").style.width).toBe("10%");
    expect(getByTestId("copilot-context-segment-history").style.width).toBe("5%");
  });

  it("falls back to the fixed segments when segments is an empty array", () => {
    const { getByTestId, queryByTestId } = renderMeter({
      metrics: metrics({ segments: [] }),
      segmentLabels: { ...labels },
    });

    expect(getByTestId("copilot-context-segment-system")).toBeDefined();
    expect(queryByTestId("copilot-context-track")).toBeDefined();
  });
});
