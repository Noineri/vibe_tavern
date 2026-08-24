import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  createRegexPresetSchema,
  updateRegexPresetSchema,
  setRegexLinksSchema,
} from "../src/schemas/regex-schema.js";

/**
 * Characterization tests for the regex schemas (REGEX_EXTENSION_PLAN, RX-6).
 *
 * Pins the load-bearing constraints: create-side defaults (placement [2],
 * substituteRegex 0), min(1) on name/findRegex, the applyTarget write-mode
 * selector, and rejection of invalid ST placement codes / persona link
 * targets. Pattern mirrors `script-schema.test.ts`: safeParse everywhere,
 * inline factory returns a fresh valid baseline.
 */

// --- factories --------------------------------------------------------------

function validCreateRegexPreset() {
  return { name: "No italics", findRegex: "/\\*\\*(.+?)\\*\\*/g" };
}

// --- helpers ----------------------------------------------------------------

function expectReject(result: z.ZodSafeParseResult<unknown>) {
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.length).toBeGreaterThan(0);
  }
}

function expectData<T>(result: z.ZodSafeParseResult<T>): T {
  expect(result.success).toBe(true);
  if (!result.success) throw new Error("expected success but parse failed");
  return result.data;
}

// --- createRegexPresetSchema -------------------------------------------------

describe("createRegexPresetSchema", () => {
  it("injects ST-parity defaults for a minimal payload", () => {
    const data = expectData(createRegexPresetSchema.safeParse(validCreateRegexPreset()));
    expect(data.placement).toEqual([2]); // AI_OUTPUT only
    expect(data.substituteRegex).toBe(0); // NONE
    expect(data.trimStrings).toEqual([]);
    expect(data.runOnEdit).toBe(true);
    expect(data.disabled).toBe(false);
    expect(data.markdownOnly).toBe(false);
    expect(data.promptOnly).toBe(false);
    expect(data.isGlobal).toBe(false);
  });

  it("accepts explicit depth bounds and all placement codes", () => {
    const data = expectData(
      createRegexPresetSchema.safeParse({
        ...validCreateRegexPreset(),
        minDepth: null,
        maxDepth: 3,
        placement: [1, 2, 5, 6],
      }),
    );
    expect(data.minDepth).toBeNull();
    expect(data.maxDepth).toBe(3);
    expect(data.placement).toEqual([1, 2, 5, 6]);
  });

  it("rejects an empty name and an empty findRegex", () => {
    expectReject(createRegexPresetSchema.safeParse({ name: "", findRegex: "/a/g" }));
    expectReject(createRegexPresetSchema.safeParse({ name: "x", findRegex: "" }));
  });

  it("rejects placement code 4 (not a valid ST code)", () => {
    expectReject(createRegexPresetSchema.safeParse({ ...validCreateRegexPreset(), placement: [4] }));
  });
});

// --- updateRegexPresetSchema -----------------------------------------------

describe("updateRegexPresetSchema", () => {
  it("is a pure patch — empty object parses with no fields", () => {
    const data = expectData(updateRegexPresetSchema.safeParse({}));
    expect(Object.keys(data)).toEqual([]);
  });

  it("rejects empty name when provided", () => {
    expectReject(updateRegexPresetSchema.safeParse({ name: "" }));
  });

  it("accepts the applyTarget write-mode selector", () => {
    const data = expectData(updateRegexPresetSchema.safeParse({ applyTarget: "display_prompt" }));
    expect(data.applyTarget).toBe("display_prompt");
  });

  it("rejects an unknown applyTarget value", () => {
    expectReject(updateRegexPresetSchema.safeParse({ applyTarget: "overwrite_everything" }));
  });

  it("rejects non-integer depth bounds", () => {
    expectReject(updateRegexPresetSchema.safeParse({ maxDepth: 1.5 }));
  });
});

// --- setRegexLinksSchema ------------------------------------------------------

describe("setRegexLinksSchema", () => {
  it("accepts character + preset targets", () => {
    const data = expectData(
      setRegexLinksSchema.safeParse({
        links: [
          { targetType: "character", targetId: "char-1" },
          { targetType: "preset", targetId: "preset-1" },
        ],
      }),
    );
    expect(data.links).toHaveLength(2);
  });

  it("rejects persona as a link target (excluded by design)", () => {
    expectReject(
      setRegexLinksSchema.safeParse({ links: [{ targetType: "persona", targetId: "p1" }] }),
    );
  });

  it("rejects empty target ids", () => {
    expectReject(setRegexLinksSchema.safeParse({ links: [{ targetType: "character", targetId: "" }] }));
  });
});
