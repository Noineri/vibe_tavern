import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { debugSendLogSchema, importJsonSchema } from "../src/schemas/debug-schema.js";

/**
 * Characterization tests for the debug schemas.
 *
 * These pin the load-bearing constraints of each schema so a silent change
 * (a tightening of the deliberately-permissive `z.any()` sink, a dropped
 * required field, a `.nullable()` slipped onto a string) is caught here rather
 * than in a broken request on either side of the frontend↔backend contract.
 *
 * See `character-schema.test.ts` for the shared pattern: `safeParse`, the
 * `expectReject` helper (generic over the parsed type), inline factories, and
 * explicit three-state cells where `.nullable().optional()` is in play.
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

// --- debugSendLogSchema -----------------------------------------------------

describe("debugSendLogSchema", () => {
  // This schema is `z.any()` — a deliberately permissive sink. The debug
  // send-log endpoint exists to capture whatever diagnostic payload a client
  // forwards (an error object, a stack trace, an arbitrary nested structure,
  // even a raw string or null). Validating it would defeat the purpose: the
  // server's job is to persist the raw payload verbatim for later inspection,
  // not to reject malformed diagnostics. These tests pin that permissiveness so
  // any future tightening (e.g. an accidental `z.object(...)` refactor) is a
  // conscious, reviewed change with a test failure attached — not a silent
  // regression that starts dropping debug logs.
  it("accepts literally anything (z.any()) — object, empty object, array, primitives, null, undefined", () => {
    expect(debugSendLogSchema.safeParse({ kind: "error", stack: "..." }).success).toBe(true);
    expect(debugSendLogSchema.safeParse({}).success).toBe(true);
    expect(debugSendLogSchema.safeParse([1, 2, 3]).success).toBe(true);
    expect(debugSendLogSchema.safeParse(["a"]).success).toBe(true);
    expect(debugSendLogSchema.safeParse(42).success).toBe(true);
    expect(debugSendLogSchema.safeParse(0).success).toBe(true);
    expect(debugSendLogSchema.safeParse("a raw string").success).toBe(true);
    expect(debugSendLogSchema.safeParse("").success).toBe(true);
    expect(debugSendLogSchema.safeParse(true).success).toBe(true);
    expect(debugSendLogSchema.safeParse(false).success).toBe(true);
    expect(debugSendLogSchema.safeParse(null).success).toBe(true);
    expect(debugSendLogSchema.safeParse(undefined).success).toBe(true);
  });
});

// --- importJsonSchema -------------------------------------------------------

describe("importJsonSchema", () => {
  it("accepts a minimal payload with only the required fileName and jsonText", () => {
    const result = importJsonSchema.safeParse({ fileName: "f.json", jsonText: "{}" });
    expect(result.success).toBe(true);
  });

  it("accepts a full payload with optional chatId and skipExisting populated", () => {
    const result = importJsonSchema.safeParse({
      fileName: "f.json",
      jsonText: "{}",
      chatId: "c1",
      skipExisting: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty payload (fileName + jsonText required)", () => {
    expectReject(importJsonSchema.safeParse({}));
  });

  it("rejects a payload missing jsonText", () => {
    expectReject(importJsonSchema.safeParse({ fileName: "f.json" }));
  });

  it("rejects a payload missing fileName", () => {
    expectReject(importJsonSchema.safeParse({ jsonText: "{}" }));
  });

  it("rejects a non-string fileName", () => {
    expectReject(importJsonSchema.safeParse({ fileName: 123, jsonText: "{}" }));
  });

  // jsonText is a plain required z.string() — NOT nullable. Pin this so a
  // future ".nullable()" slip is caught rather than silently accepting null
  // JSON to import.
  it("rejects null for jsonText (required string, not nullable)", () => {
    expectReject(importJsonSchema.safeParse({ fileName: "f.json", jsonText: null }));
  });

  it("rejects a non-string jsonText", () => {
    expectReject(importJsonSchema.safeParse({ fileName: "f.json", jsonText: 42 }));
  });

  it("rejects a non-string chatId when provided", () => {
    expectReject(importJsonSchema.safeParse({ fileName: "f.json", jsonText: "{}", chatId: 5 }));
  });

  it("treats chatId as optional-string (absent or string ok, null rejected)", () => {
    expect(importJsonSchema.safeParse({ fileName: "f.json", jsonText: "{}", chatId: "c1" }).success).toBe(true);
    // Absent is fine (optional).
    expect(importJsonSchema.safeParse({ fileName: "f.json", jsonText: "{}" }).success).toBe(true);
    // Not nullable — null is rejected.
    expectReject(importJsonSchema.safeParse({ fileName: "f.json", jsonText: "{}", chatId: null }));
  });

  it("rejects a non-boolean skipExisting when provided", () => {
    expectReject(importJsonSchema.safeParse({ fileName: "f.json", jsonText: "{}", skipExisting: "yes" }));
  });

  it("treats skipExisting as optional-boolean (absent, true, or false ok, null rejected)", () => {
    expect(importJsonSchema.safeParse({ fileName: "f.json", jsonText: "{}", skipExisting: true }).success).toBe(true);
    expect(importJsonSchema.safeParse({ fileName: "f.json", jsonText: "{}", skipExisting: false }).success).toBe(true);
    expect(importJsonSchema.safeParse({ fileName: "f.json", jsonText: "{}" }).success).toBe(true);
    expectReject(importJsonSchema.safeParse({ fileName: "f.json", jsonText: "{}", skipExisting: null }));
  });
});
