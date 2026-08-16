import { describe, expect, it } from "bun:test";
import { validateVisualSource } from "./visual-source-validator.js";

/**
 * UX 2026-08-16 remark 6 — static visual-source validation for the copilot's
 * visual pane. Pins: blank passes; a compile-clean source passes; a broken
 * script body reports the engine reason at the script's line; unclosed script
 * and style blocks are reported at their opening line; static checks never
 * execute the script (compile-only).
 */
describe("validateVisualSource", () => {
  it("blank source passes (nothing to check)", () => {
    expect(validateVisualSource("")).toEqual({ ok: true });
    expect(validateVisualSource("   \n ")).toEqual({ ok: true });
  });

  it("a well-formed source passes", () => {
    const src = [
      "<style>.x{color:red}</style>",
      '<div id="xp-root"></div>',
      "<script>",
      "(function(){ var x = 1; function f(){ return x + 1; } f(); })();",
      "</script>",
    ].join("\n");
    expect(validateVisualSource(src)).toEqual({ ok: true });
  });

  it("a syntax error inside a script block is reported with the engine reason at the script's line", () => {
    const src = [
      "<style>.x{color:red}</style>",
      "<div></div>",
      "<script>",
      "(function(){ if (true { } })();",
      "</script>",
    ].join("\n");
    const r = validateVisualSource(src);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems).toHaveLength(1);
      // The <script> opener sits on line 3.
      expect(r.problems[0]!.line).toBe(3);
      expect(r.problems[0]!.message).toContain("script block 1");
      expect(r.problems[0]!.message.length).toBeGreaterThan("script block 1: ".length);
    }
  });

  it("an unclosed <script> block is reported at its opening line", () => {
    const src = "<div></div>\n<script>\nvar x = 1;";
    const r = validateVisualSource(src);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems.some((p) => p.message === "unclosed <script> block" && p.line === 2)).toBe(true);
    }
  });

  it("an unclosed <style> block is reported at its opening line", () => {
    const src = "<style>\n.x{color:red}\n<div></div>";
    const r = validateVisualSource(src);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems.some((p) => p.message === "unclosed <style> block" && p.line === 1)).toBe(true);
    }
  });

  it("empty script bodies are tolerated", () => {
    expect(validateVisualSource("<script></script>")).toEqual({ ok: true });
  });
});
