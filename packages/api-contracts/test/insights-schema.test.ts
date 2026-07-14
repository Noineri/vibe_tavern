import { describe, expect, it } from "bun:test";
import { OBJECTIVE_TASK_STATUS } from "@vibe-tavern/domain";
import {
  addObjectiveTaskSchema,
  reorderObjectiveTasksSchema,
  setObjectiveDescriptionSchema,
  updateObjectiveConfigSchema,
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

  it("validates contextWindow as an optional positive integer without patch defaults", () => {
    expect(updateObjectiveConfigSchema.parse({ contextWindow: 4 })).toEqual({ contextWindow: 4 });
    expect(updateObjectiveConfigSchema.parse({})).toEqual({});
    expect(updateObjectiveConfigSchema.safeParse({ contextWindow: 0 }).success).toBe(false);
    expect(updateObjectiveConfigSchema.safeParse({ contextWindow: 1.5 }).success).toBe(false);
  });

  it("accepts a complete unique task order and rejects empty or duplicate ids", () => {
    expect(reorderObjectiveTasksSchema.parse({ taskIds: ["t2", "t1"] })).toEqual({ taskIds: ["t2", "t1"] });
    expect(reorderObjectiveTasksSchema.safeParse({ taskIds: [] }).success).toBe(false);
    expect(reorderObjectiveTasksSchema.safeParse({ taskIds: ["t1", "t1"] }).success).toBe(false);
  });
});
