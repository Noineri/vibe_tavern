import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  createScriptSchema,
  importScriptSchema,
  testScriptSchema,
  updateScriptSchema,
} from "../src/schemas/script-schema.js";

/**
 * Characterization tests for the script schemas.
 *
 * Pins the load-bearing constraints so a silent change (a dropped
 * `.optional()`, a removed default, a discriminator typo in the
 * discriminatedUnion) is caught here rather than as a broken request on
 * either side of the frontend↔backend contract.
 *
 * Pattern mirrors `character-schema.test.ts`:
 *   - `safeParse` everywhere (failure → `{ success: false, error }`).
 *   - Inline factories return a fresh valid baseline; each `it` mutates one
 *     field to isolate the constraint under test.
 *   - The create-vs-update defaults asymmetry (create injects defaults; update
 *     is a pure patch) and the `discriminatedUnion("format", …)` contract are
 *     the subtle cases to pin here.
 */

// --- factories --------------------------------------------------------------

function validCreateScript(): { name: string; scopeType: string } {
  return { name: "Greeter", scopeType: "character" };
}

// --- helpers ----------------------------------------------------------------

/**
 * Asserts a `safeParse` result is a rejection and (defensively) that it
 * carries at least one issue. Generic over the parsed type so it works for
 * any schema, including the discriminatedUnion.
 */
function expectReject(result: z.SafeParseReturnType<unknown, unknown>) {
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.length).toBeGreaterThan(0);
  }
}

/** Narrows a successful parse to its `.data` (throws clearly if it failed). */
function expectData(result: z.SafeParseReturnType<unknown, unknown>): unknown {
  expect(result.success).toBe(true);
  if (!result.success) throw new Error("expected success but parse failed");
  return result.data;
}

// --- createScriptSchema ----------------------------------------------------

describe("createScriptSchema", () => {
  it("accepts a minimal payload (only required name + scopeType)", () => {
    const result = createScriptSchema.safeParse(validCreateScript());
    expect(result.success).toBe(true);
  });

  it("injects defaults for omitted optional fields (description, code, enabled, sortOrder)", () => {
    const data = expectData(
      createScriptSchema.safeParse(validCreateScript()),
    ) as Record<string, unknown>;
    expect(data.description).toBe("");
    expect(data.code).toBe("");
    expect(data.enabled).toBe(true);
    expect(data.sortOrder).toBe(0);
  });

  it("accepts a full payload overriding every default", () => {
    const payload = {
      ...validCreateScript(),
      description: "d",
      code: "console.log(1)",
      characterId: "c1",
      personaId: "p1",
      chatId: "ch1",
      enabled: false,
      sortOrder: 7,
    };
    expect(createScriptSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects an empty payload (missing required name + scopeType)", () => {
    expectReject(createScriptSchema.safeParse({}));
  });

  it("rejects an empty name (min(1))", () => {
    expectReject(createScriptSchema.safeParse({ name: "", scopeType: "character" }));
  });

  it("rejects a payload missing the required scopeType", () => {
    // name present, scopeType absent → rejected.
    expectReject(createScriptSchema.safeParse({ name: "Greeter" }));
  });

  it("rejects a non-string name / scopeType", () => {
    expectReject(createScriptSchema.safeParse({ name: 1, scopeType: "character" }));
    expectReject(createScriptSchema.safeParse({ name: "s", scopeType: 2 }));
  });

  it("accepts omitted characterId/personaId/chatId (all optional)", () => {
    expect(createScriptSchema.safeParse(validCreateScript()).success).toBe(true);
  });
});

// --- updateScriptSchema ----------------------------------------------------

describe("updateScriptSchema", () => {
  // KEY asymmetry vs createScriptSchema: update has NO defaults — it is a pure
  // patch. An empty payload parses to an empty object, not an object filled
  // with defaults. A bug here (accidentally re-adding `.default(...)`) would
  // silently overwrite server values on PATCH.
  it("accepts an empty patch and produces EMPTY data (no defaults injected)", () => {
    const result = updateScriptSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Object.keys(result.data).length).toBe(0);
  });

  it("accepts a single-field patch", () => {
    const result = updateScriptSchema.safeParse({ name: "x" });
    expect(result.success).toBe(true);
  });

  it("does not inject enabled/sortOrder defaults when omitted on update", () => {
    const result = updateScriptSchema.safeParse({ code: "new code" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Only the provided field should be present — no `enabled: true` / `sortOrder: 0`.
    expect(Object.keys(result.data)).toEqual(["code"]);
  });

  it("rejects a non-string name / non-boolean enabled / non-number sortOrder", () => {
    expectReject(updateScriptSchema.safeParse({ name: 1 }));
    expectReject(updateScriptSchema.safeParse({ enabled: "yes" }));
    expectReject(updateScriptSchema.safeParse({ sortOrder: "0" }));
  });
});

// --- testScriptSchema ------------------------------------------------------

describe("testScriptSchema", () => {
  it("accepts an empty payload and injects all defaults", () => {
    const data = expectData(testScriptSchema.safeParse({})) as Record<string, unknown>;
    expect(Array.isArray(data.messages)).toBe(true);
    expect((data.messages as unknown[]).length).toBe(0);
    expect(data.characterName).toBe("Assistant");
    expect(data.characterPersonality).toBe("");
    expect(data.characterScenario).toBe("");
    expect(data.lastMessage).toBe("");
  });

  it("accepts a populated messages array", () => {
    const result = testScriptSchema.safeParse({
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a message missing the required content", () => {
    expectReject(
      testScriptSchema.safeParse({ messages: [{ role: "user" }] }),
    );
  });

  it("rejects a message with a non-string role", () => {
    expectReject(
      testScriptSchema.safeParse({ messages: [{ role: 1, content: "x" }] }),
    );
  });

  it("rejects a non-object array element (messages is an object array)", () => {
    expectReject(testScriptSchema.safeParse({ messages: ["nope"] }));
  });
});

// --- importScriptSchema (discriminatedUnion) ------------------------------

describe("importScriptSchema", () => {
  // The discriminator is `format`. The union has two branches: "js" and "json".
  // Pin both branch contracts AND the discriminator error behavior — a typo
  // in the discriminator literal or a missing required per-branch field is the
  // failure mode this guard exists for.

  // ── "js" branch ────────────────────────────────────────────────────────
  it("accepts a valid js payload and applies the scopeType default", () => {
    const result = importScriptSchema.safeParse({
      format: "js",
      code: "console.log(1)",
    });
    const data = expectData(result) as Record<string, unknown>;
    expect(data.format).toBe("js");
    expect(data.code).toBe("console.log(1)");
    // default scopeType = "character" when omitted.
    expect(data.scopeType).toBe("character");
  });

  it("accepts a js payload overriding scopeType", () => {
    const result = importScriptSchema.safeParse({
      format: "js",
      code: "x",
      scopeType: "chat",
    });
    const data = expectData(result) as Record<string, unknown>;
    expect(data.scopeType).toBe("chat");
  });

  it("rejects a js payload missing the required code", () => {
    expectReject(importScriptSchema.safeParse({ format: "js" }));
  });

  it("rejects a js payload with empty code (min(1))", () => {
    expectReject(importScriptSchema.safeParse({ format: "js", code: "" }));
  });

  it("accepts an optional name on the js branch", () => {
    const result = importScriptSchema.safeParse({
      format: "js",
      code: "x",
      name: "Imported",
    });
    expect(result.success).toBe(true);
  });

  // ── "json" branch ──────────────────────────────────────────────────────
  it("accepts a valid json payload and applies the scopeType default", () => {
    const result = importScriptSchema.safeParse({
      format: "json",
      jsonText: "{}",
    });
    const data = expectData(result) as Record<string, unknown>;
    expect(data.format).toBe("json");
    expect(data.jsonText).toBe("{}");
    expect(data.scopeType).toBe("character");
  });

  it("rejects a json payload missing the required jsonText", () => {
    expectReject(importScriptSchema.safeParse({ format: "json" }));
  });

  it("rejects a json payload with empty jsonText (min(1))", () => {
    expectReject(importScriptSchema.safeParse({ format: "json", jsonText: "" }));
  });

  // ── discriminator error behavior ───────────────────────────────────────
  it("rejects an unknown format value (invalid discriminator)", () => {
    expectReject(importScriptSchema.safeParse({ format: "yaml", code: "x" }));
  });

  it("rejects a payload missing the format discriminator", () => {
    expectReject(importScriptSchema.safeParse({ code: "x" }));
  });

  it("rejects a non-string format discriminator", () => {
    expectReject(importScriptSchema.safeParse({ format: 123 }));
  });

  // ── cross-branch field handling ────────────────────────────────────────
  // Zod objects are non-strict by default (unknown keys are stripped, not
  // rejected). So supplying a `jsonText` on the js branch does NOT satisfy the
  // js branch's required `code` — the jsonText is simply dropped, and the
  // missing required `code` causes a rejection. This pins that cross-branch
  // fields are NOT mistaken for the other branch's required field.
  it("rejects a js payload that only supplies the json branch's jsonText (code still missing)", () => {
    const result = importScriptSchema.safeParse({ format: "js", jsonText: "{}" });
    expectReject(result);
    // Confirms: jsonText is stripped (non-strict), and the js branch still
    // requires `code`, so the payload is rejected — it is NOT silently parsed
    // as a js script with missing code.
  });
});
