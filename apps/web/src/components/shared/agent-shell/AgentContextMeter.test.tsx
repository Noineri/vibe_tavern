import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installToggleSeam } from "../../../../test/toggle-seam.js";
import type { ExperienceCopilotContextMetrics } from "@vibe-tavern/api-contracts";

useDomEnv();

// The shared Toggle wraps Radix Switch; stub it to a plain button via the
// shared toggle seam so the meter test drives it deterministically without
// Radix's happy-dom anchoring. (Toggle's own behaviour is pinned in
// Toggle.test.tsx.) CO-LOAD CONTRACT: the former inline full replacement was
// R4-less AND stayed live process-globally in a hand-bundled run, breaking
// every real-arm rider (`getByRole("switch", …)` — AgentSettingsModal et
// al.); the seam restores the real Toggle for riders that register it.
installToggleSeam({ stub: true });

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

  it("shows the panel at once: legend rows with tokens, the reserve, zero parts muted, and the heading on request", () => {
    const plain = renderMeter();
    const legend = plain.getByTestId("copilot-context-legend");
    for (const text of ["copilot_context_segment_system", "copilot_context_segment_digest", "copilot_context_segment_history", "copilot_context_segment_reserve"]) {
      expect(legend.textContent).toContain(text);
    }
    for (const tokens of [2500, 1000, 500]) expect(legend.textContent).toContain(tokens.toLocaleString());
    // Behavior change (owner 2026-10-23): the separate source line is gone; an estimate marks the heading with "≈".
    expect(plain.queryByTestId("copilot-context-source")).toBeNull();
    expect(plain.queryByTestId("copilot-context-heading")).toBeNull();
    plain.unmount();

    const measured = renderMeter({ showHeading: true, metrics: metrics({ source: "provider" }) });
    expect(measured.getByTestId("copilot-context-heading").textContent).toContain("40% · ");
    expect(measured.getByTestId("copilot-context-heading").textContent).not.toContain("≈");
    measured.unmount();

    const estimated = renderMeter({ showHeading: true, metrics: metrics({ source: "estimate", digestTokens: 0 }) });
    expect(estimated.getByTestId("copilot-context-heading").textContent).toContain("≈ 40% · ");
    expect(estimated.getByTestId("copilot-context-segment-dot-digest").className.split(/\s+/)).toContain("opacity-40");
    expect(estimated.getByTestId("copilot-context-segment-dot-system").className.split(/\s+/)).not.toContain("opacity-40");
    estimated.unmount();
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
    const { getByTestId } = renderMeter({ metrics: m, segmentLabels: { ...labels }, showHeading: true });

    const widths = ["lore", "summaries", "messages"].map(
      (key) => parseFloat(getByTestId(`copilot-context-segment-${key}`).style.width),
    );
    const rendered = widths.reduce((a, b) => a + b, 0);
    expect(rendered).toBe((m.totalTokens / m.budgetTokens) * 100);
    expect(m.segments?.reduce((a, s) => a + s.tokens, 0)).toBe(m.totalTokens);
    // Was a "Total" row in the hover tooltip; the panel heading now carries the total (AP-14 mockup).
    expect(getByTestId("copilot-context-heading").textContent).toContain(
      `${m.totalTokens.toLocaleString()} / ${m.budgetTokens.toLocaleString()}`,
    );
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

describe("AgentContextMeter five sidechat fills (SC-13b)", () => {
  // The sidechat kind's five SC-9 segment keys with the SC-13b label map.
  // Under test `t()` falls back to the key itself.
  const sidechatLabels = {
    context: "sidechat_meter_context",
    rp_summaries: "sidechat_meter_rp_summaries",
    rp_messages: "sidechat_meter_rp_messages",
    digest: "sidechat_meter_digest",
    discussion: "sidechat_meter_discussion",
  } as const;
  const sidechatKeys = ["context", "rp_summaries", "rp_messages", "digest", "discussion"] as const;
  // Behavior change (owner 2026-10-23, dots invisible on the phone): was bg-accent-dim / bg-s2 / bg-info-dim.
  const expectedFills = ["bg-accent", "bg-accent/50", "bg-t3", "bg-info", "bg-info/50"];

  function fiveMetrics() {
    return metrics({
      segments: [
        { key: "context", tokens: 5000 },
        { key: "rp_summaries", tokens: 2000 },
        { key: "rp_messages", tokens: 1500 },
        { key: "digest", tokens: 1000 },
        { key: "discussion", tokens: 500 },
      ],
    });
  }

  it("renders five distinct fills in segment order (adjacent segments never share)", () => {
    const { getByTestId } = renderMeter({
      metrics: fiveMetrics(),
      segmentLabels: { ...sidechatLabels },
    });

    const fills = sidechatKeys.map((key) => {
      const classes = getByTestId(`copilot-context-segment-${key}`).className.split(/\s+/);
      return expectedFills.find((fill) => classes.includes(fill));
    });
    expect(fills).toEqual(expectedFills);
    expect(new Set(fills).size).toBe(5);
  });

  it("gives every tooltip row a dot in its segment's fill", () => {
    const { getByTestId } = renderMeter({
      metrics: fiveMetrics(),
      segmentLabels: { ...sidechatLabels },
    });

    sidechatKeys.forEach((key, index) => {
      const dot = getByTestId(`copilot-context-segment-dot-${key}`);
      expect(dot.tagName.toLowerCase()).toBe("span");
      expect(dot.className.split(/\s+/)).toContain(expectedFills[index]);
    });
  });

  it("gives the fixed three segments the first three visible fills", () => {
    const { getByTestId, queryByTestId } = renderMeter();

    // Behavior change (owner 2026-10-23): digest / history were bg-accent-dim / bg-s2, invisible as dots.
    expect(getByTestId("copilot-context-segment-system").className.split(/\s+/)).toContain("bg-accent");
    expect(getByTestId("copilot-context-segment-digest").className.split(/\s+/)).toContain("bg-accent/50");
    expect(getByTestId("copilot-context-segment-history").className.split(/\s+/)).toContain("bg-t3");
    // Behavior change (AP-14 mockup): the fixed segments now get legend dots too (was: none).
    expect(getByTestId("copilot-context-segment-dot-system").className.split(/\s+/)).toContain("bg-accent");
    expect(queryByTestId("copilot-context-segment-dot-lore")).toBeNull();
  });
});
