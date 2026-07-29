import { describe, expect, it } from "bun:test";
import {
  DEFAULT_LAMP_BALLS,
  cssColorToRgb01,
  parseLampBalls,
  splitCssList,
} from "./lava-shader.js";

const FALLBACK = [1, 0, 0] as const;

describe("cssColorToRgb01", () => {
  it("converts Theme Tuner OKLCH output instead of falling back to the dark lamp palette", () => {
    const rgb = cssColorToRgb01("oklch(0.614 0.097 204)", FALLBACK);
    expect(rgb[0]).toBeCloseTo(0x23 / 255, 2);
    expect(rgb[1]).toBeCloseTo(0x95 / 255, 2);
    expect(rgb[2]).toBeCloseTo(0x9f / 255, 2);
  });

  it("keeps the authored hex fast path exact", () => {
    expect(cssColorToRgb01("#23959f", FALLBACK)).toEqual([0x23 / 255, 0x95 / 255, 0x9f / 255]);
  });
});

describe("dynamic lamp configuration", () => {
  it("parses per-ball size and speed pairs with WebGL caps", () => {
    expect(parseLampBalls("0.12 0.8, 0.2 1.5")).toEqual([
      { size: 0.12, speed: 0.8 },
      { size: 0.2, speed: 1.5 },
    ]);
    expect(parseLampBalls("not-a-ball")).toBeNull();
    expect(DEFAULT_LAMP_BALLS).toHaveLength(8);
  });

  it("splits an OKLCH palette only at top-level commas", () => {
    expect(splitCssList("oklch(0.6 0.1 20), rgb(1, 2, 3), #fff000")).toEqual([
      "oklch(0.6 0.1 20)",
      "rgb(1, 2, 3)",
      "#fff000",
    ]);
  });
});
