import { describe, expect, test } from "bun:test";

import { applyTargetFlags, regexApplyTargetOf } from "../src/entities.ts";

// Pins the ST ephemerality-flag ↔ apply-target mapping (REGEX_EXTENSION_PLAN
// RX-1): the four flag combinations are exactly the four apply-target modes,
// and both directions of the mapping are inverse to each other.
describe("regex apply-target mapping", () => {
  test("persist = both flags off (default)", () => {
    expect(regexApplyTargetOf({ markdownOnly: false, promptOnly: false })).toBe("persist");
    expect(applyTargetFlags("persist")).toEqual({ markdownOnly: false, promptOnly: false });
  });

  test("markdownOnly = display-only", () => {
    expect(regexApplyTargetOf({ markdownOnly: true, promptOnly: false })).toBe("display");
    expect(applyTargetFlags("display")).toEqual({ markdownOnly: true, promptOnly: false });
  });

  test("promptOnly = prompt-only", () => {
    expect(regexApplyTargetOf({ markdownOnly: false, promptOnly: true })).toBe("prompt");
    expect(applyTargetFlags("prompt")).toEqual({ markdownOnly: false, promptOnly: true });
  });

  test("both flags = display+prompt", () => {
    expect(regexApplyTargetOf({ markdownOnly: true, promptOnly: true })).toBe("display_prompt");
    expect(applyTargetFlags("display_prompt")).toEqual({ markdownOnly: true, promptOnly: true });
  });

  test("round-trips every mode", () => {
    for (const target of ["persist", "display", "prompt", "display_prompt"] as const) {
      expect(applyTargetFlags(regexApplyTargetOf(applyTargetFlags(target)))).toEqual(applyTargetFlags(target));
    }
  });
});
