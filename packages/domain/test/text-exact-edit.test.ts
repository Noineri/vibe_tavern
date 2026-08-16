import { describe, expect, test } from "bun:test";
import { applyExactEditsToBody, countOccurrences } from "../src/index.js";

describe("countOccurrences", () => {
  test("empty needle is a no-match (0), never an infinite loop", () => {
    expect(countOccurrences("anything", "")).toBe(0);
  });
  test("no match -> 0", () => {
    expect(countOccurrences("hello world", "xyz")).toBe(0);
  });
  test("counts non-overlapping occurrences", () => {
    expect(countOccurrences("aaa", "a")).toBe(3);
    // non-overlapping: "aa" matches at 0 then at 2 -> 2 in "aaaa"? no: idx 0 -> idx 2 -> idx 4(out) => 2
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    // "aaa" searching "aa": match at 0, advance to 2, no match at 2 (only one 'a' left) -> 1
    expect(countOccurrences("aaa", "aa")).toBe(1);
  });
  test("is case-sensitive", () => {
    expect(countOccurrences("aAaA", "a")).toBe(2);
  });
});

describe("applyExactEditsToBody", () => {
  test("empty edit batch returns the body unchanged", () => {
    const body = "line one\nline two";
    expect(applyExactEditsToBody(body, [], "edit_buffer")).toBe(body);
  });

  test("applies a single unique exact replace", () => {
    expect(applyExactEditsToBody("A test character.", [{ search: "test", replace: "bold" }], "t")).toBe(
      "A bold character.",
    );
  });

  test("applies an ordered batch where later edits see prior mutations (sequential, atomic)", () => {
    // first edit creates the text the second edit then targets
    const out = applyExactEditsToBody(
      "alpha beta",
      [
        { search: "beta", replace: "beta gamma" },
        { search: "gamma", replace: "delta" },
      ],
      "t",
    );
    expect(out).toBe("alpha beta delta");
  });

  test("matching is literal — replacement text with $ / \\ is never reinterpreted", () => {
    expect(applyExactEditsToBody("x", [{ search: "x", replace: "$1\\n" }], "t")).toBe("$1\\n");
  });

  test("rejects an empty search", () => {
    expect(() => applyExactEditsToBody("body", [{ search: "", replace: "y" }], "edit_buffer")).toThrow(
      /must not be empty/,
    );
  });

  test("rejects a no-op (search === replace)", () => {
    expect(() =>
      applyExactEditsToBody("A test character.", [{ search: "A test character.", replace: "A test character." }], "t"),
    ).toThrow(/no-op/);
  });

  test("rejects when search is not found in the current body", () => {
    expect(() => applyExactEditsToBody("hello", [{ search: "nope", replace: "x" }], "edit_buffer")).toThrow(/not found/);
  });

  test("rejects an ambiguous search (2+ matches)", () => {
    expect(() => applyExactEditsToBody("banana", [{ search: "na", replace: "x" }], "t")).toThrow(/ambiguous/i);
  });

  test("folds toolName into the error message", () => {
    try {
      applyExactEditsToBody("hello", [{ search: "nope", replace: "x" }], "edit_visual_buffer");
      throw new Error("should have thrown");
    } catch (e) {
      expect(String(e)).toContain("edit_visual_buffer");
    }
  });

  test("atomicity: a failing later item aborts the batch (no partial return)", () => {
    // first edit would succeed, second fails (not found) -> whole call throws
    expect(() =>
      applyExactEditsToBody(
        "alpha beta",
        [
          { search: "alpha", replace: "ALPHA" },
          { search: "missing", replace: "x" },
        ],
        "t",
      ),
    ).toThrow(/not found/);
  });
});
