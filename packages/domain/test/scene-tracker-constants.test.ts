import { describe, expect, it } from "bun:test";
import { synthesizeSceneSample, stripLabels, computeSceneSchemaHash } from "../src/scene-tracker-constants.js";
import type { SceneTrackerDsl } from "../src/scene-tracker-constants.js";

describe("synthesizeSceneSample", () => {
  it("samples a leaf schema in the declared type (string/number/boolean)", () => {
    const dsl: SceneTrackerDsl = {
      mood: { $type: "string" },
      ready: { $type: "boolean" },
      health: { $type: "number" },
    };
    expect(synthesizeSceneSample(dsl)).toEqual({ mood: "…", ready: false, health: 0 });
  });

  it("samples a bounded number at its midpoint (so the meter renders ~half)", () => {
    const dsl: SceneTrackerDsl = { tension: { $type: "number", min: 0, max: 10 } };
    expect(synthesizeSceneSample(dsl)).toEqual({ tension: 5 });
  });

  it("samples a non-zero-min bounded number at its midpoint", () => {
    const dsl: SceneTrackerDsl = { sanity: { $type: "number", min: 20, max: 80 } };
    expect(synthesizeSceneSample(dsl)).toEqual({ sanity: 50 });
  });

  it("falls back to the bound when only one side is set", () => {
    const dsl: SceneTrackerDsl = {
      low: { $type: "number", min: 3 },
      high: { $type: "number", max: 9 },
    };
    expect(synthesizeSceneSample(dsl)).toEqual({ low: 3, high: 9 });
  });

  it("recurses into an object's properties", () => {
    const dsl: SceneTrackerDsl = {
      npc: { $type: "object", properties: { name: { $type: "string" }, trust: { $type: "number", min: 0, max: 100 } } },
    };
    expect(synthesizeSceneSample(dsl)).toEqual({ npc: { name: "…", trust: 50 } });
  });

  it("samples an array as a single-element sample of its items (incl. array-of-object)", () => {
    const dsl: SceneTrackerDsl = {
      tags: { $type: "array", items: { $type: "string" } },
      party: { $type: "array", items: { $type: "object", properties: { name: { $type: "string" }, hp: { $type: "number", min: 0, max: 100 } } } },
    };
    expect(synthesizeSceneSample(dsl)).toEqual({
      tags: ["…"],
      party: [{ name: "…", hp: 50 }],
    });
  });

  it("produces an empty object for an empty schema", () => {
    expect(synthesizeSceneSample({})).toEqual({});
  });

  it("caps pathological nesting at SAMPLE_MAX_DEPTH with null (insurance, not a real limit)", () => {
    // A schema nested deeper than the cap cannot be authored meaningfully, but
    // the synthesizer must still terminate — it returns null past the cap.
    let inner: SceneTrackerDsl[ string ] = { $type: "string" };
    for (let i = 0; i < 12; i += 1) inner = { $type: "object", properties: { v: inner } };
    const dsl: SceneTrackerDsl = { root: inner };
    // 12 levels of object wrapping exceeds the 8-deep cap → the deepest leaf is null.
    expect(synthesizeSceneSample(dsl)).toEqual({ root: { v: { v: { v: { v: { v: { v: { v: { v: null } } } } } } } } });
  });
});

describe("stripLabels", () => {
  it("removes labels at every level (leaf, object, array, nested)", () => {
    const dsl: SceneTrackerDsl = {
      mood: { $type: "string", label: "Настроение" },
      hp: { $type: "number", min: 0, max: 100, label: "HP" },
      party: {
        $type: "array",
        label: "Группа",
        items: { $type: "object", label: "Член", properties: { name: { $type: "string", label: "Имя" } } },
      },
      npc: { $type: "object", label: "NPC", properties: { trust: { $type: "number", min: 0, max: 10, label: "Доверие" } } },
    };
    expect(stripLabels(dsl)).toEqual({
      mood: { $type: "string" },
      hp: { $type: "number", min: 0, max: 100 },
      party: { $type: "array", items: { $type: "object", properties: { name: { $type: "string" } } } },
      npc: { $type: "object", properties: { trust: { $type: "number", min: 0, max: 10 } } },
    });
  });

  it("is a no-op when no labels are present (backward compatible)", () => {
    const dsl: SceneTrackerDsl = { mood: { $type: "string" }, hp: { $type: "number", min: 0, max: 100 } };
    expect(stripLabels(dsl)).toEqual(dsl);
  });

  it("does not mutate the input DSL", () => {
    const dsl: SceneTrackerDsl = { mood: { $type: "string", label: "Mood" } };
    stripLabels(dsl);
    expect(dsl.mood.label).toBe("Mood");
  });
});

describe("computeSceneSchemaHash (label invariance)", () => {
  const base: SceneTrackerDsl = {
    mood: { $type: "string" },
    hp: { $type: "number", min: 0, max: 100 },
    npc: { $type: "object", properties: { trust: { $type: "number", min: 0, max: 10 } } },
  };

  it("is unchanged when a label is added, changed, or removed", () => {
    const noLabel = computeSceneSchemaHash(base);
    const withLabel = computeSceneSchemaHash({
      mood: { $type: "string", label: "Mood" },
      hp: { $type: "number", min: 0, max: 100, label: "HP" },
      npc: { $type: "object", label: "NPC", properties: { trust: { $type: "number", min: 0, max: 10, label: "Trust" } } },
    });
    const changedLabel = computeSceneSchemaHash({
      mood: { $type: "string", label: "Совсем другое" },
      hp: { $type: "number", min: 0, max: 100 },
      npc: { $type: "object", properties: { trust: { $type: "number", min: 0, max: 10 } } },
    });
    expect(withLabel).toBe(noLabel);
    expect(changedLabel).toBe(noLabel);
  });

  it("changes when the actual structure (key/type/bounds) changes", () => {
    const before = computeSceneSchemaHash(base);
    const after = computeSceneSchemaHash({
      mood: { $type: "string" },
      hp: { $type: "number", min: 0, max: 100, label: "HP" }, // label-only → same
      npc: { $type: "object", properties: { trust: { $type: "number", min: 0, max: 5 } } }, // bounds changed
    });
    expect(after).not.toBe(before);
  });
});
