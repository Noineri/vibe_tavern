import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  autoSummaryConfigSchema,
  chatSummarySourceSchema,
  createChatSummarySchema,
  generateChatSummarySchema,
  saveChatSummarySchema,
  summarizeChatSchema,
  updateChatSummarySchema,
  updateMemorySettingsSchema,
} from "../src/schemas/summarize-schema.js";

/**
 * Characterization tests for the summarize/memory schemas.
 *
 * Pins the load-bearing constraints so a silent change — a dropped `.default()`,
 * a `.min()` boundary flip, or a create-vs-update asymmetry erosion — is caught
 * here rather than in a broken request on either side of the contract.
 *
 * Follows the reference pattern in `character-schema.test.ts`:
 *   - `safeParse` everywhere (reject → `{ success: false, error }`).
 *   - `expectReject` helper generic over any schema.
 *   - Inline factories returning a fresh valid baseline per test.
 *   - Special attention to two asymmetries this file leans on:
 *       (1) create-vs-update: `createChatSummarySchema` injects `.default()`
 *           values; `updateChatSummarySchema` is a pure patch (no defaults).
 *       (2) `summarizedTo` is `min(0)` in `createChatSummarySchema` but
 *           `min(1)` in `generateChatSummarySchema` — the boundary differs by
 *           endpoint and must not silently converge.
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

// --- chatSummarySourceSchema ------------------------------------------------

describe("chatSummarySourceSchema", () => {
  // It's a bare enum (NOT an object schema) — accepts the literal, not an object.
  it("accepts the 'manual' and 'auto' enum members", () => {
    expect(chatSummarySourceSchema.safeParse("manual").success).toBe(true);
    expect(chatSummarySourceSchema.safeParse("auto").success).toBe(true);
  });

  it("rejects an unknown enum member", () => {
    expectReject(chatSummarySourceSchema.safeParse("other"));
  });

  // No `.default()` on a bare enum — undefined is not coerced.
  it("rejects undefined (required — no default on the bare enum)", () => {
    expectReject(chatSummarySourceSchema.safeParse(undefined));
  });
});

// --- autoSummaryConfigSchema ------------------------------------------------

describe("autoSummaryConfigSchema", () => {
  it("applies the enabled default(false) when omitted", () => {
    const result = autoSummaryConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
    }
  });

  it("accepts enabled explicitly set to true", () => {
    const result = autoSummaryConfigSchema.safeParse({ enabled: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
    }
  });

  it("rejects a non-boolean enabled", () => {
    expectReject(autoSummaryConfigSchema.safeParse({ enabled: "yes" }));
  });

  // everyN: int, min(1), max(500), default(20).
  it("applies the everyN default(20) when omitted", () => {
    const result = autoSummaryConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.everyN).toBe(20);
    }
  });

  it("accepts everyN at the boundaries (1 and 500)", () => {
    expect(autoSummaryConfigSchema.safeParse({ everyN: 1 }).success).toBe(true);
    expect(autoSummaryConfigSchema.safeParse({ everyN: 500 }).success).toBe(true);
  });

  it("rejects everyN below min (0)", () => {
    expectReject(autoSummaryConfigSchema.safeParse({ everyN: 0 }));
  });

  it("rejects everyN above max (501)", () => {
    expectReject(autoSummaryConfigSchema.safeParse({ everyN: 501 }));
  });

  it("rejects a non-integer everyN (1.5)", () => {
    expectReject(autoSummaryConfigSchema.safeParse({ everyN: 1.5 }));
  });

  it("rejects a string everyN ('20') — no coercion", () => {
    expectReject(autoSummaryConfigSchema.safeParse({ everyN: "20" }));
  });
});

// --- createChatSummarySchema ------------------------------------------------

describe("createChatSummarySchema", () => {
  it("accepts a minimal payload with only the required range fields", () => {
    const result = createChatSummarySchema.safeParse({ summarizedFrom: 1, summarizedTo: 0 });
    expect(result.success).toBe(true);
  });

  // The From/To asymmetry: From requires >=1, To allows >=0.
  it("rejects summarizedFrom below 1 (asymmetry: From min(1))", () => {
    expectReject(createChatSummarySchema.safeParse({ summarizedFrom: 0, summarizedTo: 0 }));
  });

  it("rejects summarizedTo below 0 (To min(0))", () => {
    expectReject(createChatSummarySchema.safeParse({ summarizedFrom: 1, summarizedTo: -1 }));
  });

  it("rejects a payload missing summarizedFrom", () => {
    expectReject(createChatSummarySchema.safeParse({ summarizedTo: 0 }));
  });

  it("rejects a payload missing summarizedTo", () => {
    expectReject(createChatSummarySchema.safeParse({ summarizedFrom: 1 }));
  });

  // label/content/source have defaults — a minimal payload fills them in.
  it("applies the label('') and source('manual') defaults when omitted", () => {
    const result = createChatSummarySchema.safeParse({ summarizedFrom: 1, summarizedTo: 0 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.label).toBe("");
      expect(result.data.source).toBe("manual");
    }
  });

  it("applies the content('') default when omitted", () => {
    const result = createChatSummarySchema.safeParse({ summarizedFrom: 1, summarizedTo: 0 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.content).toBe("");
    }
  });

  // includeInContext/excludeSummarized default(true).
  it("applies the includeInContext/excludeSummarized defaults(true) when omitted", () => {
    const result = createChatSummarySchema.safeParse({ summarizedFrom: 1, summarizedTo: 0 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.includeInContext).toBe(true);
      expect(result.data.excludeSummarized).toBe(true);
    }
  });

  it("accepts source 'auto'", () => {
    const result = createChatSummarySchema.safeParse({
      summarizedFrom: 1,
      summarizedTo: 0,
      source: "auto",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown source value", () => {
    expectReject(
      createChatSummarySchema.safeParse({
        summarizedFrom: 1,
        summarizedTo: 0,
        source: "bogus",
      }),
    );
  });
});

// --- updateChatSummarySchema ------------------------------------------------

describe("updateChatSummarySchema", () => {
  // Everything optional, NO defaults — a pure PATCH. This is the create-vs-
  // update asymmetry: create injects defaults; update must NOT.
  it("accepts an empty patch (every field optional)", () => {
    const result = updateChatSummarySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts a single-field patch", () => {
    expect(updateChatSummarySchema.safeParse({ label: "x" }).success).toBe(true);
  });

  it("parses an empty patch to an empty data object (no defaults injected)", () => {
    const result = updateChatSummarySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data).length).toBe(0);
    }
  });

  it("accepts the From/To range on update", () => {
    expect(
      updateChatSummarySchema.safeParse({ summarizedFrom: 5, summarizedTo: 3 }).success,
    ).toBe(true);
  });

  // Range constraints still apply on update (optional but still validated).
  it("rejects summarizedFrom below 1 even on update", () => {
    expectReject(updateChatSummarySchema.safeParse({ summarizedFrom: 0 }));
  });

  it("rejects summarizedTo below 0 even on update", () => {
    expectReject(updateChatSummarySchema.safeParse({ summarizedTo: -1 }));
  });
});

// --- generateChatSummarySchema ----------------------------------------------

describe("generateChatSummarySchema", () => {
  function validGenerate() {
    return {
      providerProfileId: "prov-1",
      summarizedFrom: 1,
      summarizedTo: 1,
    };
  }

  it("accepts a minimal valid payload", () => {
    const result = generateChatSummarySchema.safeParse(validGenerate());
    expect(result.success).toBe(true);
  });

  it("rejects an empty payload (missing required providerProfileId/range)", () => {
    expectReject(generateChatSummarySchema.safeParse({}));
  });

  it("rejects an empty providerProfileId (min(1))", () => {
    expectReject(generateChatSummarySchema.safeParse({ ...validGenerate(), providerProfileId: "" }));
  });

  // Asymmetry vs createChatSummarySchema: summarizedTo is min(1) here, not min(0).
  it("rejects summarizedTo 0 (min(1) here — asymmetry vs create where To is min(0))", () => {
    expectReject(generateChatSummarySchema.safeParse({ ...validGenerate(), summarizedTo: 0 }));
  });

  it("rejects summarizedFrom below 1", () => {
    expectReject(generateChatSummarySchema.safeParse({ ...validGenerate(), summarizedFrom: 0 }));
  });

  // includeInContext/excludeSummarized default(true).
  it("applies the includeInContext/excludeSummarized defaults(true) when omitted", () => {
    const result = generateChatSummarySchema.safeParse(validGenerate());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.includeInContext).toBe(true);
      expect(result.data.excludeSummarized).toBe(true);
    }
  });
});

// --- updateMemorySettingsSchema ---------------------------------------------

describe("updateMemorySettingsSchema", () => {
  it("accepts an empty payload (everything optional)", () => {
    expect(updateMemorySettingsSchema.safeParse({}).success).toBe(true);
  });

  // messageHistoryLimit: int, min(0), optional — 0 is a valid "keep none".
  it("accepts messageHistoryLimit 0 (min(0))", () => {
    expect(updateMemorySettingsSchema.safeParse({ messageHistoryLimit: 0 }).success).toBe(true);
  });

  it("accepts messageHistoryLimit omitted", () => {
    expect(updateMemorySettingsSchema.safeParse({}).success).toBe(true);
  });

  it("rejects messageHistoryLimit below 0 (-1)", () => {
    expectReject(updateMemorySettingsSchema.safeParse({ messageHistoryLimit: -1 }));
  });

  // autoSummaryConfig is a partial() of the config schema — any subset is valid.
  it("accepts autoSummaryConfig with a single field", () => {
    expect(
      updateMemorySettingsSchema.safeParse({ autoSummaryConfig: { enabled: true } }).success,
    ).toBe(true);
  });

  it("accepts autoSummaryConfig as an empty object (partial)", () => {
    expect(updateMemorySettingsSchema.safeParse({ autoSummaryConfig: {} }).success).toBe(true);
  });
});

// --- summarizeChatSchema (legacy) -------------------------------------------

describe("summarizeChatSchema (legacy)", () => {
  function validLegacy() {
    return {
      providerProfileId: "prov-1",
      maxMessages: 10,
    };
  }

  it("accepts a minimal valid payload", () => {
    expect(summarizeChatSchema.safeParse(validLegacy()).success).toBe(true);
  });

  it("rejects an empty payload (missing required fields)", () => {
    expectReject(summarizeChatSchema.safeParse({}));
  });

  it("rejects an empty providerProfileId (min(1))", () => {
    expectReject(summarizeChatSchema.safeParse({ ...validLegacy(), providerProfileId: "" }));
  });

  it("rejects maxMessages below 1 (min(1))", () => {
    expectReject(summarizeChatSchema.safeParse({ ...validLegacy(), maxMessages: 0 }));
  });
});

// --- saveChatSummarySchema --------------------------------------------------

describe("saveChatSummarySchema", () => {
  it("accepts a payload with a summary string", () => {
    expect(saveChatSummarySchema.safeParse({ summary: "s" }).success).toBe(true);
  });

  it("rejects an empty payload (summary is required)", () => {
    expectReject(saveChatSummarySchema.safeParse({}));
  });

  it("rejects a non-string summary", () => {
    expectReject(saveChatSummarySchema.safeParse({ summary: 42 }));
  });
});
