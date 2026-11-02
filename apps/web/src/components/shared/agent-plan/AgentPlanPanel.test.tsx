import { describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { AgentPlan } from "@vibe-tavern/api-contracts";

useDomEnv();

const { act, fireEvent, render, waitFor } = await import("@testing-library/react");
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

// ─── DR-9: curtain presentation (mockup §5/§9) ─────────────────────────────
// behavior change: none — new OPTIONAL props. Default rendering is pinned
// above (byte-identical); these pin the story plan's curtain: the expanded
// part overlays below the constant row, the close paths, the actions slot,
// the editor-button visibility switch, the premise line, and R4's revert.
describe("AgentPlanPanel — curtain presentation (DR-9)", () => {
  function renderCurtain(over: Partial<Parameters<typeof AgentPlanPanel>[0]> = {}) {
    return render(<AgentPlanPanel plan={PLAN} onOpenEditor={mock()} locked={false} presentation="curtain" {...over} />);
  }

  it("renders the expanded part as an overlay below the CONSTANT row (no layout shift)", async () => {
    const { getByTestId, queryByTestId } = renderCurtain();
    expect(getByTestId("agent-plan-panel").getAttribute("data-state")).toBe("collapsed");
    expect(queryByTestId("agent-plan-curtain")).toBeNull();

    fireEvent.click(getByTestId("agent-plan-toggle"));
    const panel = getByTestId("agent-plan-panel");
    expect(panel.getAttribute("data-state")).toBe("expanded");
    // The in-flow row STAYS (its height never changes — the mechanism behind
    // "no layout shift"); the curtain is the only addition, absolutely
    // positioned from the row's bottom edge with the §5 geometry.
    expect(getByTestId("agent-plan-toggle")).toBeDefined();
    expect(panel.className).toContain("relative");
    const curtain = getByTestId("agent-plan-curtain");
    expect(curtain.className).toContain("absolute");
    expect(curtain.className).toContain("left-0 right-0 top-full");
    expect(curtain.className).toContain("max-h-[60vh]");
    expect(curtain.className).toContain("shadow-[var(--shadow-md)]");
    // CNR-8h: the curtain IS the thin ScrollArea root now — same §5 geometry
    // and the same max-h-[60vh] ceiling above (the capped internal-scroll
    // boundary, pinned through the new wiring): the rows scroll inside its
    // viewport with the gap/padding on the content element.
    expect(curtain.getAttribute("data-scroll-area")).toBe("thin");
    const viewport = curtain.querySelector<HTMLElement>("[data-scroll-viewport]")!;
    expect(viewport.classList.contains("scrollbar-hide")).toBe(true);
    expect(curtain.querySelector("[data-scroll-content]")?.className).toContain("gap-1");
    // Base UI mounts a scrollbar lazily (overflow observed); happy-dom has no
    // layout, so fake the measurement the way scroll-area.test.tsx does.
    Object.defineProperties(viewport, {
      clientHeight: { value: 100 }, scrollHeight: { value: 1000 },
      clientWidth: { value: 200 }, scrollWidth: { value: 200 },
    });
    await act(async () => {
      viewport.scrollTop = 200;
      fireEvent.scroll(viewport);
    });
    await waitFor(() => expect(curtain.querySelector("[data-scroll-thumb]")).not.toBeNull());
    expect(curtain.querySelector("[data-scroll-track]")?.getAttribute("data-orientation")).toBe("vertical");
    // §5: the story title heads the curtain; the premise rides on top (P2).
    expect(curtain.textContent).toContain("agent_plan_story_title");
    expect(getByTestId("agent-plan-premise")).toBeDefined();
  });

  it("omits the premise line when the plan has no goal", () => {
    const { getByTestId, queryByTestId } = renderCurtain({ plan: { goal: "", constraints: [], tasks: PLAN.tasks } });
    fireEvent.click(getByTestId("agent-plan-toggle"));
    expect(queryByTestId("agent-plan-premise")).toBeNull();
  });

  it("closes on outside click, on Esc, and on either chevron", () => {
    const { getByTestId, queryByTestId } = renderCurtain();
    fireEvent.click(getByTestId("agent-plan-toggle"));
    expect(getByTestId("agent-plan-curtain")).toBeDefined();

    // Outside click (a mousedown outside the panel root).
    fireEvent.mouseDown(document.body);
    expect(queryByTestId("agent-plan-curtain")).toBeNull();
    expect(getByTestId("agent-plan-panel").getAttribute("data-state")).toBe("collapsed");

    // Esc.
    fireEvent.click(getByTestId("agent-plan-toggle"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(queryByTestId("agent-plan-curtain")).toBeNull();

    // The curtain header's chevron.
    fireEvent.click(getByTestId("agent-plan-toggle"));
    fireEvent.click(getByTestId("agent-plan-curtain-close"));
    expect(queryByTestId("agent-plan-curtain")).toBeNull();

    // The row's own toggle chevron (open → shut).
    fireEvent.click(getByTestId("agent-plan-toggle"));
    fireEvent.click(getByTestId("agent-plan-toggle"));
    expect(queryByTestId("agent-plan-curtain")).toBeNull();
  });

  it("renders the actions slot in the collapsed row AND the curtain header", () => {
    const { getByTestId, getAllByTestId } = renderCurtain({ actions: <span data-testid="curtain-action">Act</span> });
    expect(getAllByTestId("curtain-action")).toHaveLength(1);
    fireEvent.click(getByTestId("agent-plan-toggle"));
    expect(getAllByTestId("curtain-action")).toHaveLength(2);
  });

  it("hides the editor button in the collapsed row when asked; the curtain header keeps it", () => {
    const { getByTestId, queryByTestId } = renderCurtain({ showEditorInCollapsedRow: false });
    expect(queryByTestId("agent-plan-open-editor")).toBeNull();
    fireEvent.click(getByTestId("agent-plan-toggle"));
    expect(getByTestId("agent-plan-open-editor")).toBeDefined();
  });

  it("R4: renders «Вернуть в работу» on completed events and reports the task id", () => {
    const onRevertTask = mock();
    const { getByTestId, queryByTestId } = renderCurtain({ onRevertTask });
    fireEvent.click(getByTestId("agent-plan-toggle"));
    const revert = getByTestId("agent-plan-revert-done");
    expect(revert.textContent).toBe("agent_plan_revert");
    // Only completed events carry it.
    expect(queryByTestId("agent-plan-revert-active")).toBeNull();
    fireEvent.click(revert);
    expect(onRevertTask).toHaveBeenCalledTimes(1);
    expect(onRevertTask).toHaveBeenCalledWith("done");
  });

  it("no revert button in INLINE mode, and none in curtain mode without a handler", () => {
    const onRevertTask = mock();
    const inline = render(<AgentPlanPanel plan={PLAN} onOpenEditor={mock()} locked={false} onRevertTask={onRevertTask} />);
    fireEvent.click(inline.getByTestId("agent-plan-toggle"));
    expect(inline.queryByTestId("agent-plan-revert-done")).toBeNull();

    const bare = renderCurtain();
    fireEvent.click(bare.getByTestId("agent-plan-toggle"));
    expect(bare.queryByTestId("agent-plan-revert-done")).toBeNull();
    expect(onRevertTask).not.toHaveBeenCalled();
  });

  it("the revert button locks with the turn (same lock as the editor)", () => {
    const { getByTestId, getAllByTestId } = renderCurtain({ locked: true, onRevertTask: mock() });
    fireEvent.click(getByTestId("agent-plan-toggle"));
    expect(getByTestId("agent-plan-revert-done").getAttribute("disabled")).toBe("");
    // Both editor instances (the row's and the curtain header's) lock.
    for (const button of getAllByTestId("agent-plan-open-editor")) {
      expect(button.getAttribute("disabled")).toBe("");
    }
  });
});
