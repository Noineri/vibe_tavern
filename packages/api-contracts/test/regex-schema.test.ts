import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { brandId, type RegexProfileId } from "@vibe-tavern/domain";
import {
  createRegexPresetSchema,
  createRegexProfileBundleSchema,
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
 *
 * The `createRegexProfileBundleSchema` block (RXU-12,
 * REGEX_RULE_PROFILE_UX_PORTABILITY) pins the atomic-bundle contract: explicit
 * master state, one-or-more source-faithful rules (no normalization, no
 * rule-level profileId), and the scope rules (global ⇒ no links; links accept
 * only character/preset targets).
 */

// --- factories --------------------------------------------------------------

function validCreateRegexPreset() {
  return { name: "No italics", findRegex: "/\\*\\*(.+?)\\*\\*/g" };
}

function validBundleRule(overrides: Record<string, unknown> = {}) {
  return { name: "strip-think", findRegex: "/<think>[\\s\\S]*?<\\/think>/g", ...overrides };
}

function validBundle(overrides: Record<string, unknown> = {}) {
  return { name: "Imported set", disabled: false, rules: [validBundleRule()], ...overrides };
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

  it("accepts a profileId so a saved rule is born directly inside its profile", () => {
    const data = expectData(
      createRegexPresetSchema.safeParse({ ...validCreateRegexPreset(), profileId: "regex_profile_1" }),
    );
    expect(data.profileId).toBe(brandId<RegexProfileId>("regex_profile_1"));
  });

  it("treats an absent or explicitly null profileId as standalone", () => {
    const absent = expectData(createRegexPresetSchema.safeParse(validCreateRegexPreset()));
    expect(absent.profileId).toBeUndefined();
    const nulled = expectData(
      createRegexPresetSchema.safeParse({ ...validCreateRegexPreset(), profileId: null }),
    );
    expect(nulled.profileId).toBeNull();
  });

  it("rejects an empty profileId string", () => {
    expectReject(createRegexPresetSchema.safeParse({ ...validCreateRegexPreset(), profileId: "" }));
  });
});

// --- createRegexProfileBundleSchema (RXU-12) ---------------------------------

describe("createRegexProfileBundleSchema", () => {
  it("parses a minimal bundle: explicit master state, defaults for scope/order/links", () => {
    const data = expectData(createRegexProfileBundleSchema.safeParse(validBundle()));
    expect(data.name).toBe("Imported set");
    expect(data.disabled).toBe(false); // explicit field, not defaulted
    expect(data.isGlobal).toBe(false);
    expect(data.sortOrder).toBe(0);
    expect(data.links).toEqual([]);
    expect(data.rules).toHaveLength(1);
    // Rule defaults flow from createRegexPresetSchema (source-faithful shape).
    expect(data.rules[0]!.placement).toEqual([2]); // AI_OUTPUT only
    expect(data.rules[0]!.runOnEdit).toBe(true);
    expect(data.rules[0]!.disabled).toBe(false);
  });

  it("requires the master state explicitly (absent disabled is rejected)", () => {
    expectReject(
      createRegexProfileBundleSchema.safeParse({
        name: "Imported set",
        rules: [validBundleRule()],
      }),
    );
  });

  it("accepts one rule and many rules; source disabled states survive", () => {
    expectData(createRegexProfileBundleSchema.safeParse(validBundle()));
    const many = expectData(
      createRegexProfileBundleSchema.safeParse(
        validBundle({
          rules: [
            validBundleRule({ name: "a", disabled: true }),
            validBundleRule({ name: "b" }),
            validBundleRule({ name: "c", disabled: true }),
          ],
        }),
      ),
    );
    expect(many.rules.map((r) => r.name)).toEqual(["a", "b", "c"]);
    // No normalization: each rule carries its own disabled flag.
    expect(many.rules.map((r) => r.disabled)).toEqual([true, false, true]);
  });

  it("rejects an empty rules array", () => {
    expectReject(createRegexProfileBundleSchema.safeParse(validBundle({ rules: [] })));
  });

  it("strips a rule-level profileId (membership is bundle-owned — the store stamps it)", () => {
    const data = expectData(
      createRegexProfileBundleSchema.safeParse(
        validBundle({ rules: [validBundleRule({ profileId: "regex_profile_other" })] }),
      ),
    );
    // Unknown keys are stripped (zod default, same as every schema here) — a
    // smuggled membership can never reach the store; the bundle's own profile
    // id is what lands on insert.
    expect("profileId" in data.rules[0]!).toBe(false);
  });

  it("rejects an empty profile name", () => {
    expectReject(createRegexProfileBundleSchema.safeParse(validBundle({ name: "" })));
  });

  it("accepts a character link on a non-global profile", () => {
    const data = expectData(
      createRegexProfileBundleSchema.safeParse(
        validBundle({ links: [{ targetType: "character", targetId: "char_1" }] }),
      ),
    );
    expect(data.links).toEqual([{ targetType: "character", targetId: "char_1" }]);
  });

  it("accepts a preset link on a non-global profile", () => {
    const data = expectData(
      createRegexProfileBundleSchema.safeParse(
        validBundle({ links: [{ targetType: "preset", targetId: "preset_1" }] }),
      ),
    );
    expect(data.links[0]!.targetType).toBe("preset");
  });

  it("rejects a global profile that carries links", () => {
    expectReject(
      createRegexProfileBundleSchema.safeParse(
        validBundle({
          isGlobal: true,
          links: [{ targetType: "character", targetId: "char_1" }],
        }),
      ),
    );
  });

  it("accepts a global profile with an empty links array", () => {
    const data = expectData(
      createRegexProfileBundleSchema.safeParse(validBundle({ isGlobal: true, links: [] })),
    );
    expect(data.isGlobal).toBe(true);
  });

  it("rejects an invalid link target kind (persona, excluded by design)", () => {
    expectReject(
      createRegexProfileBundleSchema.safeParse(
        validBundle({ links: [{ targetType: "persona", targetId: "p1" }] }),
      ),
    );
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
