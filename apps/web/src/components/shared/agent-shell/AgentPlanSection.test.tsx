/**
 * DR-9 — AgentPlanSection's owner-kind wiring.
 *
 * Pins, with fetch-level routing (real `useAgentPlan` against canned
 * payloads — no module-registry touching):
 *   - a BRANCH owner renders the curtain presentation (the mobile
 *     «Сайдчат» pane's story plan, mockup §5/§9) and R4's «Вернуть в работу»
 *     writes the reverted event active + the active one pending through the
 *     hook's `save` (the branch PUT — the editor's write, no new surface);
 *   - the revert respects the streaming lock (no PUT while locked);
 *   - a SCRIPT owner renders today's inline panel (no curtain, no revert).
 *
 * Each test uses its OWN owner (`useAgentPlan`'s cache is module-global and
 * keyed by owner — a shared key would serve the first test's plan to every
 * later one).
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { testFetch } from "@vibe-tavern/test-fetch";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { AgentPlan } from "@vibe-tavern/api-contracts";

useDomEnv();

const { fireEvent, render, waitFor } = await import("@testing-library/react");
const { AgentPlanSection } = await import("./AgentPlanSection.js");

const originalFetch = globalThis.fetch;
let putBody: unknown = null;
let lastPath = "";

const PLAN: AgentPlan = {
  goal: "A stray cat became a young man overnight",
  constraints: ["Cozy comedy, no drama for drama's sake"],
  tasks: [
    { id: "done", title: "The morning after", body: "", status: "completed" },
    { id: "live", title: "The fridge raid", body: "Archie opens the fridge himself.", status: "active" },
    { id: "next", title: "House rules", body: "", status: "pending" },
  ],
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const fetchRouter = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = new URL(String(input), "http://gateway.test").pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  if (/\/api\/agent\/chats\/[^/]+\/branches\/[^/]+\/plan$/.test(path) && method === "GET") {
    lastPath = path;
    return jsonResponse({ plan: PLAN });
  }
  if (/\/api\/agent\/chats\/[^/]+\/branches\/[^/]+\/plan$/.test(path) && method === "PUT") {
    lastPath = path;
    putBody = JSON.parse(String(init?.body ?? "{}"));
    return jsonResponse({ plan: (putBody as { plan: AgentPlan }).plan });
  }
  if (/\/api\/scripts\/[^/]+\/agent-plan$/.test(path) && method === "GET") {
    lastPath = path;
    return jsonResponse({ plan: PLAN });
  }
  return jsonResponse({ error: { message: `unrouted ${method} ${path}` } }, 404);
});

beforeEach(() => {
  putBody = null;
  lastPath = "";
  fetchRouter.mockClear();
  globalThis.fetch = testFetch(fetchRouter);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("AgentPlanSection — branch owner (DR-9)", () => {
  it("renders the curtain and writes the revert through the branch PUT (R4)", async () => {
    const view = render(
      <AgentPlanSection owner={{ kind: "chatBranch", chatId: "sec-chat", branchId: "sec-branch" }} locked={false} />,
    );
    // Settle: the row's title comes from the canned plan's ACTIVE task.
    await waitFor(() => expect(view.getByTestId("agent-plan-panel").textContent).toContain("The fridge raid"));
    fireEvent.click(view.getByTestId("agent-plan-toggle"));
    expect(view.getByTestId("agent-plan-curtain")).toBeDefined();

    fireEvent.click(view.getByTestId("agent-plan-revert-done"));
    await waitFor(() => expect(putBody).not.toBeNull());
    const saved = (putBody as { plan: AgentPlan }).plan;
    // The reverted event becomes the ONE active event; the live one steps
    // back to pending; goal/constraints/order ride through untouched.
    expect(saved.tasks.map((task) => [task.id, task.status])).toEqual([
      ["done", "active"],
      ["live", "pending"],
      ["next", "pending"],
    ]);
    expect(saved.goal).toBe(PLAN.goal);
    expect(saved.constraints).toEqual(PLAN.constraints);
    // The hono client prefixes the gateway base — match the suffix.
    expect(lastPath.endsWith("/api/agent/chats/sec-chat/branches/sec-branch/plan")).toBe(true);
  });

  it("the revert respects the streaming lock — no PUT while locked", async () => {
    const view = render(
      <AgentPlanSection owner={{ kind: "chatBranch", chatId: "lock-chat", branchId: "lock-branch" }} locked />,
    );
    await waitFor(() => expect(view.getByTestId("agent-plan-panel").textContent).toContain("The fridge raid"));
    fireEvent.click(view.getByTestId("agent-plan-toggle"));
    expect(view.getByTestId("agent-plan-revert-done").getAttribute("disabled")).toBe("");
    fireEvent.click(view.getByTestId("agent-plan-revert-done"));
    expect(putBody).toBeNull();
  });
});

describe("AgentPlanSection — script owner (DR-9)", () => {
  it("renders today's inline panel: no curtain, no revert buttons", async () => {
    const view = render(<AgentPlanSection owner={{ kind: "script", scriptId: "sec-script" }} locked={false} />);
    await waitFor(() => expect(view.getByTestId("agent-plan-panel").textContent).toContain("The fridge raid"));
    fireEvent.click(view.getByTestId("agent-plan-toggle"));
    expect(view.getByTestId("agent-plan-panel").getAttribute("data-state")).toBe("expanded");
    expect(view.queryByTestId("agent-plan-curtain")).toBeNull();
    expect(view.queryByTestId("agent-plan-revert-done")).toBeNull();
  });
});
