/**
 * resolveObjectiveTaskContext (INSIGHTS_PLAN INS-3) — the pure rule that decides
 * whether the Objective Tracker injects an active task into the prompt, and
 * WHICH task. Returns the context field for the pipeline, or null (→ no
 * objective layer emitted at all). No DB, no LLM.
 *
 * Selection rule under test: the first 'active' task, else the first 'pending'
 * (the next thing to do in route order); completed/abandoned are skipped. Depth
 * defaults to 1, injectPrompt to "".
 */
import { describe, it, expect } from "bun:test";
import { resolveObjectiveTaskContext } from "../src/domain/prompt/prompt-assembly-service.js";

function state(overrides: Record<string, unknown> = {}) {
  return { ...overrides };
}

describe("resolveObjectiveTaskContext (INS-3)", () => {
  it("returns null when the objective toggle is off", () => {
    expect(
      resolveObjectiveTaskContext({
        insightsConfig: { objectiveEnabled: false },
        insightsObjectiveState: state({ tasks: [{ id: "t1", description: "Do thing", status: "pending" }] }),
      }),
    ).toBeNull();
  });

  it("returns null when no state has been generated (empty object)", () => {
    expect(
      resolveObjectiveTaskContext({
        insightsConfig: { objectiveEnabled: true },
        insightsObjectiveState: state(),
      }),
    ).toBeNull();
  });

  it("returns null when the task list is empty", () => {
    expect(
      resolveObjectiveTaskContext({
        insightsConfig: { objectiveEnabled: true },
        insightsObjectiveState: state({ tasks: [] }),
      }),
    ).toBeNull();
  });

  it("returns null when every task is completed or abandoned", () => {
    expect(
      resolveObjectiveTaskContext({
        insightsConfig: { objectiveEnabled: true },
        insightsObjectiveState: state({
          tasks: [
            { id: "t1", description: "Done", status: "completed" },
            { id: "t2", description: "Skipped", status: "abandoned" },
          ],
        }),
      }),
    ).toBeNull();
  });

  it("returns the first pending task when none is active (default post-generate state)", () => {
    const result = resolveObjectiveTaskContext({
      insightsConfig: { objectiveEnabled: true },
      insightsObjectiveState: state({
        tasks: [
          { id: "t1", description: "First", status: "completed" },
          { id: "t2", description: "Second", status: "pending" },
          { id: "t3", description: "Third", status: "pending" },
        ],
      }),
    });
    expect(result).toEqual({ description: "Second", injectPrompt: "", injectionDepth: 1 });
  });

  it("prefers an 'active' task over an earlier 'pending' one", () => {
    const result = resolveObjectiveTaskContext({
      insightsConfig: { objectiveEnabled: true },
      insightsObjectiveState: state({
        tasks: [
          { id: "t1", description: "Pending earlier", status: "pending" },
          { id: "t2", description: "Active now", status: "active" },
        ],
      }),
    });
    expect(result?.description).toBe("Active now");
  });

  it("respects injectionDepth and injectPrompt from the state", () => {
    const result = resolveObjectiveTaskContext({
      insightsConfig: { objectiveEnabled: true },
      insightsObjectiveState: state({
        injectionDepth: 3,
        injectPrompt: "Stay on target.",
        tasks: [{ id: "t1", description: "The task", status: "pending" }],
      }),
    });
    expect(result).toEqual({ description: "The task", injectPrompt: "Stay on target.", injectionDepth: 3 });
  });

  it("defaults injectionDepth to 1 and injectPrompt to '' when the state omits them", () => {
    const result = resolveObjectiveTaskContext({
      insightsConfig: { objectiveEnabled: true },
      insightsObjectiveState: state({
        tasks: [{ id: "t1", description: "Plain task", status: "pending" }],
      }),
    });
    expect(result?.injectionDepth).toBe(1);
    expect(result?.injectPrompt).toBe("");
  });
});
