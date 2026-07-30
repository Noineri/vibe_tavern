import { describe, expect, it } from "bun:test";
import { OBJECTIVE_MODE, OBJECTIVE_TASK_STATUS } from "@vibe-tavern/domain";
import {
  addObjectiveShortTermGoalSchema,
  addObjectiveTaskSchema,
  insightsCompletionRefreshSchema,
  insightsConfigSchema,
  reorderObjectiveTasksSchema,
  selectObjectiveShortTermGoalSchema,
  setObjectiveDescriptionSchema,
  setObjectiveModeSchema,
  updateInsightsConfigSchema,
  updateObjectiveConfigSchema,
  updateObjectiveLongTermGoalSchema,
  updateObjectiveShortTermGoalSchema,
  updateObjectiveTaskSchema,
} from "../src/schemas/insights-schema.js";

describe("Objective request schemas", () => {
  it("accepts each derived Objective task status", () => {
    for (const status of Object.values(OBJECTIVE_TASK_STATUS)) {
      expect(updateObjectiveTaskSchema.parse({ status })).toEqual({ status });
    }
  });

  it("rejects unknown Objective task statuses", () => {
    expect(updateObjectiveTaskSchema.safeParse({ status: "done" }).success).toBe(false);
    expect(updateObjectiveTaskSchema.safeParse({ status: "" }).success).toBe(false);
  });

  it("trims and rejects empty task descriptions", () => {
    expect(addObjectiveTaskSchema.parse({ description: "  Enter the gate  " })).toEqual({ description: "Enter the gate" });
    expect(updateObjectiveTaskSchema.parse({ description: "  Rename  " })).toEqual({ description: "Rename" });
    expect(addObjectiveTaskSchema.safeParse({ description: "   " }).success).toBe(false);
    expect(updateObjectiveTaskSchema.safeParse({ description: "   " }).success).toBe(false);
  });

  it("trims and rejects an empty objective description", () => {
    expect(setObjectiveDescriptionSchema.parse({ objectiveDescription: "  Escape  " })).toEqual({ objectiveDescription: "Escape" });
    expect(setObjectiveDescriptionSchema.safeParse({ objectiveDescription: "   " }).success).toBe(false);
  });

  it("validates goals-mode requests and rejects empty patches", () => {
    expect(setObjectiveModeSchema.parse({ mode: OBJECTIVE_MODE.goals })).toEqual({ mode: OBJECTIVE_MODE.goals });
    expect(setObjectiveModeSchema.safeParse({ mode: "quest" }).success).toBe(false);
    expect(updateObjectiveLongTermGoalSchema.parse({ description: "  Free the city  " })).toEqual({ description: "Free the city" });
    expect(updateObjectiveLongTermGoalSchema.parse({ status: OBJECTIVE_TASK_STATUS.completed })).toEqual({ status: OBJECTIVE_TASK_STATUS.completed });
    expect(updateObjectiveLongTermGoalSchema.safeParse({}).success).toBe(false);
    expect(addObjectiveShortTermGoalSchema.parse({ description: "  Reach the gate  " })).toEqual({ description: "Reach the gate" });
    expect(updateObjectiveShortTermGoalSchema.parse({ status: OBJECTIVE_TASK_STATUS.active })).toEqual({ status: OBJECTIVE_TASK_STATUS.active });
    expect(updateObjectiveShortTermGoalSchema.safeParse({}).success).toBe(false);
    expect(selectObjectiveShortTermGoalSchema.parse({ goalId: " goal_1 " })).toEqual({ goalId: "goal_1" });
    expect(selectObjectiveShortTermGoalSchema.safeParse({ goalId: "   " }).success).toBe(false);
  });

  it("validates contextWindow as an optional positive integer without patch defaults", () => {
    expect(updateObjectiveConfigSchema.parse({ contextWindow: 4 })).toEqual({ contextWindow: 4 });
    expect(updateObjectiveConfigSchema.parse({})).toEqual({});
    expect(updateObjectiveConfigSchema.safeParse({ contextWindow: 0 }).success).toBe(false);
    expect(updateObjectiveConfigSchema.safeParse({ contextWindow: 1.5 }).success).toBe(false);
  });

  it("accepts a scoped completion-refresh target and rejects blank identities", () => {
    expect(insightsCompletionRefreshSchema.parse({
      target: { branchId: " branch_1 ", messageId: " msg_1 " },
    })).toEqual({ target: { branchId: "branch_1", messageId: "msg_1" } });
    expect(insightsCompletionRefreshSchema.safeParse({
      target: { branchId: "", messageId: "msg_1" },
    }).success).toBe(false);
    expect(insightsCompletionRefreshSchema.safeParse({
      target: { branchId: "branch_1", messageId: "   " },
    }).success).toBe(false);
  });

  it("accepts a complete unique task order and rejects empty or duplicate ids", () => {
    expect(reorderObjectiveTasksSchema.parse({ taskIds: ["t2", "t1"] })).toEqual({ taskIds: ["t2", "t1"] });
    expect(reorderObjectiveTasksSchema.safeParse({ taskIds: [] }).success).toBe(false);
    expect(reorderObjectiveTasksSchema.safeParse({ taskIds: ["t1", "t1"] }).success).toBe(false);
  });
});

describe("Dice config (B9)", () => {
  it("old JSON without dice fields normalizes to diceEnabled=false, diceMode='normal'", () => {
    const old = { objectiveEnabled: true, trackerEnabled: false };
    const parsed = insightsConfigSchema.parse(old);
    expect(parsed.diceEnabled).toBe(false);
    expect(parsed.diceMode).toBe("normal");
    // Preserves existing fields.
    expect(parsed.objectiveEnabled).toBe(true);
    expect(parsed.trackerEnabled).toBe(false);
  });

  it("accepts explicit diceEnabled and diceMode values", () => {
    const parsed = insightsConfigSchema.parse({
      diceEnabled: true,
      diceMode: "immersive",
    });
    expect(parsed.diceEnabled).toBe(true);
    expect(parsed.diceMode).toBe("immersive");
  });

  it("rejects invalid diceMode values", () => {
    expect(insightsConfigSchema.safeParse({ diceMode: "hardcore" }).success).toBe(false);
    expect(insightsConfigSchema.safeParse({ diceMode: "" }).success).toBe(false);
  });

  it("partial PATCH preserves ALL unrelated Objective/Scene/Dice fields", () => {
    // A PATCH that only touches diceEnabled must not reset objective/tracker/diceMode.
    const parsed = updateInsightsConfigSchema.parse({
      insightsConfig: { diceEnabled: true },
    });
    expect(parsed.insightsConfig?.diceEnabled).toBe(true);
    // diceMode and other fields are absent (not reset to default).
    expect(parsed.insightsConfig?.diceMode).toBeUndefined();
    expect(parsed.insightsConfig?.objectiveEnabled).toBeUndefined();
    expect(parsed.insightsConfig?.trackerEnabled).toBeUndefined();
  });

  it("PATCH diceMode alone preserves diceEnabled and other fields", () => {
    const parsed = updateInsightsConfigSchema.parse({
      insightsConfig: { diceMode: "immersive" },
    });
    expect(parsed.insightsConfig?.diceMode).toBe("immersive");
    expect(parsed.insightsConfig?.diceEnabled).toBeUndefined();
    expect(parsed.insightsConfig?.objectiveEnabled).toBeUndefined();
  });

  it("empty PATCH preserves everything", () => {
    const parsed = updateInsightsConfigSchema.parse({});
    expect(parsed.insightsConfig).toBeUndefined();
  });

  it("round-trip: write dice config then read it back", () => {
    // Simulate what the adapter does: parse stored config, merge dice fields.
    const stored = { objectiveEnabled: true, trackerEnabled: false, diceEnabled: false, diceMode: "normal" as const };
    const normalized = insightsConfigSchema.parse(stored);
    expect(normalized.diceEnabled).toBe(false);
    expect(normalized.diceMode).toBe("normal");

    // Apply a partial patch (toggle dice on).
    const patch = updateInsightsConfigSchema.parse({ insightsConfig: { diceEnabled: true } });
    const merged = { ...normalized, ...(patch.insightsConfig ?? {}) };
    expect(merged.diceEnabled).toBe(true);
    // diceMode preserved from stored.
    expect(merged.diceMode).toBe("normal");
    // Objective/Scene preserved.
    expect(merged.objectiveEnabled).toBe(true);
    expect(merged.trackerEnabled).toBe(false);
  });
});
