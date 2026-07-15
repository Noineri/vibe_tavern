import { describe, expect, it } from "vitest";
import {
  GROUPS,
  parsePageBgBlobs,
  parsePageGradient,
  serializePageGradient,
  serializePageBg,
  upsertPageBgInCss,
} from "./color-math.js";

const LAVA_BACKGROUND = `
  radial-gradient(circle at 20% 30%, oklch(0.85 0.15 35 / 50%), transparent 55%),
  radial-gradient(circle at 80% 60%, #f2c090, transparent 60%),
  var(--bg)
`;

const FIXED_BACKGROUND =
  "radial-gradient(circle at 50% 0%, oklch(0.975 0.055 55), oklch(0.925 0.022 292) 72%)";

describe("page background blob helpers (characterization)", () => {
  it("parses the existing transparent radial blob format", () => {
    expect(parsePageBgBlobs(LAVA_BACKGROUND)).toMatchObject([
      { x: 20, y: 30, size: 55, color: { l: 0.85, c: 0.15, h: 35, a: 0.5 } },
      { x: 80, y: 60, size: 60 },
    ]);
  });

  it("does not misclassify a fixed two-color radial gradient as a blob", () => {
    expect(parsePageBgBlobs(FIXED_BACKGROUND)).toEqual([]);
  });

  it("serializes blobs above the linked --bg fallback", () => {
    expect(serializePageBg(parsePageBgBlobs(LAVA_BACKGROUND))).toContain("\n    var(--bg)");
  });

  it("inserts --page-bg after --bg when a theme did not declare it", () => {
    const css = `:root.sample {\n  --bg: oklch(0.2 0 0);\n  --surface: oklch(0.3 0 0);\n}`;
    const next = upsertPageBgInCss(css, "linear-gradient(180deg, #fff, #000)");
    expect(next).toContain(
      "--bg: oklch(0.2 0 0);\n  --page-bg:linear-gradient(180deg, #fff, #000);",
    );
  });
});

describe("theme token groups", () => {
  it("exposes the authored selection, glass, logo, and strong diff colors", () => {
    const grouped = new Set(GROUPS.flatMap((group) => group.tokens));
    for (const token of [
      "--sel-text",
      "--glass-bg",
      "--accent-mid",
      "--danger-strong",
      "--success-strong",
    ]) {
      expect(grouped.has(token), token).toBe(true);
    }
  });
});

describe("editable base page gradient", () => {
  it("parses the fixed radial gradients used by Mystic themes", () => {
    expect(parsePageGradient(FIXED_BACKGROUND)).toEqual({
      kind: "radial",
      x: 50,
      y: 0,
      start: {
        color: { l: 0.975, c: 0.055, h: 55, a: null },
        position: 0,
      },
      end: {
        color: { l: 0.925, c: 0.022, h: 292, a: null },
        position: 72,
      },
    });
  });

  it("round-trips a controllable linear gradient", () => {
    const gradient = {
      kind: "linear" as const,
      angle: 135,
      start: { color: { l: 0.8, c: 0.1, h: 30, a: null }, position: 0 },
      end: { color: { l: 0.2, c: 0.05, h: 280, a: null }, position: 100 },
    };
    expect(parsePageGradient(serializePageGradient(gradient))).toEqual(gradient);
  });

  it("serializes blobs above a fixed base gradient", () => {
    const gradient = parsePageGradient(FIXED_BACKGROUND);
    expect(gradient).not.toBeNull();
    const value = serializePageBg(parsePageBgBlobs(LAVA_BACKGROUND).slice(0, 1), gradient);
    expect(value).toContain("transparent 55%)");
    expect(value).toContain("radial-gradient(circle at 50% 0%");
    expect(value.endsWith("var(--bg)")).toBe(false);
  });

  it("keeps the linked solid fallback when no base gradient is selected", () => {
    expect(serializePageBg([], null)).toBe("var(--bg)");
  });
});
