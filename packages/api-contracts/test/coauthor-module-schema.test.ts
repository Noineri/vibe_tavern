import { describe, test, expect } from "bun:test";
import {
  coauthorModuleSchema,
  setCoauthorModuleSchema,
  coauthorModuleCreateSchema,
  coauthorModuleUpdateSchema,
} from "../src/schemas/coauthor-module.js";

describe("coauthorModuleSchema", () => {
  test("accepts a valid resolved module payload (with inline basePrompt + openingMessage + isBuiltIn)", () => {
    const payload = {
      id: "greeting-writer",
      name: "Greeting Writer",
      description: "Writes greetings",
      basePrompt: "You are a greeting writer. ...",
      openingMessage: "I'll help you write greetings for {{char}}.",
      skillIds: ["profile-overview"],
      toolSet: { edit_greeting: true },
      maxSteps: 3,
      isBuiltIn: false,
    };
    expect(coauthorModuleSchema.parse(payload)).toEqual(payload);
  });

  test("rejects missing required fields", () => {
    expect(() => coauthorModuleSchema.parse({})).toThrow();
  });

  test("rejects empty basePrompt (inline text is required, not a file reference)", () => {
    expect(() =>
      coauthorModuleSchema.parse({
        id: "x",
        name: "X",
        description: "",
        basePrompt: "",
        openingMessage: "",
        skillIds: [],
        toolSet: {},
        maxSteps: 3,
        isBuiltIn: false,
      }),
    ).toThrow();
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

describe("coauthorModuleCreateSchema", () => {
  test("accepts a create payload without id/isBuiltIn (assigned server-side)", () => {
    const payload = {
      name: "My Module",
      description: "custom",
      basePrompt: "You are...",
      openingMessage: "Hi!",
      skillIds: ["general-writing"],
      toolSet: { edit_profile: true },
      maxSteps: 5,
    };
    expect(coauthorModuleCreateSchema.parse(payload)).toEqual(payload);
  });

  test("strips an injected id (create input must not set its own id)", () => {
    const parsed = coauthorModuleCreateSchema.parse({
      name: "X",
      description: "",
      basePrompt: "p",
      openingMessage: "",
      skillIds: [],
      toolSet: {},
      maxSteps: 3,
      id: "attacker-id",
      isBuiltIn: true,
    });
    expect(parsed).not.toHaveProperty("id");
    expect(parsed).not.toHaveProperty("isBuiltIn");
  });
});

describe("coauthorModuleUpdateSchema", () => {
  test("accepts a partial update (single field)", () => {
    expect(coauthorModuleUpdateSchema.parse({ maxSteps: 7 })).toEqual({ maxSteps: 7 });
  });

  test("accepts an empty object (no-op update)", () => {
    expect(coauthorModuleUpdateSchema.parse({})).toEqual({});
  });
});
