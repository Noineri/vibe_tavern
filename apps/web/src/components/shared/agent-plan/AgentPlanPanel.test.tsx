import { describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { AgentPlan } from "@vibe-tavern/api-contracts";

useDomEnv();

const { fireEvent, render } = await import("@testing-library/react");
const { AgentPlanPanel } = await import("./AgentPlanPanel.js");

const PLAN: AgentPlan = {
  goal: "Ship the editor",
  constraints: ["Use shared primitives"],
  tasks: [
    { id: "done", title: "Define plan", body: "Completed body", status: "completed" },
    { id: "active", title: "Build editor", body: "Active task details", status: "active" },
    { id: "pending", title: "Wire chat", body: "Pending body", status: "pending" },
    { id: "abandoned", title: "Old path", body: "Abandoned body", status: "abandoned" },
  ],
};

function renderPanel(plan: AgentPlan = PLAN) {
  return render(<AgentPlanPanel plan={plan} onOpenEditor={mock()} locked={false} />);
}

describe("AgentPlanPanel", () => {
  it("renders the active task summary with the live glyph and remaining count", () => {
    const { getByTestId } = renderPanel();
    const panel = getByTestId("agent-plan-panel");
    expect(panel.getAttribute("data-state")).toBe("collapsed");
    expect(panel.textContent).toContain("Build editor");
    expect(panel.textContent).toContain("· 2 agent_plan_remaining");
    expect(getByTestId("agent-plan-glyph-active")).toBeDefined();
  });

  it("is hidden for the empty plan", () => {
    const { queryByTestId } = renderPanel({ goal: "", constraints: [], tasks: [] });
    expect(queryByTestId("agent-plan-panel")).toBeNull();
  });

  it("shows every task but only the active task body when expanded", () => {
    const { getByTestId, queryByText } = renderPanel();
    fireEvent.click(getByTestId("agent-plan-toggle"));

    const panel = getByTestId("agent-plan-panel");
    expect(panel.getAttribute("data-state")).toBe("expanded");
    expect(panel.textContent).toContain("Define plan");
    expect(panel.textContent).toContain("Build editor");
    expect(panel.textContent).toContain("Wire chat");
    expect(panel.textContent).toContain("Old path");
    expect(panel.textContent).toContain("Active task details");
    expect(queryByText("Completed body")).toBeNull();
    expect(queryByText("Pending body")).toBeNull();
    expect(queryByText("Abandoned body")).toBeNull();
  });

  it("keeps the editor button in collapsed and expanded headers", () => {
    const onOpenEditor = mock();
    const { getByTestId } = render(<AgentPlanPanel plan={PLAN} onOpenEditor={onOpenEditor} locked={false} />);
    expect(getByTestId("agent-plan-open-editor").textContent).toBe("agent_plan_editor");
    fireEvent.click(getByTestId("agent-plan-toggle"));
    fireEvent.click(getByTestId("agent-plan-open-editor"));
    expect(onOpenEditor).toHaveBeenCalledTimes(1);
  });
});
