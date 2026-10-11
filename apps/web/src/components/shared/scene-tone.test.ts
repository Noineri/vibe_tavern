/**
 * scene-tone — resolution precedence + token class maps.
 *
 * The precedence cases moved here from SceneStateView.test.tsx when the helper
 * moved into this module (R7 extraction) — the boundary is unchanged: string
 * node + string value + `toneBy` hit wins, else the node `tone`, else neutral.
 * The map test pins the full literal class names (Tailwind scanner dependence)
 * for the two consumers of the module: the render variants and the Co-Author
 * review card. Pure module — no DOM.
 */
import { describe, expect, it } from "bun:test";
import type { SceneTrackerSchemaNode } from "@vibe-tavern/domain";
import {
  resolveSceneTone,
  SCENE_TONE_BORDER,
  SCENE_TONE_BORDER_SOFT,
  SCENE_TONE_FILL,
  SCENE_TONE_FILL_SOFT,
  SCENE_TONE_TEXT,
} from "./scene-tone.js";

describe("scene-tone — resolveSceneTone precedence", () => {
  it("a toneBy entry matching the current value wins over the node tone", () => {
    const node: SceneTrackerSchemaNode = { $type: "string", tone: "success", toneBy: { Ruined: "danger" } };
    expect(resolveSceneTone(node, "Ruined")).toBe("danger");
  });

  it("an unmatched value falls back to the node tone", () => {
    const node: SceneTrackerSchemaNode = { $type: "string", tone: "success", toneBy: { Ruined: "danger" } };
    expect(resolveSceneTone(node, "Repaired")).toBe("success");
  });

  it("neither tone nor toneBy resolves to neutral undefined", () => {
    expect(resolveSceneTone({ $type: "string" }, "x")).toBeUndefined();
    expect(resolveSceneTone({ $type: "number" }, 3)).toBeUndefined();
  });

  it("non-string nodes resolve tone only; non-string values on string nodes fall to tone", () => {
    expect(resolveSceneTone({ $type: "number", tone: "warning" }, 3)).toBe("warning");
    expect(resolveSceneTone({ $type: "boolean", tone: "danger" }, true)).toBe("danger");
    const node: SceneTrackerSchemaNode = { $type: "string", tone: "success", toneBy: { Ruined: "danger" } };
    expect(resolveSceneTone(node, 42)).toBe("success");
  });
});

describe("scene-tone — token class maps", () => {
  it("every map derives full literal classes for exactly the four semantic tokens", () => {
    for (const token of ["accent", "success", "warning", "danger"] as const) {
      expect(SCENE_TONE_TEXT[token]).toBe(`text-${token}`);
      expect(SCENE_TONE_FILL[token]).toBe(`bg-${token}`);
      expect(SCENE_TONE_BORDER[token]).toBe(`border-${token}`);
      expect(SCENE_TONE_FILL_SOFT[token]).toBe(`bg-${token}/40`);
      expect(SCENE_TONE_BORDER_SOFT[token]).toBe(`border-${token}/40`);
    }
  });
});
