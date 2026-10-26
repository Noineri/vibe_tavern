/**
 * Scene render preference — persisted-value validation and selector source.
 *
 * Pins the full preference union separately from the implemented subset, so
 * future render work can append its implementation before exposing a selector
 * option without rejecting an already-persisted valid preference.
 */
import { describe, expect, it } from "bun:test";
import {
  hydrateSceneRenderVariant,
  IMPLEMENTED_SCENE_RENDER_VARIANTS,
} from "./scene-render-store.js";

describe("scene render preference", () => {
  it("hydrates every valid render-variant preference", () => {
    expect(hydrateSceneRenderVariant("rich")).toBe("rich");
    expect(hydrateSceneRenderVariant("compact")).toBe("compact");
    expect(hydrateSceneRenderVariant("clean")).toBe("clean");
    expect(hydrateSceneRenderVariant("hud")).toBe("hud");
  });

  it("falls back to rich for legacy-invalid or absent persisted values", () => {
    expect(hydrateSceneRenderVariant("graphical")).toBe("rich");
    expect(hydrateSceneRenderVariant("future-variant")).toBe("rich");
    expect(hydrateSceneRenderVariant(null)).toBe("rich");
  });

  it("exposes only implemented variants to selector consumers", () => {
    expect(IMPLEMENTED_SCENE_RENDER_VARIANTS).toEqual(["rich", "compact", "clean", "hud"]);
  });
});
