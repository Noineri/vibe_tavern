import { describe, expect, it } from "bun:test";
import {
  computeSceneSchemaHash,
  createDefaultSceneTrackerConfig,
  EMPTY_SCENE_SCHEMA_HASH,
  SCENE_RESERVED_SEGMENTS,
  SCENE_TRACKER_LIMITS,
} from "@vibe-tavern/domain";
import type { SceneTrackerDsl, SceneTrackerSchemaNode } from "@vibe-tavern/domain";
import {
  buildSceneValueSchema,
  resolveSceneDslPath,
  sceneTrackerConfigSchema,
  sceneTrackerDslSchema,
  sceneTrackerEditPathSchema,
  sceneTrackerNodeSchema,
  updateTrackerConfigSchema,
  validateSceneData,
} from "../src/schemas/tracker-schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an object that owns an arbitrary key (incl. `__proto__`) without invoking the prototype setter. */
function dslWithRootKey(key: string, node: SceneTrackerSchemaNode): Record<string, SceneTrackerSchemaNode> {
  return Object.assign(Object.create(null), { [key]: node });
}

/** Join a Zod issue path into a dotted string for readable assertions. */
function issuePaths(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }): string[] {
  if (result.success || !result.error) return [];
  return result.error.issues.map((issue) => issue.path.join("."));
}

/** `n` nested object wrappers around a string leaf (levels=0 → bare leaf, nodeDepth = levels + 1). */
function chainOfObjects(levels: number): SceneTrackerSchemaNode {
  let node: SceneTrackerSchemaNode = { $type: "string" };
  for (let i = 0; i < levels; i += 1) node = { $type: "object", properties: { nest: node } };
  return node;
}

const validDsl: SceneTrackerDsl = {
  location: { $type: "string" },
  tension: { $type: "number", min: 0, max: 10 },
  resolved: { $type: "boolean" },
  health: { $type: "number", min: 0, max: 100 },
  allies: { $type: "array", items: { $type: "string" } },
  weather: {
    $type: "object",
    properties: {
      temperature: { $type: "number" },
      condition: { $type: "string" },
    },
  },
};

// ---------------------------------------------------------------------------
// DSL node validation
// ---------------------------------------------------------------------------

describe("sceneTrackerNodeSchema", () => {
  it("accepts every valid node kind", () => {
    expect(sceneTrackerNodeSchema.parse({ $type: "string" })).toEqual({ $type: "string" });
    expect(sceneTrackerNodeSchema.parse({ $type: "number" })).toEqual({ $type: "number" });
    expect(sceneTrackerNodeSchema.parse({ $type: "number", min: 0, max: 100 })).toEqual({ $type: "number", min: 0, max: 100 });
    expect(sceneTrackerNodeSchema.parse({ $type: "boolean" })).toEqual({ $type: "boolean" });
    expect(sceneTrackerNodeSchema.parse({ $type: "array", items: { $type: "string" } })).toEqual({ $type: "array", items: { $type: "string" } });
    expect(sceneTrackerNodeSchema.parse({ $type: "object", properties: { a: { $type: "string" } } })).toEqual({ $type: "object", properties: { a: { $type: "string" } } });
  });

  it("rejects an unknown $type discriminator", () => {
    expect(sceneTrackerNodeSchema.safeParse({ $type: "colour" }).success).toBe(false);
  });

  it("rejects unknown fields on a node (strict)", () => {
    expect(sceneTrackerNodeSchema.safeParse({ $type: "string", extra: 1 }).success).toBe(false);
    expect(sceneTrackerNodeSchema.safeParse({ $type: "object", properties: {}, extra: 1 }).success).toBe(false);
  });

  it("accepts an optional `label` on every node kind (renderer-only metadata)", () => {
    expect(sceneTrackerNodeSchema.parse({ $type: "string", label: "Mood" })).toEqual({ $type: "string", label: "Mood" });
    expect(sceneTrackerNodeSchema.parse({ $type: "boolean", label: "Ready" })).toEqual({ $type: "boolean", label: "Ready" });
    expect(sceneTrackerNodeSchema.parse({ $type: "number", min: 0, max: 10, label: "Tension" })).toEqual({ $type: "number", min: 0, max: 10, label: "Tension" });
    expect(sceneTrackerNodeSchema.parse({ $type: "array", items: { $type: "string" }, label: "Tags" })).toEqual({ $type: "array", items: { $type: "string" }, label: "Tags" });
    expect(sceneTrackerNodeSchema.parse({ $type: "object", properties: { a: { $type: "string" } }, label: "NPC" })).toEqual({ $type: "object", properties: { a: { $type: "string" } }, label: "NPC" });
    // A label-less node still validates (backward compatible).
    expect(sceneTrackerNodeSchema.safeParse({ $type: "string" }).success).toBe(true);
  });

  it("rejects a label that is too long or multi-line", () => {
    expect(sceneTrackerNodeSchema.safeParse({ $type: "string", label: "x".repeat(61) }).success).toBe(false);
    expect(sceneTrackerNodeSchema.safeParse({ $type: "string", label: "two\nlines" }).success).toBe(false);
    // At the limit is fine.
    expect(sceneTrackerNodeSchema.safeParse({ $type: "string", label: "x".repeat(60) }).success).toBe(true);
  });

  it("rejects a non-string label", () => {
    expect(sceneTrackerNodeSchema.safeParse({ $type: "string", label: 5 }).success).toBe(false);
  });

  it("enforces the ranged-number descriptor: both or neither, min <= max", () => {
    expect(sceneTrackerNodeSchema.safeParse({ $type: "number", min: 0 }).success).toBe(false);
    expect(sceneTrackerNodeSchema.safeParse({ $type: "number", max: 10 }).success).toBe(false);
    expect(sceneTrackerNodeSchema.safeParse({ $type: "number", min: 10, max: 5 }).success).toBe(false);
    expect(sceneTrackerNodeSchema.safeParse({ $type: "number", min: 0, max: 0 }).success).toBe(true);
  });

  it("rejects a reserved segment used as a nested object key", () => {
    for (const reserved of SCENE_RESERVED_SEGMENTS) {
      const node: SceneTrackerSchemaNode = { $type: "object", properties: dslWithRootKey(reserved, { $type: "string" }) };
      const result = sceneTrackerNodeSchema.safeParse(node);
      expect(result.success).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// DSL (root) validation
// ---------------------------------------------------------------------------

describe("sceneTrackerDslSchema", () => {
  it("accepts a representative schema exercising every node kind", () => {
    expect(sceneTrackerDslSchema.parse(validDsl)).toEqual(validDsl);
  });

  it("accepts an empty schema", () => {
    expect(sceneTrackerDslSchema.parse({})).toEqual({});
  });

  it("rejects a malformed node inside the schema", () => {
    expect(sceneTrackerDslSchema.safeParse({ bad: { $type: "string", extra: 1 } }).success).toBe(false);
    expect(sceneTrackerDslSchema.safeParse({ bad: { $type: "nope" } }).success).toBe(false);
  });

  it("rejects every reserved segment used as a root key", () => {
    for (const reserved of SCENE_RESERVED_SEGMENTS) {
      const dsl = dslWithRootKey(reserved, { $type: "string" });
      const result = sceneTrackerDslSchema.safeParse(dsl);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(issuePaths(result).some((p) => p.includes(reserved))).toBe(true);
      }
    }
  });

  it("rejects a schema deeper than maxDepth and accepts the boundary", () => {
    expect(sceneTrackerDslSchema.safeParse({ a: chainOfObjects(SCENE_TRACKER_LIMITS.maxDepth - 1) }).success).toBe(true);
    expect(sceneTrackerDslSchema.safeParse({ a: chainOfObjects(SCENE_TRACKER_LIMITS.maxDepth) }).success).toBe(false);
  });

  it("rejects more than maxKeysPerObject at the root", () => {
    const dsl: SceneTrackerDsl = {};
    for (let i = 0; i < SCENE_TRACKER_LIMITS.maxKeysPerObject + 1; i += 1) dsl[`k${i}`] = { $type: "string" };
    expect(sceneTrackerDslSchema.safeParse(dsl).success).toBe(false);
  });

  it("rejects more than maxKeysPerObject in a nested object", () => {
    const properties: Record<string, SceneTrackerSchemaNode> = {};
    for (let i = 0; i < SCENE_TRACKER_LIMITS.maxKeysPerObject + 1; i += 1) properties[`k${i}`] = { $type: "string" };
    const dsl: SceneTrackerDsl = { box: { $type: "object", properties } };
    expect(sceneTrackerDslSchema.safeParse(dsl).success).toBe(false);
  });

  it("rejects a schema with more than maxTotalNodes, even when per-object key caps hold", () => {
    // 64 root keys, each an object with 5 leaf children → 64 * (1 + 5) = 384 nodes > 256, no key cap breached.
    const dsl: SceneTrackerDsl = {};
    for (let i = 0; i < SCENE_TRACKER_LIMITS.maxKeysPerObject; i += 1) {
      const properties: Record<string, SceneTrackerSchemaNode> = {};
      for (let j = 0; j < 5; j += 1) properties[`p${j}`] = { $type: "string" };
      dsl[`k${i}`] = { $type: "object", properties };
    }
    expect(sceneTrackerDslSchema.safeParse(dsl).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Generated-data validator
// ---------------------------------------------------------------------------

describe("validateSceneData", () => {
  it("accepts data matching every node kind", () => {
    const data = {
      location: "The Drowning Tavern",
      tension: 7,
      resolved: false,
      health: 42,
      allies: ["Mira", "Vesh"],
      weather: { temperature: 14, condition: "sleet" },
    };
    expect(validateSceneData(validDsl, data).success).toBe(true);
  });

  it("rejects a wrong primitive type with a path pointing at the field", () => {
    const result = validateSceneData({ name: { $type: "string" } }, { name: 123 });
    expect(result.success).toBe(false);
    if (!result.success) expect(issuePaths(result).some((p) => p.includes("name"))).toBe(true);
  });

  it("rejects an unknown property with an exact path to the offending key", () => {
    const result = validateSceneData({ name: { $type: "string" } }, { name: "a", bogus: 1 });
    expect(result.success).toBe(false);
    if (!result.success) expect(issuePaths(result).some((p) => p === "bogus")).toBe(true);
  });

  it("rejects a nested unknown property with the full dotted path", () => {
    const dsl: SceneTrackerDsl = { box: { $type: "object", properties: { x: { $type: "string" } } } };
    const result = validateSceneData(dsl, { box: { x: "a", bogus: 1 } });
    expect(result.success).toBe(false);
    if (!result.success) expect(issuePaths(result).some((p) => p === "box.bogus")).toBe(true);
  });

  it("allows null only at a primitive leaf and rejects null for objects and arrays", () => {
    const leafDsl: SceneTrackerDsl = { name: { $type: "string" } };
    expect(validateSceneData(leafDsl, { name: null }).success).toBe(true);
    expect(validateSceneData(leafDsl, { name: undefined }).success).toBe(false);

    const objDsl: SceneTrackerDsl = { box: { $type: "object", properties: { x: { $type: "string" } } } };
    expect(validateSceneData(objDsl, { box: null }).success).toBe(false);
    expect(validateSceneData(objDsl, { box: { x: null } }).success).toBe(true);

    const arrDsl: SceneTrackerDsl = { tags: { $type: "array", items: { $type: "string" } } };
    expect(validateSceneData(arrDsl, { tags: null }).success).toBe(false);
    expect(validateSceneData(arrDsl, { tags: [null] }).success).toBe(true);
  });

  it("accepts an empty homogeneous array", () => {
    const dsl: SceneTrackerDsl = { tags: { $type: "array", items: { $type: "string" } } };
    expect(validateSceneData(dsl, { tags: [] }).success).toBe(true);
  });

  it("enforces the ranged-number bounds on generated values", () => {
    const dsl: SceneTrackerDsl = { tension: { $type: "number", min: 0, max: 10 } };
    expect(validateSceneData(dsl, { tension: 5 }).success).toBe(true);
    expect(validateSceneData(dsl, { tension: 11 }).success).toBe(false);
    expect(validateSceneData(dsl, { tension: -1 }).success).toBe(false);
  });

  it("enforces the generated array-item cap", () => {
    const dsl: SceneTrackerDsl = { tags: { $type: "array", items: { $type: "string" } } };
    const ok = { tags: Array.from({ length: SCENE_TRACKER_LIMITS.maxArrayItems }, () => "x") };
    const tooMany = { tags: Array.from({ length: SCENE_TRACKER_LIMITS.maxArrayItems + 1 }, () => "x") };
    expect(validateSceneData(dsl, ok).success).toBe(true);
    expect(validateSceneData(dsl, tooMany).success).toBe(false);
  });

  it("enforces the generated string-length cap", () => {
    const dsl: SceneTrackerDsl = { name: { $type: "string" } };
    expect(validateSceneData(dsl, { name: "x".repeat(SCENE_TRACKER_LIMITS.maxStringLength) }).success).toBe(true);
    expect(validateSceneData(dsl, { name: "x".repeat(SCENE_TRACKER_LIMITS.maxStringLength + 1) }).success).toBe(false);
  });
});

describe("buildSceneValueSchema", () => {
  it("builds a schema for a ranged number that accepts null and in-range numbers", () => {
    const schema = buildSceneValueSchema({ $type: "number", min: 0, max: 10 });
    expect(schema.safeParse(5).success).toBe(true);
    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.safeParse(11).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Canonical schema hash
// ---------------------------------------------------------------------------

describe("computeSceneSchemaHash", () => {
  it("is independent of object key order", () => {
    const a: SceneTrackerDsl = { location: { $type: "string" }, tension: { $type: "number", min: 0, max: 10 } };
    const b: SceneTrackerDsl = { tension: { $type: "number", min: 0, max: 10 }, location: { $type: "string" } };
    expect(computeSceneSchemaHash(a)).toBe(computeSceneSchemaHash(b));
  });

  it("differs for different schemas", () => {
    expect(computeSceneSchemaHash({ a: { $type: "string" } })).not.toBe(computeSceneSchemaHash({ a: { $type: "number" } }));
  });

  it("matches EMPTY_SCENE_SCHEMA_HASH for the empty schema", () => {
    expect(computeSceneSchemaHash({})).toBe(EMPTY_SCENE_SCHEMA_HASH);
  });
});

// ---------------------------------------------------------------------------
// Edit paths
// ---------------------------------------------------------------------------

describe("sceneTrackerEditPathSchema + resolveSceneDslPath", () => {
  it("accepts a path of non-empty, non-reserved segments", () => {
    expect(sceneTrackerEditPathSchema.parse(["box", "x"])).toEqual(["box", "x"]);
  });

  it("rejects empty and reserved segments", () => {
    expect(sceneTrackerEditPathSchema.safeParse(["box", ""]).success).toBe(false);
    expect(sceneTrackerEditPathSchema.safeParse(["box", "__proto__"]).success).toBe(false);
    expect(sceneTrackerEditPathSchema.safeParse(["box", "$type"]).success).toBe(false);
  });

  it("resolves a nested path and reports stale/non-object/empty paths", () => {
    const dsl: SceneTrackerDsl = { box: { $type: "object", properties: { x: { $type: "string" } } } };
    expect(resolveSceneDslPath(dsl, ["box", "x"]).success).toBe(true);
    expect(resolveSceneDslPath(dsl, ["box"]).success).toBe(true);
    expect(resolveSceneDslPath(dsl, []).success).toBe(false);
    expect(resolveSceneDslPath(dsl, ["box", "missing"]).success).toBe(false);
    expect(resolveSceneDslPath(dsl, ["box", "x", "deep"]).success).toBe(false);
    expect(resolveSceneDslPath(dsl, ["__proto__"]).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Config schemas
// ---------------------------------------------------------------------------

describe("sceneTrackerConfigSchema", () => {
  it("fills fixed defaults and a consistent schemaHash from an empty input", () => {
    const parsed = sceneTrackerConfigSchema.parse({});
    expect(parsed).toMatchObject({
      schema: {},
      autoMode: "assistant",
      contextWindow: 6,
      continuityLastN: 3,
      injectionDepth: 1,
      injectLastN: 1,
      promptFormat: "json",
      useChatModel: true,
      generatePrompt: "",
      injectPrompt: "",
      providerProfileId: null,
      model: null,
      revision: 0,
    });
    expect(parsed.schemaHash).toBe(EMPTY_SCENE_SCHEMA_HASH);
  });

  it("matches createDefaultSceneTrackerConfig()", () => {
    expect(sceneTrackerConfigSchema.parse({})).toEqual(createDefaultSceneTrackerConfig());
  });

  it("recomputes schemaHash from a provided schema when absent", () => {
    const schema: SceneTrackerDsl = { tension: { $type: "number", min: 0, max: 10 } };
    const parsed = sceneTrackerConfigSchema.parse({ schema });
    expect(parsed.schemaHash).toBe(computeSceneSchemaHash(schema));
  });

  it("accepts a correct explicit schemaHash", () => {
    const schema: SceneTrackerDsl = { tension: { $type: "number", min: 0, max: 10 } };
    expect(sceneTrackerConfigSchema.safeParse({ schema, schemaHash: computeSceneSchemaHash(schema) }).success).toBe(true);
  });

  it("rejects a schemaHash that disagrees with the schema", () => {
    const result = sceneTrackerConfigSchema.safeParse({ schema: { a: { $type: "string" } }, schemaHash: "deadbeef" });
    expect(result.success).toBe(false);
    if (!result.success) expect(issuePaths(result).some((p) => p === "schemaHash")).toBe(true);
  });

  it("rejects unknown config fields (strict)", () => {
    expect(sceneTrackerConfigSchema.safeParse({ schema: {}, foo: 1 }).success).toBe(false);
  });

  it("rejects an invalid DSL inside the schema and invalid scalars", () => {
    expect(sceneTrackerConfigSchema.safeParse({ schema: { a: { $type: "string", extra: 1 } } }).success).toBe(false);
    expect(sceneTrackerConfigSchema.safeParse({ contextWindow: 0 }).success).toBe(false);
    expect(sceneTrackerConfigSchema.safeParse({ autoMode: "always" }).success).toBe(false);
  });
});

describe("updateTrackerConfigSchema (PATCH)", () => {
  it("is default-free: an empty PATCH yields an empty object", () => {
    expect(updateTrackerConfigSchema.parse({})).toEqual({});
  });

  it("preserves only the sent keys", () => {
    expect(updateTrackerConfigSchema.parse({ injectLastN: 2, promptFormat: "xml" })).toEqual({ injectLastN: 2, promptFormat: "xml" });
  });

  it("rejects server-managed revision and schemaHash", () => {
    expect(updateTrackerConfigSchema.safeParse({ revision: 1 }).success).toBe(false);
    expect(updateTrackerConfigSchema.safeParse({ schemaHash: "x" }).success).toBe(false);
  });

  it("rejects unknown fields and validates the nested schema", () => {
    expect(updateTrackerConfigSchema.safeParse({ foo: 1 }).success).toBe(false);
    expect(updateTrackerConfigSchema.safeParse({ schema: { a: { $type: "string" } } }).success).toBe(true);
    expect(updateTrackerConfigSchema.safeParse({ schema: { a: { $type: "nope" } } }).success).toBe(false);
  });
});
