import { describe, expect, test } from "bun:test";
import {
  AGENT_PLAN_TASK_STATUS,
  normalizeAgentPlan,
} from "../src/index.js";

describe("normalizeAgentPlan", () => {
  test("normalizes a valid plan", () => {
    expect(normalizeAgentPlan({
      goal: "Ship the script",
      constraints: ["Keep saves compatible"],
      tasks: [{
        id: "task_1",
        title: "Implement storage",
        body: "Add the persisted plan table.",
        status: AGENT_PLAN_TASK_STATUS.active,
      }],
    })).toEqual({
      goal: "Ship the script",
      constraints: ["Keep saves compatible"],
      tasks: [{
        id: "task_1",
        title: "Implement storage",
        body: "Add the persisted plan table.",
        status: AGENT_PLAN_TASK_STATUS.active,
      }],
    });
  });

  test("drops tasks without an id", () => {
    const plan = normalizeAgentPlan({
      goal: "G",
      constraints: [],
      tasks: [
        { title: "Missing id", body: "discard", status: "pending" },
        { id: "task_1", title: "Keep", body: "keep", status: "pending" },
      ],
    });

    expect(plan?.tasks).toEqual([
      { id: "task_1", title: "Keep", body: "keep", status: AGENT_PLAN_TASK_STATUS.pending },
    ]);
  });

  test("falls back unknown task statuses to pending", () => {
    const plan = normalizeAgentPlan({
      goal: "G",
      constraints: [],
      tasks: [{ id: "task_1", title: "Keep", body: "body", status: "in_progress" }],
    });

    expect(plan?.tasks[0]?.status).toBe(AGENT_PLAN_TASK_STATUS.pending);
  });

  test("rejects a plan with two active tasks", () => {
    expect(normalizeAgentPlan({
      goal: "G",
      constraints: [],
      tasks: [
        { id: "task_1", title: "First", body: "", status: "active" },
        { id: "task_2", title: "Second", body: "", status: "active" },
      ],
    })).toBeNull();
  });

  test("preserves a 100,000-character task body", () => {
    const body = "x".repeat(100_000);
    const plan = normalizeAgentPlan({
      goal: "G",
      constraints: [],
      tasks: [{ id: "task_1", title: "Large", body, status: "pending" }],
    });

    expect(plan?.tasks[0]?.body).toBe(body);
  });
});

describe("normalizeAgentPlan task `at` stamps (DK-1)", () => {
  test("keeps a valid at", () => {
    const plan = normalizeAgentPlan({
      goal: "G",
      constraints: [],
      tasks: [{ id: "task_1", title: "T", body: "", status: "pending", at: { day: 2, part: "evening" } }],
    });

    expect(plan?.tasks[0]?.at).toEqual({ day: 2, part: "evening" });
  });

  test("keeps a valid at with a null part", () => {
    const plan = normalizeAgentPlan({
      goal: "G",
      constraints: [],
      tasks: [{ id: "task_1", title: "T", body: "", status: "pending", at: { day: 3, part: null } }],
    });

    expect(plan?.tasks[0]?.at).toEqual({ day: 3, part: null });
  });

  test("drops an invalid at but keeps the task", () => {
    const plan = normalizeAgentPlan({
      goal: "G",
      constraints: [],
      tasks: [{ id: "task_1", title: "T", body: "", status: "pending", at: { day: 0, part: "morning" } }],
    });

    expect(plan?.tasks[0]?.id).toBe("task_1");
    expect("at" in (plan?.tasks[0] ?? {})).toBe(false);
  });

  test("drops a non-integer or negative day", () => {
    for (const day of [1.5, -2, "2", undefined]) {
      const plan = normalizeAgentPlan({
        goal: "G",
        constraints: [],
        tasks: [{ id: "task_1", title: "T", body: "", status: "pending", at: { day, part: "morning" } }],
      });

      expect(plan?.tasks[0]?.id).toBe("task_1");
      expect("at" in (plan?.tasks[0] ?? {})).toBe(false);
    }
  });

  test("drops an unknown part word", () => {
    const plan = normalizeAgentPlan({
      goal: "G",
      constraints: [],
      tasks: [{ id: "task_1", title: "T", body: "", status: "pending", at: { day: 2, part: "dusk" } }],
    });

    expect(plan?.tasks[0]?.id).toBe("task_1");
    expect("at" in (plan?.tasks[0] ?? {})).toBe(false);
  });

  test("drops an at that is not an object", () => {
    for (const bad of ["day 2", 7, null, true, [2, "morning"]]) {
      const plan = normalizeAgentPlan({
        goal: "G",
        constraints: [],
        tasks: [{ id: "task_1", title: "T", body: "", status: "pending", at: bad }],
      });

      expect(plan?.tasks[0]?.id).toBe("task_1");
      expect("at" in (plan?.tasks[0] ?? {})).toBe(false);
    }
  });

  test("a plan without at anywhere normalizes exactly as before (no at key added)", () => {
    const plan = normalizeAgentPlan({
      goal: "G",
      constraints: [],
      tasks: [{ id: "task_1", title: "T", body: "b", status: "active" }],
    });

    expect(plan?.tasks[0]).toEqual({ id: "task_1", title: "T", body: "b", status: "active" });
    expect("at" in (plan?.tasks[0] ?? {})).toBe(false);
  });
});
