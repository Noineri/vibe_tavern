import { describe, expect, test } from "bun:test";

import { IMAGE_SIZE_DEFAULT, IMAGE_SIZE_MAX_PX, IMAGE_SIZE_MIN_PX, IMAGE_SIZE_PRESETS, IMAGE_SIZE_STEP_PX } from "../src/index.js";

/** IG-CF14: the sizes vocabulary is data — pin its invariants so a future
 *  edit cannot quietly break the pane's stepper/preset contract. */
describe("imagegen sizes vocabulary", () => {
  test("the stepper step reproduces the owner's ladder example (720 → 848 / 592)", () => {
    expect(720 + IMAGE_SIZE_STEP_PX).toBe(848);
    expect(720 - IMAGE_SIZE_STEP_PX).toBe(592);
  });

  test("bounds and default are sane and the default sits inside the bounds", () => {
    expect(IMAGE_SIZE_MIN_PX).toBeLessThan(IMAGE_SIZE_MAX_PX);
    expect(IMAGE_SIZE_DEFAULT.width).toBeGreaterThanOrEqual(IMAGE_SIZE_MIN_PX);
    expect(IMAGE_SIZE_DEFAULT.height).toBeLessThanOrEqual(IMAGE_SIZE_MAX_PX);
  });

  test("every preset is a valid SD-family size: in bounds, multiple of 16, orientation honest", () => {
    for (const preset of IMAGE_SIZE_PRESETS) {
      expect(preset.width % 16).toBe(0);
      expect(preset.height % 16).toBe(0);
      expect(preset.width).toBeGreaterThanOrEqual(IMAGE_SIZE_MIN_PX);
      expect(preset.height).toBeLessThanOrEqual(IMAGE_SIZE_MAX_PX);
      expect(preset.ratio).toMatch(/^\d+:\d+$/);
      if (preset.orientation === "square") {
        expect(preset.width).toBe(preset.height);
      } else if (preset.orientation === "portrait") {
        expect(preset.width).toBeLessThan(preset.height);
      } else {
        expect(preset.width).toBeGreaterThan(preset.height);
      }
    }
  });

  test("no duplicate preset resolutions (each dropdown key is unique)", () => {
    const keys = IMAGE_SIZE_PRESETS.map((p) => `${p.width}x${p.height}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
