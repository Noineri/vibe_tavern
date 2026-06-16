import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  buildCharacterDraftSchema,
  createCharacterSchema,
  updateCharacterSchema,
} from "../src/schemas/character-schema.js";

/**
 * Characterization tests for the character schemas.
 *
 * These pin the load-bearing constraints of each schema so a silent change
 * (a dropped `.nullable()` / `.optional()`, an enum-member flip, a `.min(1)`
 * removal) is caught here rather than in a broken request on either side of
 * the frontend↔backend contract.
 *
 * Pattern (the reference for the other `packages/api-contracts/test/*.test.ts`
 * files):
 *   - `safeParse` is used everywhere so a failure yields `{ success: false,
 *     error }` instead of throwing — easier to assert.
 *   - Inline factory helpers return a fresh deep-ish copy of a valid baseline;
 *     each `it` mutates one field to isolate the constraint under test.
 *   - The `nullable().optional()` three-state cell (accept `null`, accept
 *     `undefined`, accept a string, reject a number) is asserted explicitly
 *     for every field that uses it — this is the subtle Zod case this package
 *     leans on heavily.
 */

// --- factories --------------------------------------------------------------

function validCreateCharacter(): { name: string } {
  return { name: "Aria" };
}

function validBuildDraft() {
  return {
    name: "Aria",
    description: "A wandering bard.",
    firstMessage: "*Aria strums a chord.*",
    mesExample: "{{user}}: Hi\n{{char}}: Hello",
    mesExampleMode: "always" as const,
    mesExampleDepth: 2,
    scenario: "A tavern at dusk.",
    personalitySummary: "Warm, quick-witted.",
    systemPrompt: "",
    alternateGreetings: [] as string[],
    postHistoryInstructions: "",
    creatorNotes: "",
    depthPrompt: "",
    depthPromptDepth: 4,
    depthPromptRole: "system",
    tags: ["fantasy", "bard"],
  };
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

// --- createCharacterSchema --------------------------------------------------

describe("createCharacterSchema", () => {
  it("accepts a minimal payload with only the required name", () => {
    const result = createCharacterSchema.safeParse(validCreateCharacter());
    expect(result.success).toBe(true);
  });

  it("accepts a full payload with every optional field populated", () => {
    const payload = {
      ...validCreateCharacter(),
      description: "d",
      firstMessage: "fm",
      scenario: "s",
      personalitySummary: "ps",
      mesExample: "me",
      mesExampleMode: "depth",
      mesExampleDepth: 3,
      alternateGreetings: ["g1", "g2"],
      postHistoryInstructions: "phi",
      creatorNotes: "cn",
      systemPrompt: "sp",
      depthPrompt: "dp",
      depthPromptDepth: 1,
      depthPromptRole: "system",
      tags: ["a"],
    };
    const result = createCharacterSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("rejects a payload missing the required name", () => {
    expectReject(createCharacterSchema.safeParse({}));
  });

  it("rejects an empty name (min(1))", () => {
    expectReject(createCharacterSchema.safeParse({ name: "" }));
  });

  it("rejects a non-string name", () => {
    expectReject(createCharacterSchema.safeParse({ name: 123 }));
  });

  it("rejects an unknown mesExampleMode enum member", () => {
    const payload = { ...validCreateCharacter(), mesExampleMode: "bogus" };
    expectReject(createCharacterSchema.safeParse(payload));
  });

  it("accepts every documented mesExampleMode enum member", () => {
    for (const mode of ["always", "once", "depth", "disabled"]) {
      const payload = { ...validCreateCharacter(), mesExampleMode: mode };
      expect(createCharacterSchema.safeParse(payload).success).toBe(true);
    }
  });

  // The three-state cell: personalitySummary is `.nullable().optional()`.
  it("accepts personalitySummary as null, undefined, or a string, rejects a number", () => {
    const base = validCreateCharacter();
    expect(createCharacterSchema.safeParse({ ...base, personalitySummary: null }).success).toBe(true);
    expect(createCharacterSchema.safeParse({ ...base, personalitySummary: undefined }).success).toBe(true);
    expect(createCharacterSchema.safeParse({ ...base, personalitySummary: "warm" }).success).toBe(true);
    expectReject(createCharacterSchema.safeParse({ ...base, personalitySummary: 42 }));
  });

  it("accepts tags as a string array, rejects a string or a non-string element", () => {
    const base = validCreateCharacter();
    expect(createCharacterSchema.safeParse({ ...base, tags: ["a", "b"] }).success).toBe(true);
    expectReject(createCharacterSchema.safeParse({ ...base, tags: "a" }));
    expectReject(createCharacterSchema.safeParse({ ...base, tags: [1, 2] }));
  });
});

// --- updateCharacterSchema --------------------------------------------------

describe("updateCharacterSchema", () => {
  it("accepts an empty patch (every field is optional)", () => {
    const result = updateCharacterSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts a single-field patch", () => {
    expect(updateCharacterSchema.safeParse({ name: "Renamed" }).success).toBe(true);
  });

  // firstMessage: `.nullable().optional()` — the canonical three-state cell.
  it("treats firstMessage as nullable+optional (null/undefined/string ok, number rejected)", () => {
    expect(updateCharacterSchema.safeParse({ firstMessage: null }).success).toBe(true);
    expect(updateCharacterSchema.safeParse({ firstMessage: undefined }).success).toBe(true);
    expect(updateCharacterSchema.safeParse({ firstMessage: "hi" }).success).toBe(true);
    expectReject(updateCharacterSchema.safeParse({ firstMessage: 42 }));
  });

  it("treats personalitySummary, mesExample, creatorNotes, depthPrompt, depthPromptRole, postHistoryInstructions, avatarAssetId/Full/Crop as nullable+optional", () => {
    const nullableFields = [
      "personalitySummary",
      "mesExample",
      "postHistoryInstructions",
      "creatorNotes",
      "depthPrompt",
      "depthPromptDepth",
      "depthPromptRole",
      "avatarAssetId",
      "avatarFullAssetId",
      "avatarCropJson",
    ] as const;
    for (const field of nullableFields) {
      expect(updateCharacterSchema.safeParse({ [field]: null }).success).toBe(true);
      expect(updateCharacterSchema.safeParse({ [field]: undefined }).success).toBe(true);
    }
  });

  it("rejects an unknown mesExampleMode enum member on update", () => {
    expectReject(updateCharacterSchema.safeParse({ mesExampleMode: "never" }));
  });

  // mesExampleDepth is `.number().optional()` — NOT nullable (asymmetry to guard).
  it("treats mesExampleDepth as optional-number but rejects null (not nullable)", () => {
    expect(updateCharacterSchema.safeParse({ mesExampleDepth: 5 }).success).toBe(true);
    expect(updateCharacterSchema.safeParse({ mesExampleDepth: undefined }).success).toBe(true);
    expectReject(updateCharacterSchema.safeParse({ mesExampleDepth: null }));
    expectReject(updateCharacterSchema.safeParse({ mesExampleDepth: "5" }));
  });

  // name is `.string().optional()` — NOT nullable (asymmetry to guard).
  it("treats name as optional-string but rejects null (not nullable)", () => {
    expect(updateCharacterSchema.safeParse({ name: "X" }).success).toBe(true);
    expect(updateCharacterSchema.safeParse({ name: undefined }).success).toBe(true);
    expectReject(updateCharacterSchema.safeParse({ name: null }));
  });
});

// --- buildCharacterDraftSchema ---------------------------------------------

describe("buildCharacterDraftSchema", () => {
  it("accepts a complete draft payload", () => {
    const result = buildCharacterDraftSchema.safeParse(validBuildDraft());
    expect(result.success).toBe(true);
  });

  it("rejects an empty payload (required fields missing)", () => {
    expectReject(buildCharacterDraftSchema.safeParse({}));
  });

  it("rejects a payload missing firstMessage", () => {
    const { firstMessage: _omit, ...rest } = validBuildDraft();
    expectReject(buildCharacterDraftSchema.safeParse(rest));
  });

  // firstMessage here is a plain required `z.string()` — NOT nullable, NOT
  // optional (asymmetry vs updateCharacterSchema). Pin the difference so a
  // "cleanup" never silently weakens the draft contract.
  it("rejects null/undefined/number for firstMessage (required string, not nullable)", () => {
    const base = validBuildDraft();
    expectReject(buildCharacterDraftSchema.safeParse({ ...base, firstMessage: null }));
    expectReject(buildCharacterDraftSchema.safeParse({ ...base, firstMessage: undefined }));
    expectReject(buildCharacterDraftSchema.safeParse({ ...base, firstMessage: 42 }));
  });

  it("requires mesExampleMode to be a known enum member", () => {
    const base = validBuildDraft();
    expect(buildCharacterDraftSchema.safeParse({ ...base, mesExampleMode: "once" }).success).toBe(true);
    expectReject(buildCharacterDraftSchema.safeParse({ ...base, mesExampleMode: "bogus" }));
    expectReject(buildCharacterDraftSchema.safeParse({ ...base, mesExampleMode: undefined }));
  });
});
