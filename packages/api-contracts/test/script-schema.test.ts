import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  createScriptSchema,
  importScriptSchema,
  scriptTestResultSchema,
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

  it("accepts an optional unsaved-code override without defaulting it", () => {
    const withOverride = expectData(
      testScriptSchema.safeParse({ code: "context.character.personality = 'draft';" }),
    ) as Record<string, unknown>;
    expect(withOverride.code).toBe("context.character.personality = 'draft';");

    const withoutOverride = expectData(testScriptSchema.safeParse({})) as Record<string, unknown>;
    expect("code" in withoutOverride).toBe(false);
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

// ─── DICE-B3: scriptKind + creationIntentId on create/import ────────────────
//
// Pins the new contract fields so a silent relaxation (a dropped default, a
// widened enum, kind leaking onto the update patch) is caught here. scriptKind
// defaults to "prompt" for legacy creates/imports; creationIntentId is the
// server-idempotent creation key, accepted on create only (NOT mutable content
// on update). Mirrors the create-vs-update defaults asymmetry pinned above.

describe("createScriptSchema scriptKind + creationIntentId (DICE-B3)", () => {
  it("defaults scriptKind to 'prompt' when omitted (legacy create)", () => {
    const data = expectData(
      createScriptSchema.safeParse(validCreateScript()),
    ) as Record<string, unknown>;
    expect(data.scriptKind).toBe("prompt");
  });

  it("accepts scriptKind 'dice'", () => {
    const data = expectData(
      createScriptSchema.safeParse({ ...validCreateScript(), scriptKind: "dice" }),
    ) as Record<string, unknown>;
    expect(data.scriptKind).toBe("dice");
  });

  it("rejects an unknown scriptKind", () => {
    expectReject(
      createScriptSchema.safeParse({ ...validCreateScript(), scriptKind: "fate" }),
    );
  });

  it("accepts an optional creationIntentId", () => {
    const data = expectData(
      createScriptSchema.safeParse({ ...validCreateScript(), creationIntentId: "intent_1" }),
    ) as Record<string, unknown>;
    expect(data.creationIntentId).toBe("intent_1");
  });

  it("rejects an empty creationIntentId (min(1))", () => {
    expectReject(
      createScriptSchema.safeParse({ ...validCreateScript(), creationIntentId: "" }),
    );
  });

  it("omits creationIntentId from the parsed data when not supplied", () => {
    const data = expectData(
      createScriptSchema.safeParse(validCreateScript()),
    ) as Record<string, unknown>;
    expect("creationIntentId" in data).toBe(false);
  });
});

describe("importScriptSchema scriptKind (DICE-B3)", () => {
  it("js branch defaults scriptKind to 'prompt'", () => {
    const data = expectData(
      importScriptSchema.safeParse({ format: "js", code: "x" }),
    ) as Record<string, unknown>;
    expect(data.scriptKind).toBe("prompt");
  });

  it("js branch accepts scriptKind 'dice'", () => {
    const data = expectData(
      importScriptSchema.safeParse({ format: "js", code: "x", scriptKind: "dice" }),
    ) as Record<string, unknown>;
    expect(data.scriptKind).toBe("dice");
  });

  it("json branch defaults scriptKind to 'prompt'", () => {
    const data = expectData(
      importScriptSchema.safeParse({ format: "json", jsonText: "{}" }),
    ) as Record<string, unknown>;
    expect(data.scriptKind).toBe("prompt");
  });

  it("json branch accepts scriptKind 'dice'", () => {
    const data = expectData(
      importScriptSchema.safeParse({ format: "json", jsonText: "{}", scriptKind: "dice" }),
    ) as Record<string, unknown>;
    expect(data.scriptKind).toBe("dice");
  });

  it("rejects an unknown scriptKind on either branch", () => {
    expectReject(importScriptSchema.safeParse({ format: "js", code: "x", scriptKind: "fate" }));
    expectReject(importScriptSchema.safeParse({ format: "json", jsonText: "{}", scriptKind: "fate" }));
  });
});

describe("updateScriptSchema scriptKind is NOT a patch field (DICE-B3)", () => {
  // kind is set at creation and immutable via update — a PATCH must NOT carry
  // or reset scriptKind. Zod objects are non-strict, so an unknown key is
  // stripped (not rejected); this asserts it never reaches the parsed patch
  // data and therefore never overwrites the stored kind.
  it("strips a scriptKind key from an update patch (it is not mutable content)", () => {
    const data = expectData(
      updateScriptSchema.safeParse({ name: "renamed", scriptKind: "dice" }),
    ) as Record<string, unknown>;
    expect("scriptKind" in data).toBe(false);
    expect(Object.keys(data)).toEqual(["name"]);
  });

  it("strips a creationIntentId key from an update patch", () => {
    const data = expectData(
      updateScriptSchema.safeParse({ creationIntentId: "intent_x" }),
    ) as Record<string, unknown>;
    expect("creationIntentId" in data).toBe(false);
  });
});

// ─── IR-11: scriptTestResultSchema discriminated union ───────────────────────
//
// Pins the three-kind test-result contract (prompt | dice | interactive). The
// interactive variant arrives in IR-11 as a contract; the sandbox that PRODUCES
// it arrives in IR-12. This guard catches a typo in any discriminator literal
// or a missing per-kind required field.

describe("scriptTestResultSchema (prompt | dice | interactive)", () => {
  it("accepts a prompt result", () => {
    const result = scriptTestResultSchema.safeParse({
      kind: "prompt",
      personality: "p",
      scenario: "s",
      state: {},
      injectedMessages: [],
      console: [],
      shared: {},
      errors: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a dice result", () => {
    const result = scriptTestResultSchema.safeParse({
      kind: "dice",
      checks: [],
      sampleRolls: [],
      discoveryError: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an interactive result with a discovered definition", () => {
    const result = scriptTestResultSchema.safeParse({
      kind: "interactive",
      definition: {
        apiVersion: 1,
        manifest: { id: "ttt", name: "Tic-Tac-Toe" },
        declaredCapabilities: [],
      },
      discoveryError: null,
    });
    expect(result.success).toBe(true);
  });

  // IR-70F: the wire test-result schema carries a validated setup descriptor
  // automatically through the experienceDefinitionSchema it embeds.
  it("accepts an interactive result whose definition carries a setup descriptor", () => {
    const result = scriptTestResultSchema.safeParse({
      kind: "interactive",
      definition: {
        apiVersion: 1,
        manifest: { id: "ttt", name: "Tic-Tac-Toe" },
        declaredCapabilities: [],
        setup: {
          fields: [
            { kind: "select", id: "strength", label: "Strength", default: "easy",
              options: [{ value: "easy", label: "Easy" }] },
          ],
        },
      },
      discoveryError: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an interactive result whose setup is malformed", () => {
    expectReject(
      scriptTestResultSchema.safeParse({
        kind: "interactive",
        definition: {
          apiVersion: 1,
          manifest: { id: "ttt", name: "Tic-Tac-Toe" },
          declaredCapabilities: [],
          setup: { fields: [{ kind: "text", id: "dup", label: "A" }, { kind: "text", id: "dup", label: "B" }] },
        },
        discoveryError: null,
      }),
    );
  });

  it("accepts an interactive result with a null definition and a discovery error", () => {
    const result = scriptTestResultSchema.safeParse({
      kind: "interactive",
      definition: null,
      discoveryError: "missing required method 'reduce'",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown kind discriminator", () => {
    expectReject(scriptTestResultSchema.safeParse({ kind: "fate" }));
  });

  it("rejects a payload missing the kind discriminator", () => {
    expectReject(scriptTestResultSchema.safeParse({ checks: [] }));
  });
});
