import { beforeAll, describe, expect, it } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { ExperienceCopilotToolActivity } from "../../../stores/experience-copilot-turn-store.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let AgentToolAccordion: typeof import("./AgentToolAccordion.js").AgentToolAccordion;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ AgentToolAccordion } = await import("./AgentToolAccordion.js"));
});

function activity(id: string): ExperienceCopilotToolActivity {
  return {
    toolCallId: id,
    toolName: "run_test",
    status: "done",
    summary: `${id} passed`,
  };
}

describe("CopilotToolAccordion", () => {
  it("keeps the live turn expanded while tool cards stream in", () => {
    const { getAllByTestId, getByTestId } = render(
      <AgentToolAccordion activities={[activity("first"), activity("second")]} isSending />,
    );

    expect(getByTestId("copilot-tool-accordion-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(getByTestId("copilot-tool-accordion-body").getAttribute("aria-hidden")).toBeNull();
    expect(getAllByTestId("copilot-activity-card")).toHaveLength(2);
  });

  it("collapses a completed turn by default and exposes its tool count in the header", () => {
    const { getAllByTestId, getByTestId } = render(
      <AgentToolAccordion activities={[activity("first"), activity("second")]} isSending={false} />,
    );

    const header = getByTestId("copilot-tool-accordion-toggle");
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(header.getAttribute("data-count")).toBe("2");
    expect(getByTestId("copilot-tool-accordion-body").getAttribute("aria-hidden")).toBe("true");
    expect(getAllByTestId("copilot-activity-card")).toHaveLength(2);
  });

  it("auto-collapses after the live turn completes", () => {
    const activities = [activity("first"), activity("second")];
    const { getByTestId, rerender } = render(
      <AgentToolAccordion activities={activities} isSending />,
    );

    rerender(<AgentToolAccordion activities={activities} isSending={false} />);

    expect(getByTestId("copilot-tool-accordion-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(getByTestId("copilot-tool-accordion-body").getAttribute("aria-hidden")).toBe("true");
  });

  it("toggles a completed tool run locally and retains that choice across re-renders", () => {
    const activities = [activity("first"), activity("second")];
    const { getByTestId, rerender } = render(
      <AgentToolAccordion activities={activities} isSending={false} />,
    );

    const header = getByTestId("copilot-tool-accordion-toggle");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(getByTestId("copilot-tool-accordion-body").getAttribute("aria-hidden")).toBeNull();

    rerender(<AgentToolAccordion activities={[...activities]} isSending={false} />);
    expect(header.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(getByTestId("copilot-tool-accordion-body").getAttribute("aria-hidden")).toBe("true");
  });

  it("renders a single completed card in its own accordion", () => {
    const { getAllByTestId, getByTestId } = render(
      <AgentToolAccordion activities={[activity("only")]} isSending={false} />,
    );

    expect(getByTestId("copilot-tool-accordion-toggle").getAttribute("data-count")).toBe("1");
    expect(getAllByTestId("copilot-activity-card")).toHaveLength(1);
  });
});
