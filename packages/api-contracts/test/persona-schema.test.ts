import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  createPersonaSchema,
  setPersonaSchema,
  updatePersonaSchema,
} from "../src/schemas/persona-schema.js";

/**
 * Characterization tests for the persona schemas.
 *
 * These pin the load-bearing constraints of each schema so a silent change
 * (a dropped `.nullable()` / `.optional()`, a `.min(1)` removal, a `.default()`
 * regression) is caught here rather than in a broken request on either side of
 * the frontend↔backend contract.
 *
 * Pattern (mirrors `character-schema.test.ts`):
 *   - `safeParse` is used everywhere so a failure yields `{ success: false,
 *     error }` instead of throwing — easier to assert.
 *   - Inline factory helpers return a fresh copy of a valid baseline; each
 *     `it` mutates one field to isolate the constraint under test.
 *   - The `nullable().optional()` three-state cell (accept `null`, accept
 *     `undefined`, accept a string, reject a number) is asserted explicitly
 *     for every field that uses it — this is the subtle Zod case this package
 *     leans on heavily.
 */

// --- factories --------------------------------------------------------------

function validCreatePersona(): { name: string } {
  return { name: "Me" };
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

// --- createPersonaSchema ----------------------------------------------------

describe("createPersonaSchema", () => {
  it("accepts a minimal payload with only the required name", () => {
    const result = createPersonaSchema.safeParse(validCreatePersona());
    expect(result.success).toBe(true);
  });

  it("accepts a full payload with every optional field populated", () => {
    const payload = {
      ...validCreatePersona(),
      description: "A user persona.",
      pronouns: "they/them",
      defaultForNewChats: true,
    };
    const result = createPersonaSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("rejects a payload missing the required name", () => {
    expectReject(createPersonaSchema.safeParse({}));
  });

  it("rejects an empty name (min(1))", () => {
    expectReject(createPersonaSchema.safeParse({ name: "" }));
  });

  it("rejects a non-string name", () => {
    expectReject(createPersonaSchema.safeParse({ name: 123 }));
  });

  // description is `.optional().default("")` — omitted parses AND the parsed
  // output carries the default `""` (load-bearing: downstream code can assume
  // `description` is always a defined string).
  it("treats description as optional-with-default (omitted parses, applies default \"\")", () => {
    const omitted = createPersonaSchema.safeParse(validCreatePersona());
    expect(omitted.success).toBe(true);
    if (omitted.success) {
      expect(omitted.data.description).toBe("");
    }
    expect(createPersonaSchema.safeParse({ ...validCreatePersona(), description: "custom" }).success).toBe(true);
  });

  // defaultForNewChats is `.boolean().optional()` — NOT nullable, NOT a string.
  it("treats defaultForNewChats as optional-boolean (true/false/omitted ok, string rejected)", () => {
    const base = validCreatePersona();
    expect(createPersonaSchema.safeParse({ ...base, defaultForNewChats: true }).success).toBe(true);
    expect(createPersonaSchema.safeParse({ ...base, defaultForNewChats: false }).success).toBe(true);
    expect(createPersonaSchema.safeParse({ ...base, defaultForNewChats: undefined }).success).toBe(true);
    expectReject(createPersonaSchema.safeParse({ ...base, defaultForNewChats: "yes" }));
    expectReject(createPersonaSchema.safeParse({ ...base, defaultForNewChats: null }));
  });

  // The three-state cell: pronouns is `.nullable().optional()`.
  it("accepts pronouns as null, undefined, or a string, rejects a number", () => {
    const base = validCreatePersona();
    expect(createPersonaSchema.safeParse({ ...base, pronouns: null }).success).toBe(true);
    expect(createPersonaSchema.safeParse({ ...base, pronouns: undefined }).success).toBe(true);
    expect(createPersonaSchema.safeParse({ ...base, pronouns: "they/them" }).success).toBe(true);
    expectReject(createPersonaSchema.safeParse({ ...base, pronouns: 42 }));
  });
});

// --- updatePersonaSchema ----------------------------------------------------

describe("updatePersonaSchema", () => {
  it("accepts an empty patch (every field is optional)", () => {
    const result = updatePersonaSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts a single-field patch", () => {
    expect(updatePersonaSchema.safeParse({ name: "Renamed" }).success).toBe(true);
  });

  // pronouns, avatarAssetId, avatarFullAssetId, avatarCropJson are all
  // `.nullable().optional()` — the canonical three-state cell. Pin each.
  it("treats pronouns, avatarAssetId, avatarFullAssetId, avatarCropJson as nullable+optional", () => {
    const nullableFields = [
      "pronouns",
      "avatarAssetId",
      "avatarFullAssetId",
      "avatarCropJson",
    ] as const;
    for (const field of nullableFields) {
      expect(updatePersonaSchema.safeParse({ [field]: null }).success).toBe(true);
      expect(updatePersonaSchema.safeParse({ [field]: undefined }).success).toBe(true);
      expect(updatePersonaSchema.safeParse({ [field]: "x" }).success).toBe(true);
      expectReject(updatePersonaSchema.safeParse({ [field]: 42 }));
    }
  });

  // description is `.string().optional()` on update (NOT nullable, NOT defaulted
  // — asymmetry vs createPersonaSchema where it has `.default("")`).
  it("treats description as optional-string but rejects null (not nullable, not defaulted on update)", () => {
    expect(updatePersonaSchema.safeParse({ description: "d" }).success).toBe(true);
    expect(updatePersonaSchema.safeParse({ description: undefined }).success).toBe(true);
    expectReject(updatePersonaSchema.safeParse({ description: null }));
    expectReject(updatePersonaSchema.safeParse({ description: 42 }));
  });

  // name is `.string().optional()` — NOT nullable (asymmetry to guard).
  it("treats name as optional-string but rejects null (not nullable)", () => {
    expect(updatePersonaSchema.safeParse({ name: "X" }).success).toBe(true);
    expect(updatePersonaSchema.safeParse({ name: undefined }).success).toBe(true);
    expectReject(updatePersonaSchema.safeParse({ name: null }));
  });

  // chatId is `.string().optional()` — NOT nullable (asymmetry to guard).
  it("treats chatId as optional-string but rejects null (not nullable)", () => {
    expect(updatePersonaSchema.safeParse({ chatId: "c1" }).success).toBe(true);
    expect(updatePersonaSchema.safeParse({ chatId: undefined }).success).toBe(true);
    expectReject(updatePersonaSchema.safeParse({ chatId: null }));
    expectReject(updatePersonaSchema.safeParse({ chatId: 42 }));
  });
});

// --- setPersonaSchema -------------------------------------------------------

describe("setPersonaSchema", () => {
  it("accepts a payload with personaId", () => {
    const result = setPersonaSchema.safeParse({ personaId: "p1" });
    expect(result.success).toBe(true);
  });

  it("rejects a payload missing personaId", () => {
    expectReject(setPersonaSchema.safeParse({}));
  });

  it("rejects a non-string personaId", () => {
    expectReject(setPersonaSchema.safeParse({ personaId: 123 }));
  });

  it("accepts an empty-string personaId (plain z.string(), no min(1))", () => {
    // personaId is a plain z.string() with no min(1) — empty string IS accepted.
    // Pin this explicitly so a future min(1) addition is a deliberate decision.
    expect(setPersonaSchema.safeParse({ personaId: "" }).success).toBe(true);
  });
});
