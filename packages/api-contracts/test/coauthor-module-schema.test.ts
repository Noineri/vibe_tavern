import { describe, test, expect } from "bun:test";
import { coauthorModuleSchema, setCoauthorModuleSchema } from "../src/schemas/coauthor-module.js";

describe("coauthorModuleSchema", () => {
  test("accepts a valid module payload", () => {
    const payload = {
      id: "greeting-writer",
      name: "Greeting Writer",
      description: "Writes greetings",
      basePromptFile: "greeting.md",
      skillIds: ["profile-overview"],
      toolSet: { edit_greeting: true },
      maxSteps: 3,
    };
    expect(coauthorModuleSchema.parse(payload)).toEqual(payload);
  });

  test("rejects missing required fields", () => {
    expect(() => coauthorModuleSchema.parse({})).toThrow();
  });
});

describe("setCoauthorModuleSchema", () => {
  test("accepts a valid module id", () => {
    expect(setCoauthorModuleSchema.parse({ moduleId: "greeting-writer" })).toEqual({ moduleId: "greeting-writer" });
  });

  test("accepts null for unsetting the module", () => {
    expect(setCoauthorModuleSchema.parse({ moduleId: null })).toEqual({ moduleId: null });
  });

  test("rejects empty string", () => {
    expect(() => setCoauthorModuleSchema.parse({ moduleId: "" })).toThrow();
  });
});
