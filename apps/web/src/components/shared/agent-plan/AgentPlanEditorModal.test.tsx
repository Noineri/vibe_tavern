import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { testFetch } from "@vibe-tavern/test-fetch";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { AgentPlan } from "@vibe-tavern/api-contracts";
import type { StoryClock } from "@vibe-tavern/domain";

useDomEnv();

const { act, fireEvent, render, waitFor, within } = await import("@testing-library/react");
const { AgentPlanEditorModal } = await import("./AgentPlanEditorModal.js");

const originalFetch = globalThis.fetch;
let putBody: unknown = null;
let lastPath = "";
let rejectPut = false;
// DK-10: the story GET's canned plan override (null = the shared INITIAL_PLAN,
// so every pre-existing story test keeps its exact fixture).
let storyPlanOverride: AgentPlan | null = null;

const INITIAL_PLAN: AgentPlan = {
  goal: "Build the editor",
  constraints: ["Use shared primitives"],
  tasks: [
    { id: "task_1", title: "First task", body: "First body", status: "active" },
    { id: "task_2", title: "Second task", body: "Second body", status: "pending" },
  ],
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const fetchRouter = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = new URL(String(input), "http://gateway.test").pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  if (/\/api\/scripts\/[^/]+\/agent-plan$/.test(path) && method === "GET") return jsonResponse({ plan: INITIAL_PLAN });
  if (/\/api\/scripts\/[^/]+\/agent-plan$/.test(path) && method === "PUT") {
    putBody = JSON.parse(String(init?.body ?? "{}"));
    if (rejectPut) return jsonResponse({ error: { message: "At most one task can be active." } }, 422);
    return jsonResponse({ plan: (putBody as { plan: AgentPlan }).plan });
  }
  // DR-9: the branch (story-plan) route — same canned payloads, any owner.
  if (/\/api\/agent\/chats\/[^/]+\/branches\/[^/]+\/plan$/.test(path) && method === "GET") {
    lastPath = path;
    return jsonResponse({ plan: storyPlanOverride ?? INITIAL_PLAN });
  }
  if (/\/api\/agent\/chats\/[^/]+\/branches\/[^/]+\/plan$/.test(path) && method === "PUT") {
    lastPath = path;
    putBody = JSON.parse(String(init?.body ?? "{}"));
    return jsonResponse({ plan: (putBody as { plan: AgentPlan }).plan });
  }
  return jsonResponse({ error: { message: `unrouted ${method} ${path}` } }, 404);
});

beforeEach(() => {
  putBody = null;
  lastPath = "";
  rejectPut = false;
  storyPlanOverride = null;
  fetchRouter.mockClear();
  globalThis.fetch = testFetch(fetchRouter);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function renderModal(id: string, locked = false) {
  const onClose = mock();
  const view = render(<AgentPlanEditorModal owner={{ kind: "script", scriptId: id }} open onClose={onClose} locked={locked} />);
  return { ...view, onClose };
}

describe("AgentPlanEditorModal", () => {
  it("saves the edited plan through PUT", async () => {
    const { getByLabelText, getByTestId, onClose } = renderModal("save-plan");
    await waitFor(() => expect((getByLabelText("agent_plan_goal") as HTMLTextAreaElement).value).toBe("Build the editor"));
    fireEvent.change(getByLabelText("agent_plan_goal"), { target: { value: "Saved through PUT" } });
    fireEvent.click(getByTestId("agent-plan-save"));

    await waitFor(() => expect(putBody).toEqual({ plan: expect.objectContaining({ goal: "Saved through PUT" }) }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("locks every editor control and explains why saving is unavailable", async () => {
    const { getByLabelText, getByTestId, getByText } = renderModal("locked-plan", true);
    await waitFor(() => expect(getByLabelText("agent_plan_goal").getAttribute("disabled")).toBe("") );
    expect(getByTestId("agent-plan-save").getAttribute("disabled")).toBe("");
    expect(getByText("agent_plan_locked")).toBeDefined();
    fireEvent.click(getByTestId("agent-plan-save"));
    expect(putBody).toBeNull();
  });

  it("adds, removes, and reorders constraints and tasks", async () => {
    const { getByText, getAllByLabelText, getAllByTestId, queryAllByTestId } = renderModal("edit-plan");
    await waitFor(() => expect(getAllByTestId(/agent-plan-editor-task-/)).toHaveLength(2));

    fireEvent.click(getByText("agent_plan_add_constraint"));
    expect(getAllByLabelText(/agent_plan_constraints/)).toHaveLength(2);
    fireEvent.click(getAllByLabelText("agent_plan_remove")[0]!);
    expect(getAllByLabelText(/agent_plan_constraints/)).toHaveLength(1);

    fireEvent.click(getByText("agent_plan_add_task"));
    expect(getAllByTestId(/agent-plan-editor-task-/)).toHaveLength(3);
    fireEvent.click(getAllByLabelText("agent_plan_move_down")[0]!);
    const taskTitles = getAllByTestId(/agent-plan-editor-task-/).map((task) => (task.querySelector("input") as HTMLInputElement).value);
    expect(taskTitles).toEqual(["Second task", "First task", ""]);
    fireEvent.click(getAllByLabelText("agent_plan_remove")[1]!);
    expect(queryAllByTestId(/agent-plan-editor-task-/)).toHaveLength(2);
  });

  it("keeps the modal open and shows the server 422 message for two active tasks", async () => {
    rejectPut = true;
    const { getByTestId, getByText, getAllByText } = renderModal("two-active-plan");
    await waitFor(() => expect(getByTestId("agent-plan-status-1")).toBeDefined());

    fireEvent.click(getByTestId("agent-plan-status-1"));
    fireEvent.click(getAllByText("agent_plan_status_active").at(-1)!);
    fireEvent.click(getByTestId("agent-plan-save"));

    await waitFor(() => expect(putBody).not.toBeNull());
    expect((putBody as { plan: AgentPlan }).plan.tasks.filter((task) => task.status === "active")).toHaveLength(2);
    await waitFor(() => expect(getByText("At most one task can be active.")).toBeDefined());
    expect(getByTestId("agent-plan-save")).toBeDefined();
  });
});

// ─── DR-9 (mockup §7): the story label set for a branch owner ───────────────
// Key-echo i18n (the default context) — every STORY key asserted present,
// and the script keys that must NOT leak into the story editor asserted
// absent. The save pins the owner routing: the branch route, never the
// script one.
describe("AgentPlanEditorModal — story labels for a branch owner (DR-9)", () => {
  function renderStoryModal(locked = false, branchId = "story-branch") {
    const onClose = mock();
    const view = render(
      <AgentPlanEditorModal
        owner={{ kind: "chatBranch", chatId: "story-chat", branchId }}
        open
        onClose={onClose}
        locked={locked}
      />,
    );
    return { ...view, onClose };
  }

  it("renders every §7 label: title, premise + hint, rules, events, body hint + placeholder", async () => {
    const { getByLabelText, getByTestId, queryByPlaceholderText, queryAllByPlaceholderText, getAllByText, getAllByLabelText, getAllByPlaceholderText, queryByText } = renderStoryModal(false, "story-labels-branch");
    // Terminal state: the premise field carries the canned plan's goal.
    await waitFor(() => expect((getByLabelText("agent_plan_story_goal") as HTMLTextAreaElement).value).toBe("Build the editor"));

    // Title «План сюжета» (the sr-only Dialog.Title and the visible h2).
    expect(getAllByText("agent_plan_story_title").length).toBeGreaterThanOrEqual(1);
    // «Завязка» + the §7 hint under it.
    expect(getByTestId("agent-plan-goal-hint").textContent).toBe("agent_plan_story_goal_hint");
    // «Правила истории» / «+ Правило».
    expect(getAllByText("agent_plan_story_constraints").length).toBeGreaterThanOrEqual(1);
    expect(getAllByText("agent_plan_story_add_constraint")).toHaveLength(1);
    // «События» / «+ Событие».
    expect(getAllByText("agent_plan_story_tasks").length).toBeGreaterThanOrEqual(1);
    expect(getAllByText("agent_plan_story_add_task")).toHaveLength(1);
    // Body hint (one per event — 2 canned tasks) + the §7 placeholder.
    expect(getAllByText("agent_plan_story_task_body_hint")).toHaveLength(2);
    expect(getAllByPlaceholderText("agent_plan_story_task_body_placeholder")).toHaveLength(2);
    expect(getAllByLabelText(/agent_plan_story_task_body/)).toHaveLength(2);

    // The script editor's wording never leaks into the story editor.
    expect(queryByText("agent_plan_constraints")).toBeNull();
    expect(queryByText("agent_plan_add_constraint")).toBeNull();
    expect(queryByText("agent_plan_tasks")).toBeNull();
    expect(queryByText("agent_plan_add_task")).toBeNull();
    expect(queryAllByPlaceholderText("agent_plan_task_body_placeholder")).toHaveLength(0);
    // The event's status selector stays as today (§7 note).
    expect(getByTestId("agent-plan-status-0")).toBeDefined();
  });

  it("saves the story plan through the BRANCH route (the hook's owner routing)", async () => {
    const { getByLabelText, getByTestId, onClose } = renderStoryModal();
    await waitFor(() => expect((getByLabelText("agent_plan_story_goal") as HTMLTextAreaElement).value).toBe("Build the editor"));
    fireEvent.change(getByLabelText("agent_plan_story_goal"), { target: { value: "A stray cat became a young man overnight" } });
    fireEvent.click(getByTestId("agent-plan-save"));

    await waitFor(() => expect(putBody).not.toBeNull());
    expect((putBody as { plan: AgentPlan }).plan.goal).toBe("A stray cat became a young man overnight");
    // The hono client prefixes the gateway base ("/null" under tests) —
    // match the route suffix, not the exact string.
    expect(lastPath.endsWith("/api/agent/chats/story-chat/branches/story-branch/plan")).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("AgentPlanEditorModal — scroll surface (CNR-8h)", () => {
  it("the editor body scrolls on the thin ScrollArea lane; header and footer stay docked", async () => {
    const { getByLabelText, getByTestId } = renderModal("scroll-plan");
    const goal = await waitFor(() => getByLabelText("agent_plan_goal"));
    // The goal field itself is an editor lane since the CNR-8n AutoTextarea
    // flip — the modal BODY lane is the closest non-editor scroll area.
    const area = goal.closest<HTMLElement>('[data-scroll-area]:not([data-scroll-editor])')!;
    expect(area.getAttribute("data-scroll-area")).toBe("thin");
    // The shared body rides the lane for BOTH viewports (the CNR-7g policy
    // hides it on phones): fields sit on the scroller's content with the
    // desktop body padding, the panel header and the save footer stay
    // OUTSIDE the scroller (one wrapper, same paddings as before).
    expect(area.querySelector("[data-scroll-content]")!.className).toContain("py-5");
    expect(getByTestId("agent-plan-save").closest("[data-scroll-area]")).toBeNull();
    const viewport = area.querySelector<HTMLElement>("[data-scroll-viewport]")!;
    expect(viewport.classList.contains("scrollbar-hide")).toBe(true);
    // Fake a tall body (happy-dom has no layout) → the vertical lane mounts.
    Object.defineProperties(viewport, {
      clientHeight: { value: 100 }, scrollHeight: { value: 1000 },
      clientWidth: { value: 200 }, scrollWidth: { value: 200 },
    });
    await act(async () => {
      viewport.scrollTop = 200;
      fireEvent.scroll(viewport);
    });
    await waitFor(() => expect(area.querySelector("[data-scroll-thumb]")).not.toBeNull());
    expect(area.querySelector("[data-scroll-track]")?.getAttribute("data-orientation")).toBe("vertical");
  });
});

// ─── DK-10 (mockup §6): the when-row ────────────────────────────────────────
// Pins the gate (story owner WHILE the clock reads; script plans and a
// clockless branch render byte-identically — no row at all), the assign
// default (the clock's day, part null = "any time"), the day+part editing,
// the part-null write, the day field's commit semantics (the shared
// NumberInput: non-numeric reverts on blur, sub-1 clamps up, fractional
// rounds through the glue — an out-of-domain day never persists), and the
// back-toggle to undated. Key-echo i18n: labels assert their keys; the day
// field is found by its inputTestId (the primitive carries no aria-label).
describe("AgentPlanEditorModal — the when-row (DK-10, mockup §6)", () => {
  const CLOCK: StoryClock = { day: 3, part: "evening", label: null };
  const DATED_PLAN: AgentPlan = {
    goal: "Build the editor",
    constraints: [],
    tasks: [
      { id: "task_1", title: "First task", body: "First body", status: "active", at: { day: 4, part: "morning" } },
      { id: "task_2", title: "Second task", body: "Second body", status: "pending" },
    ],
  };

  function renderWhenModal(branchId: string, storyClock: StoryClock | null = CLOCK) {
    const onClose = mock();
    const view = render(
      <AgentPlanEditorModal
        owner={{ kind: "chatBranch", chatId: "when-chat", branchId }}
        open
        onClose={onClose}
        locked={false}
        storyClock={storyClock}
      />,
    );
    return { ...view, onClose };
  }

  async function row(index: number, branchId: string) {
    const view = renderWhenModal(branchId);
    const taskRow = await waitFor(() => view.getByTestId(`agent-plan-editor-task-${index}`));
    return { view, taskRow: within(taskRow) };
  }

  it("renders the when-row for a story owner while the clock reads; the dated row shows the day fields", async () => {
    storyPlanOverride = DATED_PLAN;
    const { view, taskRow } = await row(0, "when-row-gate-1");
    expect(taskRow.getByText("story_plan_when")).toBeDefined();
    expect(taskRow.getByRole("radio", { name: "story_plan_when_dated" }).getAttribute("aria-checked")).toBe("true");
    expect((taskRow.getByTestId("agent-plan-when-day-0") as HTMLInputElement).value).toBe("4");
    // The five part options — the four story parts + any time; morning is
    // the stored part.
    expect(taskRow.getByRole("radio", { name: "story_clock_part_morning" }).getAttribute("aria-checked")).toBe("true");
    expect(taskRow.getByRole("radio", { name: "story_clock_part_day" })).toBeDefined();
    expect(taskRow.getByRole("radio", { name: "story_clock_part_evening" })).toBeDefined();
    expect(taskRow.getByRole("radio", { name: "story_clock_part_night" })).toBeDefined();
    expect(taskRow.getByRole("radio", { name: "story_plan_when_anytime" })).toBeDefined();
    // The undated row carries the mode control, no day fields.
    const undatedRow = within(view.getByTestId("agent-plan-editor-task-1"));
    expect(undatedRow.getByRole("radio", { name: "story_plan_when_undated" }).getAttribute("aria-checked")).toBe("true");
    expect(undatedRow.queryByTestId("agent-plan-when-day-1")).toBeNull();
    view.unmount();
  });

  it("renders NOTHING when the clock does not read — story owner without a clock (byte-identical)", async () => {
    const view = renderWhenModal("when-row-gate-2", null);
    await waitFor(() => expect(view.getByTestId("agent-plan-editor-task-0")).toBeDefined());
    expect(view.queryByText("story_plan_when")).toBeNull();
    expect(view.queryByRole("radio", { name: "story_plan_when_dated" })).toBeNull();
    view.unmount();
  });

  it("renders NOTHING for a script owner even when a clock is threaded (byte-identical)", async () => {
    const onClose = mock();
    const view = render(
      <AgentPlanEditorModal owner={{ kind: "script", scriptId: "when-script" }} open onClose={onClose} locked={false} storyClock={CLOCK} />,
    );
    await waitFor(() => expect(view.getByTestId("agent-plan-editor-task-0")).toBeDefined());
    expect(view.queryByText("story_plan_when")).toBeNull();
    view.unmount();
  });

  it("assigning a day defaults to the clock's day + any time, and part edits write at through the PUT", async () => {
    const view = renderWhenModal("when-row-assign");
    const { onClose } = view;
    const taskRow = within(await waitFor(() => view.getByTestId("agent-plan-editor-task-1")));
    fireEvent.click(taskRow.getByRole("radio", { name: "story_plan_when_dated" }));
    // The clock's current day anchors the default; "any time" (part null)
    // starts selected.
    const day = taskRow.getByTestId("agent-plan-when-day-1") as HTMLInputElement;
    expect(day.value).toBe("3");
    // The compact shape: hideControls — the day field renders no stepper
    // buttons (the decrease stepper's accessible label is the primitive's
    // number_decrease key); steppers would clip inside the field's 56px cap.
    expect(taskRow.queryByRole("button", { name: "number_decrease" })).toBeNull();
    expect(taskRow.getByRole("radio", { name: "story_plan_when_anytime" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.change(day, { target: { value: "5" } });
    // NumberInput commits on blur — without it the entry sits uncommitted.
    fireEvent.blur(day);
    fireEvent.click(taskRow.getByRole("radio", { name: "story_clock_part_night" }));
    fireEvent.click(view.getByTestId("agent-plan-save"));
    await waitFor(() => expect(putBody).not.toBeNull());
    const saved = (putBody as { plan: AgentPlan }).plan;
    expect(saved.tasks[1]!.at).toEqual({ day: 5, part: "night" });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("part null writes through the any-time segment", async () => {
    storyPlanOverride = DATED_PLAN;
    const view = renderWhenModal("when-row-anytime");
    const { onClose } = view;
    const taskRow = within(await waitFor(() => view.getByTestId("agent-plan-editor-task-0")));
    fireEvent.click(taskRow.getByRole("radio", { name: "story_plan_when_anytime" }));
    fireEvent.click(view.getByTestId("agent-plan-save"));
    await waitFor(() => expect(putBody).not.toBeNull());
    expect((putBody as { plan: AgentPlan }).plan.tasks[0]!.at).toEqual({ day: 4, part: null });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("a non-numeric day entry reverts on blur and never persists (the NumberInput semantics)", async () => {
    storyPlanOverride = DATED_PLAN;
    const view = renderWhenModal("when-row-invalid-non-numeric");
    const taskRow = within(await waitFor(() => view.getByTestId("agent-plan-editor-task-0")));
    const day = taskRow.getByTestId("agent-plan-when-day-0") as HTMLInputElement;
    fireEvent.change(day, { target: { value: "abc" } });
    // The blur commit: parseFloat("abc") is NaN → the previous day repaints
    // and no onChange ever fires.
    fireEvent.blur(day);
    expect(day.value).toBe("4");
    fireEvent.click(view.getByTestId("agent-plan-save"));
    await waitFor(() => expect(putBody).not.toBeNull());
    expect((putBody as { plan: AgentPlan }).plan.tasks[0]!.at).toEqual({ day: 4, part: "morning" });
    view.unmount();
  });

  it("a sub-1 day entry clamps up to 1 on blur", async () => {
    storyPlanOverride = DATED_PLAN;
    const view = renderWhenModal("when-row-invalid-sub-one");
    const taskRow = within(await waitFor(() => view.getByTestId("agent-plan-editor-task-0")));
    const day = taskRow.getByTestId("agent-plan-when-day-0") as HTMLInputElement;
    fireEvent.change(day, { target: { value: "0" } });
    // The blur commit clamps to min={1} — the wire never sees day < 1.
    fireEvent.blur(day);
    expect(day.value).toBe("1");
    fireEvent.click(view.getByTestId("agent-plan-save"));
    await waitFor(() => expect(putBody).not.toBeNull());
    expect((putBody as { plan: AgentPlan }).plan.tasks[0]!.at).toEqual({ day: 1, part: "morning" });
    view.unmount();
  });

  it("a fractional day entry integer-rounds through the commit glue", async () => {
    storyPlanOverride = DATED_PLAN;
    const view = renderWhenModal("when-row-invalid-fractional");
    const taskRow = within(await waitFor(() => view.getByTestId("agent-plan-editor-task-0")));
    const day = taskRow.getByTestId("agent-plan-when-day-0") as HTMLInputElement;
    fireEvent.change(day, { target: { value: "4.5" } });
    // The blur commit parses 4.5 (min={1} passes it through); the modal's
    // glue rounds it to the block invariant — an integer day reaches at.
    fireEvent.blur(day);
    expect(day.value).toBe("5");
    fireEvent.click(view.getByTestId("agent-plan-save"));
    await waitFor(() => expect(putBody).not.toBeNull());
    expect((putBody as { plan: AgentPlan }).plan.tasks[0]!.at).toEqual({ day: 5, part: "morning" });
    view.unmount();
  });

  it("toggling back to undated drops at entirely", async () => {
    storyPlanOverride = DATED_PLAN;
    const view = renderWhenModal("when-row-undated");
    const taskRow = within(await waitFor(() => view.getByTestId("agent-plan-editor-task-0")));
    fireEvent.click(taskRow.getByRole("radio", { name: "story_plan_when_undated" }));
    expect(taskRow.queryByTestId("agent-plan-when-day-0")).toBeNull();
    fireEvent.click(view.getByTestId("agent-plan-save"));
    await waitFor(() => expect(putBody).not.toBeNull());
    expect((putBody as { plan: AgentPlan }).plan.tasks[0]!.at).toBeUndefined();
    view.unmount();
  });
});
