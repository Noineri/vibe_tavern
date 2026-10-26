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
