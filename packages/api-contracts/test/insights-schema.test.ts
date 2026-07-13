import { describe, expect, it } from "bun:test";
import { OBJECTIVE_TASK_STATUS } from "@vibe-tavern/domain";
import {
  addObjectiveTaskSchema,
  setObjectiveDescriptionSchema,
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
});
