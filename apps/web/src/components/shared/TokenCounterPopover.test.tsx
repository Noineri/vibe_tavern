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

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ TokenCounterPopover } = await import("./TokenCounterPopover.js"));
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
