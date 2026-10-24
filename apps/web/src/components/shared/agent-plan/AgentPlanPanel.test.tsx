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

  it("collapses onto the first PENDING task when nothing is active (pickCurrent fallback)", () => {
    const { getByTestId, getByText } = renderPanel({
      goal: "Ship",
      constraints: [],
      tasks: [
        { id: "p1", title: "First step", body: "", status: "pending" },
        { id: "p2", title: "Second step", body: "", status: "pending" },
      ],
    });
    expect(getByText("First step")).toBeDefined();
    expect(getByTestId("agent-plan-panel").textContent).toContain("· 2 agent_plan_remaining");
    expect(getByTestId("agent-plan-glyph-pending")).toBeDefined();
  });

  it("shows the done label and zero remaining for a fully-resolved plan", () => {
    const { getByTestId, getByText } = renderPanel({
      goal: "Ship",
      constraints: [],
      tasks: [
        { id: "c1", title: "Only step", body: "", status: "completed" },
        { id: "a1", title: "Dropped", body: "", status: "abandoned" },
      ],
    });
    expect(getByText("agent_plan_done")).toBeDefined();
    expect(getByTestId("agent-plan-panel").textContent).toContain("· 0 agent_plan_remaining");
    expect(getByTestId("agent-plan-glyph-completed")).toBeDefined();
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

// ─── Page translation (owner follow-up 2026-10-24) ───────────────────────
// behavior change: was → now, basis: AGENT_SHELL_POLISH_PLAN owner follow-up
// 2026-10-24 (page translation). The task titles and the active task's body
// are MODEL text — they opt back in; the header and editor button stay out.
describe("AgentPlanPanel — page translation (follow-up 2026-10-24)", () => {
  it("collapsed current title + expanded task titles and active body carry translate=yes", () => {
    const { container, getByText, getByTestId } = renderPanel();
    expect(getByText("Build editor").getAttribute("translate")).toBe("yes");

    fireEvent.click(getByTestId("agent-plan-toggle"));
    // Container-scoped: the title text now exists in the expanded list.
    const optedIn = [...container.querySelectorAll('[translate="yes"]')].map((el) => el.textContent);
    expect(optedIn).toContain("Build editor");
    expect(optedIn).toContain("Wire chat");
    expect(optedIn).toContain("Active task details");
  });

  it("chrome carries no opt-in: the plan title label and editor button stay untranslated", () => {
    const { getByTestId, getByText } = renderPanel();
    fireEvent.click(getByTestId("agent-plan-toggle"));
    expect(getByText("agent_plan_title").getAttribute("translate")).toBeNull();
    expect(getByTestId("agent-plan-open-editor").getAttribute("translate")).toBeNull();
  });
});
