import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { AgentPlan } from "@vibe-tavern/api-contracts";

useDomEnv();

const { fireEvent, render, waitFor } = await import("@testing-library/react");
const { AgentPlanEditorModal } = await import("./AgentPlanEditorModal.js");

const originalFetch = globalThis.fetch;
let putBody: unknown = null;
let lastPath = "";
let rejectPut = false;

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
    return jsonResponse({ plan: INITIAL_PLAN });
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
  fetchRouter.mockClear();
  globalThis.fetch = fetchRouter as unknown as typeof fetch;
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
  function renderStoryModal(locked = false) {
    const onClose = mock();
    const view = render(
      <AgentPlanEditorModal
        owner={{ kind: "chatBranch", chatId: "story-chat", branchId: "story-branch" }}
        open
        onClose={onClose}
        locked={locked}
      />,
    );
    return { ...view, onClose };
  }

  it("renders every §7 label: title, premise + hint, rules, events, body hint + placeholder", async () => {
    const { getByLabelText, getByTestId, queryByPlaceholderText, queryAllByPlaceholderText, getAllByText, getAllByLabelText, getAllByPlaceholderText, queryByText } = renderStoryModal();
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
