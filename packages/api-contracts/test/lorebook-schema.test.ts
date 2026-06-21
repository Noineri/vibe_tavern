import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  createLoreEntrySchema,
  createLorebookSchema,
  duplicateLorebookSchema,
  importLorebookSchema,
  lorebookLinkSchema,
  reorderLoreEntriesSchema,
  setLorebookLinksSchema,
  testActivationSchema,
  updateLoreEntrySchema,
  updateLorebookMetaSchema,
} from "../src/schemas/lorebook-schema.js";

/**
 * Characterization tests for the lorebook schemas.
 *
 * These pin the load-bearing constraints so a silent change (a dropped
 * `.nullable()` / `.optional()`, a removed `.default(...)`, an enum flip) is
 * caught here rather than in a broken request on either side of the contract.
 *
 * The most important invariants in this module:
 *   - The **create-vs-update defaults asymmetry**: create schemas inject
 *     defaults for every field (so `{}` parses and fills them), while update
 *     schemas are pure patches (so `{}` parses to `{}` with NO injected keys).
 *     A "cleanup" that adds/removes a `.default()` on either side silently
 *     changes what the store writes.
 *   - `scanDepthOverride` is the canonical `nullable().optional()` three-state
 *     cell and exists on both create (with a null default) and update.
 *   - `importLorebookSchema.data` is `z.unknown()` — it accepts literally
 *     anything (the parser validates it downstream), which is load-bearing for
 *     the import path.
 */

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

/** Type guard narrowing a safeParse result to its success branch (for asserting `.data`). */
function expectSuccessData<T>(result: z.SafeParseReturnType<T, unknown>): T {
  expect(result.success).toBe(true);
  if (!result.success) throw new Error("expected success");
  return result.data as T;
}

// --- factories --------------------------------------------------------------

function validCreateLorebook() {
  return { name: "World Lore", scopeType: "character" };
}

// --- testActivationSchema ---------------------------------------------------

describe("testActivationSchema", () => {
  it("accepts { text: string }", () => {
    expect(testActivationSchema.safeParse({ text: "abc" }).success).toBe(true);
  });

  it("rejects an empty object (missing required text)", () => {
    expectReject(testActivationSchema.safeParse({}));
  });

  it("rejects a non-string text", () => {
    expectReject(testActivationSchema.safeParse({ text: 123 }));
  });
});

// --- createLorebookSchema ---------------------------------------------------

describe("createLorebookSchema", () => {
  it("accepts a minimal payload with only name + scopeType", () => {
    expect(createLorebookSchema.safeParse(validCreateLorebook()).success).toBe(true);
  });

  it("rejects a payload missing the required name", () => {
    expectReject(createLorebookSchema.safeParse({ scopeType: "character" }));
  });

  it("rejects an empty name (min(1))", () => {
    expectReject(createLorebookSchema.safeParse({ name: "", scopeType: "character" }));
  });

  it("rejects a payload missing the required scopeType", () => {
    expectReject(createLorebookSchema.safeParse({ name: "L" }));
  });

  it("accepts characterId/personaId/chatId when provided and when omitted (optional)", () => {
    const base = validCreateLorebook();
    expect(createLorebookSchema.safeParse({ ...base, characterId: "c1" }).success).toBe(true);
    expect(createLorebookSchema.safeParse({ ...base, personaId: "p1", chatId: "ch1" }).success).toBe(true);
    // Omitted is fine (covered by the minimal-payload test above).
  });

  // Defaults actually materialize on the parsed output — pin them.
  it("injects defaults for scanDepth (10) and enabled (true) when omitted", () => {
    const data = expectSuccessData(createLorebookSchema.safeParse(validCreateLorebook())) as Record<string, unknown>;
    expect(data.scanDepth).toBe(10);
    expect(data.enabled).toBe(true);
    expect(data.tokenBudget).toBe(2048);
    expect(data.recursiveScanning).toBe(false);
  });

  it("accepts a full payload overriding the defaults", () => {
    const payload = {
      ...validCreateLorebook(),
      description: "d",
      scanDepth: 10,
      tokenBudget: 500,
      recursiveScanning: true,
      maxRecursionSteps: 9,
      includeNames: true,
      minActivations: 2,
      minActivationsDepthMax: 3,
      overflowAlert: true,
      characterStrategy: 1,
      enabled: false,
    };
    const data = expectSuccessData(createLorebookSchema.safeParse(payload)) as Record<string, unknown>;
    expect(data.scanDepth).toBe(10);
    expect(data.enabled).toBe(false);
  });

  it("rejects a non-number scanDepth and a non-boolean enabled", () => {
    const base = validCreateLorebook();
    expectReject(createLorebookSchema.safeParse({ ...base, scanDepth: "50" }));
    expectReject(createLorebookSchema.safeParse({ ...base, enabled: "yes" }));
  });
});

// --- updateLorebookMetaSchema -----------------------------------------------

describe("updateLorebookMetaSchema", () => {
  // KEY INVARIANT: update is a pure patch — NO defaults are injected. Contrast
  // with createLorebookSchema, which DOES set `enabled` etc. If a "cleanup"
  // copies the create schema and forgets to strip the defaults, every PATCH
  // would silently overwrite unmentioned fields with defaults — a data-loss bug.
  it("accepts an empty patch and injects NO defaults (patch-only)", () => {
    const result = updateLorebookMetaSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(Object.keys(data).length).toBe(0);
      expect("enabled" in data).toBe(false);
      expect("scanDepth" in data).toBe(false);
    }
  });

  it("accepts a single-field patch", () => {
    expect(updateLorebookMetaSchema.safeParse({ name: "Renamed" }).success).toBe(true);
  });

  it("accepts a multi-field patch without injecting unmentioned keys", () => {
    const result = updateLorebookMetaSchema.safeParse({ name: "X", enabled: false, scanDepth: 7 });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.name).toBe("X");
      expect(data.enabled).toBe(false);
      expect(data.scanDepth).toBe(7);
      // Only the three provided keys, nothing else.
      expect(Object.keys(data).sort()).toEqual(["enabled", "name", "scanDepth"]);
    }
  });

  it("rejects wrong-typed values (scanDepth non-number, enabled non-boolean)", () => {
    expectReject(updateLorebookMetaSchema.safeParse({ scanDepth: "50" }));
    expectReject(updateLorebookMetaSchema.safeParse({ enabled: "true" }));
  });
});

// --- createLoreEntrySchema / updateLoreEntrySchema --------------------------

describe("createLoreEntrySchema", () => {
  // Create injects a full set of defaults — `{}` is a valid entry.
  it("accepts an empty object and fills defaults (depth === 4)", () => {
    const result = createLoreEntrySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.depth).toBe(4);
      expect(data.priority).toBe(10);
      expect(data.logic).toBe("and_any");
      expect(data.position).toBe("before_char");
      expect(data.enabled).toBe(true);
      expect(data.constant).toBe(false);
    }
  });

  it("accepts a populated entry", () => {
    expect(
      createLoreEntrySchema.safeParse({ title: "T", content: "C", keys: ["k1"] }).success,
    ).toBe(true);
  });

  // The canonical three-state cell: scanDepthOverride is
  // `.number().nullable().optional().default(null)` — null is the default,
  // undefined and a number are accepted, a string is rejected.
  it("treats scanDepthOverride as nullable+optional (null/undefined/number ok, string rejected)", () => {
    expect(createLoreEntrySchema.safeParse({ scanDepthOverride: null }).success).toBe(true);
    expect(createLoreEntrySchema.safeParse({ scanDepthOverride: undefined }).success).toBe(true);
    expect(createLoreEntrySchema.safeParse({ scanDepthOverride: 8 }).success).toBe(true);
    expectReject(createLoreEntrySchema.safeParse({ scanDepthOverride: "8" }));
  });

  it("defaults scanDepthOverride to null when omitted", () => {
    const result = createLoreEntrySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).scanDepthOverride).toBeNull();
    }
  });
});

describe("updateLoreEntrySchema", () => {
  // KEY INVARIANT: update is a pure patch — NO defaults. `{}` parses to `{}`,
  // NOT a fully-populated entry. This is the create-vs-update asymmetry for
  // entries: a bug here would make every entry PATCH overwrite every field.
  it("accepts an empty object and injects NO defaults (empty patch)", () => {
    const result = updateLoreEntrySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(Object.keys(data).length).toBe(0);
    }
  });

  it("accepts a single-field patch and does not inject other fields", () => {
    const result = updateLoreEntrySchema.safeParse({ depth: 12 });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.depth).toBe(12);
      expect(Object.keys(data)).toEqual(["depth"]);
    }
  });

  // The same three-state cell, but WITHOUT the null default — on update,
  // `undefined` simply means "leave unchanged".
  it("treats scanDepthOverride as nullable+optional (null/undefined/number ok, string rejected)", () => {
    expect(updateLoreEntrySchema.safeParse({ scanDepthOverride: null }).success).toBe(true);
    expect(updateLoreEntrySchema.safeParse({ scanDepthOverride: undefined }).success).toBe(true);
    expect(updateLoreEntrySchema.safeParse({ scanDepthOverride: 8 }).success).toBe(true);
    expectReject(updateLoreEntrySchema.safeParse({ scanDepthOverride: "8" }));
  });
});

// --- reorderLoreEntriesSchema -----------------------------------------------

describe("reorderLoreEntriesSchema", () => {
  it("accepts a valid updates array", () => {
    expect(
      reorderLoreEntriesSchema.safeParse({ updates: [{ id: "1", sortOrder: 0 }] }).success,
    ).toBe(true);
  });

  it("accepts updates with optional position", () => {
    expect(
      reorderLoreEntriesSchema.safeParse({
        updates: [
          { id: "a", sortOrder: 0, position: "before_char" },
          { id: "b", sortOrder: 1 },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects an empty object (missing required updates)", () => {
    expectReject(reorderLoreEntriesSchema.safeParse({}));
  });

  it("rejects an empty updates array? (no — empty array is structurally valid)", () => {
    // An empty array is a valid (if no-op) reorder — pin that it parses, so a
    // future `.min(1)` addition is a deliberate change, not a silent one.
    expect(reorderLoreEntriesSchema.safeParse({ updates: [] }).success).toBe(true);
  });

  it("rejects an update object missing the required id", () => {
    expectReject(
      reorderLoreEntriesSchema.safeParse({ updates: [{ sortOrder: 0 }] }),
    );
  });

  it("rejects an update object missing the required sortOrder", () => {
    expectReject(
      reorderLoreEntriesSchema.safeParse({ updates: [{ id: "1" }] }),
    );
  });

  it("rejects a non-string id and a non-number sortOrder", () => {
    expectReject(
      reorderLoreEntriesSchema.safeParse({ updates: [{ id: 1, sortOrder: 0 }] }),
    );
    expectReject(
      reorderLoreEntriesSchema.safeParse({ updates: [{ id: "1", sortOrder: "0" }] }),
    );
  });
});

// --- importLorebookSchema ---------------------------------------------------

describe("importLorebookSchema", () => {
  it("accepts { data: <anything> } and injects defaults (format=st, mode=new)", () => {
    const result = importLorebookSchema.safeParse({ data: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.format).toBe("st");
      expect(data.mode).toBe("new");
      expect(data.scopeType).toBe("character");
    }
  });

  // data is z.unknown() — load-bearing: the parser validates it downstream, so
  // the contract must accept literally anything here.
  it("accepts data of any type (object, number, null, string, array)", () => {
    for (const dataValue of [{}, 123, null, "text", []]) {
      expect(importLorebookSchema.safeParse({ data: dataValue }).success).toBe(true);
    }
  });

  it("rejects an unknown format enum member", () => {
    expectReject(importLorebookSchema.safeParse({ format: "bogus", data: {} }));
  });

  it("accepts every documented format enum member", () => {
    for (const format of ["st", "janitor"]) {
      expect(importLorebookSchema.safeParse({ format, data: {} }).success).toBe(true);
    }
  });

  it("rejects an unknown mode enum member", () => {
    expectReject(importLorebookSchema.safeParse({ mode: "bogus", data: {} }));
  });

  it("accepts every documented mode enum member", () => {
    for (const mode of ["merge", "replace", "new"]) {
      expect(importLorebookSchema.safeParse({ mode, data: {} }).success).toBe(true);
    }
  });

  // PIN: `data` is `z.unknown()`, which in Zod is permissive — it accepts
  // `undefined`, so a payload that OMITS `data` still parses (data resolves to
  // undefined). This is load-bearing: if a future change makes `data` required
  // (e.g. `z.unknown().refine(v => v !== undefined)`), it breaks the import
  // path. Pin the current permissive behavior explicitly.
  it("accepts a payload that omits data (z.unknown() accepts undefined)", () => {
    const result = importLorebookSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect("data" in data).toBe(false);
      // format/mode still get their defaults even without data present.
      expect(data.format).toBe("st");
      expect(data.mode).toBe("new");
    }
  });

  it("accepts optional linking fields (characterId/personaId/chatId/fallbackName)", () => {
    expect(
      importLorebookSchema.safeParse({
        data: {},
        characterId: "c1",
        fallbackName: "Imported",
      }).success,
    ).toBe(true);
  });
});

// --- lorebookLinkSchema -----------------------------------------------------

describe("lorebookLinkSchema", () => {
  it("accepts a valid link", () => {
    expect(lorebookLinkSchema.safeParse({ targetType: "character", targetId: "t1" }).success).toBe(true);
  });

  it("accepts every documented targetType enum member", () => {
    for (const targetType of ["character", "persona"]) {
      expect(lorebookLinkSchema.safeParse({ targetType, targetId: "t" }).success).toBe(true);
    }
  });

  it("rejects an unknown targetType enum member", () => {
    expectReject(lorebookLinkSchema.safeParse({ targetType: "chat", targetId: "t" }));
  });

  it("rejects an empty targetId (min(1))", () => {
    expectReject(lorebookLinkSchema.safeParse({ targetType: "character", targetId: "" }));
  });

  it("rejects a payload missing required fields", () => {
    expectReject(lorebookLinkSchema.safeParse({ targetType: "character" }));
    expectReject(lorebookLinkSchema.safeParse({ targetId: "t" }));
    expectReject(lorebookLinkSchema.safeParse({}));
  });
});

// --- setLorebookLinksSchema -------------------------------------------------

describe("setLorebookLinksSchema", () => {
  it("accepts an empty links array", () => {
    expect(setLorebookLinksSchema.safeParse({ links: [] }).success).toBe(true);
  });

  it("accepts a populated links array", () => {
    expect(
      setLorebookLinksSchema.safeParse({
        links: [
          { targetType: "character", targetId: "c1" },
          { targetType: "persona", targetId: "p1" },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects a payload missing the required links field", () => {
    expectReject(setLorebookLinksSchema.safeParse({}));
  });

  // A bad link INSIDE the array must surface as a rejection — this guards that
  // nested validation actually runs (not just the outer shape).
  it("rejects a link with a bad targetType inside the array", () => {
    expectReject(
      setLorebookLinksSchema.safeParse({
        links: [{ targetType: "bogus", targetId: "t" }],
      }),
    );
  });

  it("rejects a link with an empty targetId inside the array", () => {
    expectReject(
      setLorebookLinksSchema.safeParse({
        links: [{ targetType: "character", targetId: "" }],
      }),
    );
  });
});

// --- duplicateLorebookSchema ------------------------------------------------

describe("duplicateLorebookSchema", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(duplicateLorebookSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a fully-populated payload", () => {
    expect(
      duplicateLorebookSchema.safeParse({
        name: "Copy",
        scopeType: "character",
        characterId: "c1",
        personaId: "p1",
      }).success,
    ).toBe(true);
  });

  // The canonical three-state cell: characterId/personaId are
  // `.string().nullable().optional()`.
  it("treats characterId and personaId as nullable+optional (null/undefined/string ok, number rejected)", () => {
    expect(duplicateLorebookSchema.safeParse({ characterId: null }).success).toBe(true);
    expect(duplicateLorebookSchema.safeParse({ characterId: undefined }).success).toBe(true);
    expect(duplicateLorebookSchema.safeParse({ characterId: "c1" }).success).toBe(true);
    expectReject(duplicateLorebookSchema.safeParse({ characterId: 42 }));

    expect(duplicateLorebookSchema.safeParse({ personaId: null }).success).toBe(true);
    expect(duplicateLorebookSchema.safeParse({ personaId: undefined }).success).toBe(true);
    expect(duplicateLorebookSchema.safeParse({ personaId: "p1" }).success).toBe(true);
    expectReject(duplicateLorebookSchema.safeParse({ personaId: 42 }));
  });
});
