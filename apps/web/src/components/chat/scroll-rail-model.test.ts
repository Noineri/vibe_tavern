import { describe, expect, it } from "bun:test";
import { buildRailEntries, buildRailSegments, railIndexAtY, railIndexFraction, railWindow, railSnippet } from "./scroll-rail-model.js";

describe("scroll rail model", () => {
  it("uses canonical positions, display indices, and author inputs without numbering placeholders", () => {
    const entries = buildRailEntries(["a", "tool", "__pending-user", "b", "unknown", "invalid"], {
      a: { role: "assistant", position: 119, content: "First\n  scene" },
      tool: { role: "tool", position: 120, content: "tool output" },
      b: { role: "user", position: 122, content: "Reply" },
      invalid: { role: "user", content: "no canonical position" },
    }, { assistant: "Keith", user: "Noah" });
    expect(entries).toEqual([
      { id: "a", displayIndex: 0, number: 120, role: "assistant", author: "Keith", snippet: "First scene" },
      { id: "b", displayIndex: 3, number: 123, role: "user", author: "Noah", snippet: "Reply" },
    ]);
  });

  it("merges contiguous buckets into the pixel budget without losing messages", () => {
    for (const count of [0, 1, 10, 1000]) {
      const entries = Array.from({ length: count }, (_, i) => ({ id: `${i}`, displayIndex: i, number: i + 1, role: "assistant" as const, author: "", snippet: "" }));
      for (const height of [0, 3, 4, 41, 800]) {
        const segments = buildRailSegments(entries, height);
        expect(segments.length).toBeLessThanOrEqual(Math.floor(height / 4));
        if (!segments.length) continue;
        expect(segments[0].startIndex).toBe(0);
        expect(segments.at(-1)!.endIndex).toBe(count - 1);
        for (let i = 1; i < segments.length; i++) {
          expect(segments[i].startIndex).toBe(segments[i - 1].endIndex + 1);
        }
      }
    }
  });

  it("maps every message monotonically, including messages sharing a tick", () => {
    let last = -1;
    for (let y = -10; y <= 110; y++) {
      const index = railIndexAtY(y, 0, 100, 1000);
      expect(index).toBeGreaterThanOrEqual(last);
      last = index;
    }
    for (let i = 0; i < 1000; i++) {
      expect(railIndexAtY(railIndexFraction(i, 1000) * 100, 0, 100, 1000)).toBe(i);
    }
    expect(railIndexAtY(999, 0, 100, 1000)).toBe(999);
    expect(railIndexAtY(0, 0, 0, 1000)).toBe(-1);
    expect(railIndexAtY(10, 0, 100, 0)).toBe(-1);
  });

  it("clamps window fractions, including overscroll and empty viewports", () => {
    expect(railWindow(200, 1000, 400)).toEqual({ start: 0.2, end: 0.6 });
    expect(railWindow(-100, 1000, 400)).toEqual({ start: 0, end: 0.4 });
    expect(railWindow(5000, 1000, 400)).toEqual({ start: 0.6, end: 1 });
    expect(railWindow(0, 100, 400)).toEqual({ start: 0, end: 1 });
    expect(railWindow(NaN, 0, 0)).toEqual({ start: 0, end: 1 });
  });

  it("bounds normalized snippets without splitting surrogate pairs", () => {
    expect(railSnippet(" \n  First\t second   ")).toBe("First second");
    expect(railSnippet("abcdef", 4)).toBe("abc…");
    expect(railSnippet("😀😀😀", 2)).toBe("😀…");
    expect(railSnippet("text", 0)).toBe("");
  });
});
