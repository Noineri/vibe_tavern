import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  scriptSafetySettingsSchema,
  updateScriptSafetySettingsSchema,
} from "../src/schemas/script-safety-settings-schema.js";

/**
 * Characterization tests for the script-safety settings contract
 * (SCRIPT_SAFETY_PLAN SS-3).
 *
 * Pins the GET response shape (`{ suppressImportWarnings, updatedAt }`) and
 * the PUT body shape (`{ suppressImportWarnings }`) so a silent drift (a
 * dropped `updatedAt`, a widened boolean, `updatedAt` leaking onto the PUT
 * body) is caught here rather than as a broken request on either side of the
 * frontend↔backend contract.
 *
 * Pattern mirrors `script-schema.test.ts`: `safeParse` everywhere, local
 * `expectReject`/`expectData` helpers, one constraint mutated per `it`.
 */

// --- helpers ----------------------------------------------------------------

function expectReject(result: z.ZodSafeParseResult<unknown>) {
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.length).toBeGreaterThan(0);
  }
}

function expectData(result: z.ZodSafeParseResult<unknown>): unknown {
  expect(result.success).toBe(true);
  if (!result.success) throw new Error("expected success but parse failed");
  return result.data;
}

// --- scriptSafetySettingsSchema (GET response) ------------------------------

describe("scriptSafetySettingsSchema (GET response)", () => {
  it("accepts the no-row default (suppress=false, empty updatedAt)", () => {
    const result = scriptSafetySettingsSchema.safeParse({
      suppressImportWarnings: false,
      updatedAt: "",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a persisted row with a timestamp", () => {
    const result = scriptSafetySettingsSchema.safeParse({
      suppressImportWarnings: true,
      updatedAt: "2026-10-06T12:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing suppressImportWarnings", () => {
    expectReject(scriptSafetySettingsSchema.safeParse({ updatedAt: "" }));
  });

  it("rejects a non-boolean suppressImportWarnings", () => {
    expectReject(
      scriptSafetySettingsSchema.safeParse({ suppressImportWarnings: "yes", updatedAt: "" }),
    );
  });

  it("rejects a missing updatedAt (it is part of the wire shape)", () => {
    expectReject(scriptSafetySettingsSchema.safeParse({ suppressImportWarnings: false }));
  });
});

// --- updateScriptSafetySettingsSchema (PUT body) ----------------------------

describe("updateScriptSafetySettingsSchema (PUT body)", () => {
  it("accepts suppressImportWarnings true", () => {
    expect(updateScriptSafetySettingsSchema.safeParse({ suppressImportWarnings: true }).success).toBe(true);
  });

  it("accepts suppressImportWarnings false", () => {
    expect(updateScriptSafetySettingsSchema.safeParse({ suppressImportWarnings: false }).success).toBe(true);
  });

  it("rejects a missing suppressImportWarnings", () => {
    expectReject(updateScriptSafetySettingsSchema.safeParse({}));
  });

  it("rejects a non-boolean suppressImportWarnings", () => {
    expectReject(updateScriptSafetySettingsSchema.safeParse({ suppressImportWarnings: 1 }));
    expectReject(updateScriptSafetySettingsSchema.safeParse({ suppressImportWarnings: "true" }));
  });

  // `updatedAt` is server-managed: it is absent from the PUT body. Zod objects
  // are non-strict by default, so a client-sent `updatedAt` is stripped rather
  // than rejected — mirrors how `updateScriptSchema` strips `scriptKind` /
  // `creationIntentId` (server-managed fields never reach the parsed patch).
  it("strips a client-sent updatedAt from the PUT body", () => {
    const data = expectData(
      updateScriptSafetySettingsSchema.safeParse({ suppressImportWarnings: true, updatedAt: "1970-01-01T00:00:00.000Z" }),
    ) as Record<string, unknown>;
    expect("updatedAt" in data).toBe(false);
    expect(Object.keys(data)).toEqual(["suppressImportWarnings"]);
  });
});
