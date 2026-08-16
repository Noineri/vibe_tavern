import { describe, expect, it } from "bun:test";
import { parseOptionalJsonDiagnosed } from "./json-parse-diagnostic.js";

/**
 * UX 2026-08-16 remark 5 — detailed JSON diagnostics for the tester /
 * playground optional-JSON fields. Pins:
 *   - blank input stays "absent" (unchanged contract);
 *   - valid JSON parses with present:true;
 *   - failure carries the ENGINE reason plus, when the structural scanner
 *     recognizes the anomaly, a line-located fragment.
 */
describe("parseOptionalJsonDiagnosed", () => {
  it("blank input is absent", () => {
    expect(parseOptionalJsonDiagnosed("")).toEqual({ ok: true, present: false });
    expect(parseOptionalJsonDiagnosed("   \n  ")).toEqual({ ok: true, present: false });
  });

  it("valid JSON parses and is present", () => {
    expect(parseOptionalJsonDiagnosed('{"a": 1}')).toEqual({ ok: true, present: true, value: { a: 1 } });
    expect(parseOptionalJsonDiagnosed("[1, 2]")).toEqual({ ok: true, present: true, value: [1, 2] });
  });

  it("failure carries the engine reason (never an empty diagnostic)", () => {
    const r = parseOptionalJsonDiagnosed("nul");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostic.length).toBeGreaterThan(0);
  });

  it("trailing comma is located by line", () => {
    const r = parseOptionalJsonDiagnosed('{\n  "a": 1,\n  "b": 2,\n}');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // The offending ',' sits at the end of line 3 (before the line-4 close).
      expect(r.diagnostic).toContain("trailing ',' at line 3");
    }
  });

  it("unclosed brace reports the opening line", () => {
    const r = parseOptionalJsonDiagnosed('{\n  "a": 1,\n  "b": {\n    "c": 2\n}');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // The inner '{' IS closed by the line-5 '}'; the unclosed one is the
      // outermost '{' at line 1 — the scanner reports the outermost opener.
      expect(r.diagnostic).toContain("unclosed '{' opened at line 1");
    }
  });

  it("single quotes are called out with the line", () => {
    const r = parseOptionalJsonDiagnosed('{\n  "a": \'b\'\n}');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostic).toContain("' at line 2 — JSON strings use double quotes");
    }
  });

  it("unterminated string reports the opening quote's line", () => {
    const r = parseOptionalJsonDiagnosed('{\n  "a": "unterminated\n}');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostic).toContain("unterminated string starting at line 2");
    }
  });

  it("double quotes inside a string do not trip the single-quote check", () => {
    // Valid JSON with escaped quotes must parse; the scanner never runs.
    expect(parseOptionalJsonDiagnosed('{"a": "say \\"hi\\""}')).toEqual({
      ok: true,
      present: true,
      value: { a: 'say "hi"' },
    });
  });
});
