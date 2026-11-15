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

  it("accepts a complete unique task order and rejects empty array, blank ids, or duplicate ids", () => {
    expect(reorderObjectiveTasksSchema.parse({ taskIds: ["t2", "t1"] })).toEqual({ taskIds: ["t2", "t1"] });
    expect(reorderObjectiveTasksSchema.safeParse({ taskIds: [] }).success).toBe(false);
    expect(reorderObjectiveTasksSchema.safeParse({ taskIds: ["t1", ""] }).success).toBe(false);
    expect(reorderObjectiveTasksSchema.safeParse({ taskIds: ["t1", "   "] }).success).toBe(false);
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

  it("partial PATCH carries only sent diceEnabled without injecting defaults for unrelated Objective/Scene/Dice fields", () => {
    // A PATCH schema wrapper keeps unmentioned fields absent rather than
    // injecting defaults; the adapter/store merge preserves stored values.
    const parsed = updateInsightsConfigSchema.parse({
      insightsConfig: { diceEnabled: true },
    });
    expect(parsed).toEqual({ insightsConfig: { diceEnabled: true } });
    expect(Object.keys(parsed.insightsConfig ?? {})).toEqual(["diceEnabled"]);
  });

  it("PATCH diceMode alone leaves diceEnabled and other unrelated fields omitted", () => {
    const parsed = updateInsightsConfigSchema.parse({
      insightsConfig: { diceMode: "immersive" },
    });
    expect(parsed).toEqual({ insightsConfig: { diceMode: "immersive" } });
    expect(Object.keys(parsed.insightsConfig ?? {})).toEqual(["diceMode"]);
  });

  it("empty PATCH parses to an empty object without injecting insightsConfig", () => {
    const parsed = updateInsightsConfigSchema.parse({});
    expect(parsed).toEqual({});
    expect("insightsConfig" in parsed).toBe(false);
  });

  it("schema-and-spread example: normalized stored config merged with partial PATCH retains omitted fields", () => {
    // Contract-layer example of combining parsed stored config with a parsed partial PATCH.
    const stored = { objectiveEnabled: true, trackerEnabled: false, diceEnabled: false, diceMode: "normal" as const };
    const normalized = insightsConfigSchema.parse(stored);
    expect(normalized).toEqual({
      objectiveEnabled: true,
      trackerEnabled: false,
      diceEnabled: false,
      diceMode: "normal",
      diceScriptIds: null,
      diceActorBindings: null,
    });

    // Apply a partial patch (toggle dice on).
    const patch = updateInsightsConfigSchema.parse({ insightsConfig: { diceEnabled: true } });
    expect(patch).toEqual({ insightsConfig: { diceEnabled: true } });
    const merged = insightsConfigSchema.parse({ ...normalized, ...(patch.insightsConfig ?? {}) });
    expect(merged.diceEnabled).toBe(true);
    expect(merged.diceMode).toBe("normal");
    expect(merged.objectiveEnabled).toBe(true);
    expect(merged.trackerEnabled).toBe(false);
  });
});
