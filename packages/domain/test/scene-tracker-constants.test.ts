import { describe, expect, it } from "bun:test";
import {
  computeSceneSchemaHash,
  findInvalidXmlKeys,
  normalizeSceneTrackerConfig,
  stripLabels,
  synthesizeSceneSample,
} from "../src/scene-tracker-constants.js";
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

  it("ignores tone fields (sample values depend only on the structure)", () => {
    const toneFree: SceneTrackerDsl = { gate: { $type: "string" }, hp: { $type: "number", min: 0, max: 100 } };
    const toneBearing: SceneTrackerDsl = {
      gate: { $type: "string", tone: "danger", toneBy: { Ruined: "danger", Repaired: "success" } },
      hp: { $type: "number", min: 0, max: 100, tone: "success" },
    };
    expect(synthesizeSceneSample(toneBearing)).toEqual(synthesizeSceneSample(toneFree));
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

  it("removes tones and value-tone maps alongside labels at every level", () => {
    const dsl: SceneTrackerDsl = {
      gate: { $type: "string", label: "Gate", tone: "danger", toneBy: { Ruined: "danger", Repaired: "success" } },
      hp: { $type: "number", min: 0, max: 100, tone: "success" },
      ready: { $type: "boolean", tone: "warning" },
      crew: { $type: "array", tone: "accent", items: { $type: "string", tone: "danger" } },
      npc: { $type: "object", tone: "accent", properties: { trust: { $type: "number", min: 0, max: 10, tone: "warning" } } },
    };
    expect(stripLabels(dsl)).toEqual({
      gate: { $type: "string" },
      hp: { $type: "number", min: 0, max: 100 },
      ready: { $type: "boolean" },
      crew: { $type: "array", items: { $type: "string" } },
      npc: { $type: "object", properties: { trust: { $type: "number", min: 0, max: 10 } } },
    });
  });

  it("projects a tone-bearing schema byte-identically to the tone-free one (prompt serialization)", () => {
    const toneFree: SceneTrackerDsl = { gate: { $type: "string" }, hp: { $type: "number", min: 0, max: 100 } };
    const toneBearing: SceneTrackerDsl = {
      gate: { $type: "string", tone: "danger", toneBy: { Ruined: "danger" } },
      hp: { $type: "number", min: 0, max: 100, tone: "success" },
    };
    expect(JSON.stringify(stripLabels(toneBearing))).toBe(JSON.stringify(stripLabels(toneFree)));
  });

  it("does not mutate the input DSL's tone fields", () => {
    const dsl: SceneTrackerDsl = { gate: { $type: "string", tone: "danger", toneBy: { Ruined: "danger" } } };
    stripLabels(dsl);
    expect(dsl.gate.tone).toBe("danger");
    expect(dsl.gate.toneBy).toEqual({ Ruined: "danger" });
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

describe("computeSceneSchemaHash (tone invariance)", () => {
  const toneFree: SceneTrackerDsl = {
    gate: { $type: "string" },
    hp: { $type: "number", min: 0, max: 100 },
    ready: { $type: "boolean" },
    crew: { $type: "array", items: { $type: "string" } },
    npc: { $type: "object", properties: { trust: { $type: "number", min: 0, max: 10 } } },
  };

  it("is unchanged when tones or value-tone maps are added anywhere (recoloring never dims records)", () => {
    const toneBearing: SceneTrackerDsl = {
      gate: { $type: "string", tone: "danger", toneBy: { Ruined: "danger", Repaired: "success" } },
      hp: { $type: "number", min: 0, max: 100, tone: "success" },
      ready: { $type: "boolean", tone: "warning" },
      crew: { $type: "array", tone: "accent", items: { $type: "string", tone: "danger" } },
      npc: { $type: "object", tone: "accent", properties: { trust: { $type: "number", min: 0, max: 10, tone: "warning" } } },
    };
    expect(computeSceneSchemaHash(toneBearing)).toBe(computeSceneSchemaHash(toneFree));
  });

  it("is unchanged when an existing tone is recolored or removed", () => {
    const bare = computeSceneSchemaHash({ gate: { $type: "string" } });
    expect(computeSceneSchemaHash({ gate: { $type: "string", tone: "danger", toneBy: { Ruined: "danger" } } })).toBe(bare);
    expect(computeSceneSchemaHash({ gate: { $type: "string", tone: "success", toneBy: { Ruined: "warning" } } })).toBe(bare);
  });
});

describe("normalizeSceneTrackerConfig (tone round-trip)", () => {
  it("preserves tone fields verbatim — no defaults injected, nothing dropped", () => {
    const schema: SceneTrackerDsl = {
      gate: { $type: "string", tone: "danger", toneBy: { Ruined: "danger", Repaired: "success" } },
      hp: { $type: "number", min: 0, max: 100, tone: "success" },
      npc: { $type: "object", properties: { trust: { $type: "number", min: 0, max: 10, tone: "warning" } } },
    };
    const normalized = normalizeSceneTrackerConfig({ schema, contextWindow: 6 });
    expect(normalized.schema).toEqual(schema);
    // The recomputed hash is the tone-free identity: the recolor did not dim the records.
    expect(normalized.schemaHash).toBe(
      computeSceneSchemaHash({
        gate: { $type: "string" },
        hp: { $type: "number", min: 0, max: 100 },
        npc: { $type: "object", properties: { trust: { $type: "number", min: 0, max: 10 } } },
      }),
    );
  });
});

describe("findInvalidXmlKeys", () => {
  it("returns no keys when every key is XML-safe", () => {
    const dsl: SceneTrackerDsl = {
      mood: { $type: "string" },
      hp: { $type: "number", min: 0, max: 100 },
      "with-dots.and_underscores": { $type: "string" },
      _leadingUnderscore: { $type: "boolean" },
    };
    expect(findInvalidXmlKeys(dsl)).toEqual([]);
  });

  it("flags root keys that are not valid XML names (space / leading digit / sigil)", () => {
    const dsl: SceneTrackerDsl = {
      "first name": { $type: "string" },
      "123abc": { $type: "number" },
      "$sigil": { $type: "boolean" },
      ok: { $type: "string" },
    } as unknown as SceneTrackerDsl;
    expect(findInvalidXmlKeys(dsl)).toEqual(["first name", "123abc", "$sigil"]);
  });

  it("recurses into nested object properties with dotted paths", () => {
    const dsl: SceneTrackerDsl = {
      location: { $type: "object", properties: { room: { $type: "string" }, "bad key": { $type: "string" } } },
    } as unknown as SceneTrackerDsl;
    expect(findInvalidXmlKeys(dsl)).toEqual(["location.bad key"]);
  });

  it("recurses into array item object properties", () => {
    const dsl: SceneTrackerDsl = {
      party: { $type: "array", items: { $type: "object", properties: { name: { $type: "string" }, "bad key": { $type: "string" } } } },
    } as unknown as SceneTrackerDsl;
    expect(findInvalidXmlKeys(dsl)).toEqual(["party.bad key"]);
  });

  it("returns nothing for JSON-irrelevant schemas (any key is JSON-valid)", () => {
    // The check is XML-only; this just confirms the helper is pure and does not
    // depend on any promptFormat — the caller gates on format.
    const dsl: SceneTrackerDsl = { "totally fine for json": { $type: "string" } } as unknown as SceneTrackerDsl;
    expect(findInvalidXmlKeys(dsl)).toEqual(["totally fine for json"]);
  });
});
