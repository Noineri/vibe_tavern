import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  createPromptPresetSchema,
  setPromptPresetSchema,
  updatePromptPresetSchema,
} from "../src/schemas/prompt-preset-schema.js";

/**
 * Characterization tests for the prompt-preset schemas.
 *
 * Pins the load-bearing constraints so a silent change (a dropped `.optional()`,
 * an enum-member flip, a `.partial()` regression, or a `.min(1)` sneak-in) is
 * caught here rather than in a broken request on either side of the
 * frontend↔backend contract.
 *
 * Pattern: `safeParse` everywhere, an `expectReject` helper generic over the
 * parsed type, inline factories, `.js` extensions on relative imports.
 */

// --- factories --------------------------------------------------------------

function validCreatePreset(): { name: string } {
  return { name: "My Preset" };
}

// --- helpers ----------------------------------------------------------------

/**
 * Asserts a `safeParse` result is a rejection and (defensively) that it carries
 * at least one issue. Generic over the parsed type so it works for any schema.
 */
function expectReject(result: z.SafeParseReturnType<unknown, unknown>) {
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.length).toBeGreaterThan(0);
  }
}

// --- createPromptPresetSchema ----------------------------------------------

describe("createPromptPresetSchema", () => {
  it("accepts a minimal payload with only the required name", () => {
    const result = createPromptPresetSchema.safeParse(validCreatePreset());
    expect(result.success).toBe(true);
  });

  it("rejects a payload missing the required name", () => {
    expectReject(createPromptPresetSchema.safeParse({}));
  });

  it("rejects a non-string name", () => {
    expectReject(createPromptPresetSchema.safeParse({ name: 123 }));
  });

  // name is a plain `z.string()` with NO `.min(1)` — unlike the character/persona
  // name (which uses `.min(1)`). Pin this intentional difference so a future
  // "consistency cleanup" that adds `.min(1)` is caught.
  it("accepts an empty name (NO min(1) — intentional difference from character/persona name)", () => {
    const result = createPromptPresetSchema.safeParse({ name: "" });
    expect(result.success).toBe(true);
  });

  it("accepts each authorsNotePosition enum member and rejects an unknown one", () => {
    const base = validCreatePreset();
    for (const pos of ["in_prompt", "in_chat", "after_chat"]) {
      expect(createPromptPresetSchema.safeParse({ ...base, authorsNotePosition: pos }).success).toBe(true);
    }
    expectReject(createPromptPresetSchema.safeParse({ ...base, authorsNotePosition: "before_chat" }));
  });

  it("accepts each authorsNoteRole enum member and rejects an unknown one", () => {
    const base = validCreatePreset();
    for (const role of ["system", "user", "assistant"]) {
      expect(createPromptPresetSchema.safeParse({ ...base, authorsNoteRole: role }).success).toBe(true);
    }
    expectReject(createPromptPresetSchema.safeParse({ ...base, authorsNoteRole: "tool" }));
  });

  // --- promptOrder array-of-objects ----------------------------------------

  it("accepts a minimal promptOrder entry (identifier + enabled only)", () => {
    const result = createPromptPresetSchema.safeParse({
      ...validCreatePreset(),
      promptOrder: [{ identifier: "sys", enabled: true }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a promptOrder entry missing identifier", () => {
    expectReject(createPromptPresetSchema.safeParse({
      ...validCreatePreset(),
      promptOrder: [{ enabled: true }],
    }));
  });

  it("rejects a promptOrder entry missing enabled", () => {
    expectReject(createPromptPresetSchema.safeParse({
      ...validCreatePreset(),
      promptOrder: [{ identifier: "sys" }],
    }));
  });

  it("rejects a non-boolean enabled in a promptOrder entry", () => {
    expectReject(createPromptPresetSchema.safeParse({
      ...validCreatePreset(),
      promptOrder: [{ identifier: "sys", enabled: "yes" }],
    }));
  });

  it("accepts a full promptOrder entry with all optional fields", () => {
    const result = createPromptPresetSchema.safeParse({
      ...validCreatePreset(),
      promptOrder: [{
        identifier: "sys",
        enabled: true,
        order: 1,
        kind: "built_in",
        zone: "before_chat",
        depth: 4,
      }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts each promptOrder kind enum member and rejects an unknown one", () => {
    const base = validCreatePreset();
    for (const kind of ["built_in", "custom"]) {
      expect(createPromptPresetSchema.safeParse({
        ...base,
        promptOrder: [{ identifier: "x", enabled: true, kind }],
      }).success).toBe(true);
    }
    expectReject(createPromptPresetSchema.safeParse({
      ...base,
      promptOrder: [{ identifier: "x", enabled: true, kind: "other" }],
    }));
  });

  it("accepts each promptOrder zone enum member and rejects an unknown one", () => {
    const base = validCreatePreset();
    for (const zone of ["before_chat", "in_chat", "after_chat"]) {
      expect(createPromptPresetSchema.safeParse({
        ...base,
        promptOrder: [{ identifier: "x", enabled: true, zone }],
      }).success).toBe(true);
    }
    expectReject(createPromptPresetSchema.safeParse({
      ...base,
      promptOrder: [{ identifier: "x", enabled: true, zone: "during_chat" }],
    }));
  });

  // depth is `.number().nullable().optional()` — the three-state cell.
  it("treats promptOrder.depth as nullable+optional (null/undefined/number ok, string rejected)", () => {
    const base = validCreatePreset();
    const withDepth = (depth: unknown) => createPromptPresetSchema.safeParse({
      ...base,
      promptOrder: [{ identifier: "x", enabled: true, depth: depth as never }],
    });
    expect(withDepth(null).success).toBe(true);
    expect(withDepth(undefined).success).toBe(true);
    expect(withDepth(5).success).toBe(true);
    expectReject(withDepth("5"));
  });

  it("accepts a non-empty and empty customInjections array (array of unknown)", () => {
    const base = validCreatePreset();
    expect(createPromptPresetSchema.safeParse({ ...base, customInjections: [{ a: 1 }] }).success).toBe(true);
    expect(createPromptPresetSchema.safeParse({ ...base, customInjections: [] }).success).toBe(true);
  });

  it("rejects a non-array customInjections", () => {
    expectReject(createPromptPresetSchema.safeParse({ ...validCreatePreset(), customInjections: "x" }));
  });
});

// --- updatePromptPresetSchema ----------------------------------------------

describe("updatePromptPresetSchema", () => {
  // updatePromptPresetSchema = promptPresetCore.partial() — every field optional.
  it("accepts an empty patch (every field optional via .partial())", () => {
    const result = updatePromptPresetSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts a single-field patch", () => {
    expect(updatePromptPresetSchema.safeParse({ name: "Renamed" }).success).toBe(true);
  });

  it("still validates enum members on update (authorsNotePosition)", () => {
    expect(updatePromptPresetSchema.safeParse({ authorsNotePosition: "in_prompt" }).success).toBe(true);
    expectReject(updatePromptPresetSchema.safeParse({ authorsNotePosition: "bogus" }));
  });

  it("still validates promptOrder entries on update", () => {
    expect(updatePromptPresetSchema.safeParse({
      promptOrder: [{ identifier: "x", enabled: false }],
    }).success).toBe(true);
    expectReject(updatePromptPresetSchema.safeParse({
      promptOrder: [{ identifier: "x" }],
    }));
  });
});

// --- setPromptPresetSchema -------------------------------------------------

describe("setPromptPresetSchema", () => {
  it("accepts a payload with a promptPresetId", () => {
    const result = setPromptPresetSchema.safeParse({ promptPresetId: "p1" });
    expect(result.success).toBe(true);
  });

  it("rejects an empty payload (promptPresetId is required)", () => {
    expectReject(setPromptPresetSchema.safeParse({}));
  });

  it("rejects a non-string promptPresetId", () => {
    expectReject(setPromptPresetSchema.safeParse({ promptPresetId: 42 }));
  });
});
