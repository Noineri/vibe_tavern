import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const realI18n = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let TooltipProvider: typeof import("./Tooltip.js").TooltipProvider;
let TokenCounterPopover: typeof import("./TokenCounterPopover.js").TokenCounterPopover;
let ContextRing: typeof import("./TokenCounterPopover.js").ContextRing;
let CONTEXT_STATE_CLASSES: typeof import("./TokenCounterPopover.js").CONTEXT_STATE_CLASSES;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ TokenCounterPopover, ContextRing, CONTEXT_STATE_CLASSES } = await import("./TokenCounterPopover.js"));
  ({ TooltipProvider } = await import("./Tooltip.js"));
});

describe("TokenCounterPopover desktop trigger", () => {
  it("keeps the desktop text counter and its existing state color", () => {
    const { container } = render(
      <TokenCounterPopover
        permanent={100}
        history={25}
        inputTokens={25}
        contextSize={200}
        maxTokens={0}
        availableBudget={200}
        tokenState="mid"
        permanentItems={[]}
      />,
    );

    expect(container.textContent).toBe("100+50 / 200");
    expect(container.querySelector("span")?.getAttribute("class")).toContain("text-warning-text");
  });
});

describe("TokenCounterPopover desktop flyout", () => {
  it("opens onto the breakdown header, the shared rows, then the usage bar", () => {
    const view = render(
      <TooltipProvider><TokenCounterPopover
        permanent={100}
        history={25}
        inputTokens={25}
        contextSize={200}
        maxTokens={0}
        availableBudget={200}
        tokenState="ok"
        permanentItems={[{ label: "row_system", value: 100 }]}
      /></TooltipProvider>,
    );

    fireEvent.click(view.container.querySelector("span")!);

    const flyout = view.getByText("context_breakdown").parentElement as HTMLElement;
    const text = flyout.textContent ?? "";
    expect(text.startsWith("context_breakdowncontext_permanentrow_system100context_temporary")).toBe(true);
    expect(text).toContain("context_history25context_current_input25context_response_budget");
    expect(text).toContain("context_total_available");
    // Desktop puts the usage bar after the rows (the mobile sheet puts it first).
    expect(flyout.lastElementChild?.className).toContain("rounded-full");
  });
});

describe("ContextRing drawing", () => {
  function ring(props: Partial<Parameters<typeof ContextRing>[0]> = {}) {
    const view = render(<ContextRing percent={50} {...props} />);
    const svg = view.container.querySelector("svg")!;
    return { svg, circles: Array.from(svg.querySelectorAll("circle")) };
  }

  it("rotates inside the SVG (transform on the circles), never with a CSS rotate class", () => {
    const { svg, circles } = ring();

    expect(svg.getAttribute("class") ?? "").not.toContain("rotate");
    expect(circles.length).toBe(2);
    for (const circle of circles) expect(circle.getAttribute("transform")).toBe("rotate(-90 14 14)");
    expect(svg.getAttribute("shape-rendering")).toBe("geometricPrecision");
  });

  it("draws no arc at 0 percent (no round-cap dot)", () => {
    const { circles } = ring({ percent: 0 });

    expect(circles.length).toBe(1);
    expect(circles[0]?.getAttribute("class")).toBe("stroke-border");
  });

  it("is parameterized by size, radius, stroke and track class", () => {
    const { svg, circles } = ring({ size: 36, radius: 15.5, strokeWidth: 2, trackClassName: "stroke-accent/20" });

    expect(svg.getAttribute("viewBox")).toBe("0 0 36 36");
    expect(svg.getAttribute("width")).toBe("36");
    expect(circles[0]?.getAttribute("class")).toBe("stroke-accent/20");
    expect(circles[1]?.getAttribute("r")).toBe("15.5");
    expect(circles[1]?.getAttribute("transform")).toBe("rotate(-90 18 18)");
  });

  it("colors the arc through the shared state mapping", () => {
    for (const state of ["ok", "mid", "warn"] as const) {
      const { circles } = ring({ tokenState: state });
      expect(circles[1]?.getAttribute("class")).toBe(CONTEXT_STATE_CLASSES[state].stroke);
    }
    expect(CONTEXT_STATE_CLASSES.ok).toEqual({ stroke: "stroke-accent", text: "text-accent-t" });
    expect(CONTEXT_STATE_CLASSES.mid).toEqual({ stroke: "stroke-warning-text", text: "text-warning-text" });
    expect(CONTEXT_STATE_CLASSES.warn).toEqual({ stroke: "stroke-danger-text", text: "text-danger-text" });
  });

  it("the mobile trigger (co-author) draws the same crisp ring", () => {
    const view = render(
      <TooltipProvider><TokenCounterPopover mobile permanent={100} history={25} inputTokens={25} contextSize={200} maxTokens={0} availableBudget={200} tokenState="ok" permanentItems={[]} /></TooltipProvider>,
    );
    const svg = view.container.querySelector("svg")!;

    expect(svg.getAttribute("class") ?? "").not.toContain("rotate");
    expect(svg.querySelector("circle")?.getAttribute("transform")).toBe("rotate(-90 14 14)");
  });
});
