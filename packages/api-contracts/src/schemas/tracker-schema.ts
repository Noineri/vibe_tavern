import {
  SCENE_AUTO_MODE,
  SCENE_PROMPT_FORMAT,
  SCENE_RESERVED_SEGMENTS,
  SCENE_TRACKER_LIMITS,
  computeSceneSchemaHash,
  countSceneDataNodes,
  countSceneSchemaNodes,
  isReservedSceneSegment,
  sceneSchemaDepth,
} from "@vibe-tavern/domain";
import type { SceneTrackerDsl, SceneTrackerSchemaNode } from "@vibe-tavern/domain";
import { z } from "zod";

/**
 * Scene Tracker contracts (SCENE_TRACKER_PLAN, Wave 1 / SCN-1).
 *
 * Three validators live here, all driven by the same central limits imported
 * from `@vibe-tavern/domain`:
 *
 * 1. `sceneTrackerDslSchema` — validates the user-authored shape grammar (the
 *    `schema` field of a config): primitive leaves, nested objects, homogeneous
 *    arrays, and the exact ranged-number descriptor. Rejects unknown fields,
 *    wrong primitive types, invalid descriptors, reserved/unsafe keys, and
 *    out-of-bound structures with exact paths.
 * 2. `buildSceneDataSchema(dsl)` / `validateSceneData(dsl, data)` — validates
 *    the LLM-generated scene state against a runtime DSL. Built dynamically
 *    because the schema is user-authored; returned to `parseStructuredOutput`
 *    by the Scene service so generated output is strict-validated through the
 *    same boundary the Objective Tracker uses. Null is allowed only where a
 *    primitive leaf is expected; objects and arrays cannot be null; empty
 *    arrays are valid.
 * 3. `sceneTrackerConfigSchema` (full, fixed defaults) and
 *    `updateTrackerConfigSchema` (default-free partial PATCH) — the per-chat
 *    config contract, isolated from the Objective config.
 */

// ---------------------------------------------------------------------------
// DSL (shape grammar) schemas
// ---------------------------------------------------------------------------

const sceneNodeStringSchema = z.object({ $type: z.literal("string") }).strict();
const sceneNodeBooleanSchema = z.object({ $type: z.literal("boolean") }).strict();

const sceneNodeNumberSchema = z
  .object({
    $type: z.literal("number"),
    /** Lower bound; present iff `max` is present (ranged descriptor). */
    min: z.number().optional(),
    /** Upper bound; present iff `min` is present (ranged descriptor). */
    max: z.number().optional(),
  })
  .strict();

/**
 * Object key / field-name schema: any non-empty string that is not a reserved
 * path segment. Applied as the *key* schema of every record (`z.record(key, ...)`),
 * so reserved/unsafe keys (including `__proto__`, which Zod's record output
 * reconstruction would otherwise silently drop via the prototype setter) are
 * rejected at the input stage with an exact path.
 */
const sceneFieldNameSchema = z
  .string()
  .min(1)
  .refine((segment) => !isReservedSceneSegment(segment), (segment) => ({
    message: `Reserved path segment "${segment}" is not allowed as a key.`,
  }));

const sceneNodeObjectSchema = z.object({
  $type: z.literal("object"),
  properties: z.record(sceneFieldNameSchema, z.lazy(() => sceneTrackerNodeSchema)),
}).strict();

const sceneNodeArraySchema = z.object({
  $type: z.literal("array"),
  /** Single item template — the array is homogeneous over this shape. */
  items: z.lazy(() => sceneTrackerNodeSchema),
}).strict();

/**
 * One DSL node, discriminated by `$type`. The members are raw `z.object`s so
 * Zod can extract the discriminator; per-type rules (ranged-number both-or-
 * neither + min<=max, reserved keys, per-object key cap) are enforced by a
 * single superRefine on the union so they don't interfere with discrimination.
 *
 * The const is annotated `z.ZodType<SceneTrackerSchemaNode>` (the canonical
 * Zod pattern for a recursive schema) because the object/array members
 * reference this very schema through their `properties`/`items`; the explicit
 * annotation breaks the inference cycle that would otherwise collapse to `any`.
 */
export const sceneTrackerNodeSchema: z.ZodType<SceneTrackerSchemaNode> = z.lazy(() =>
  z
    .discriminatedUnion("$type", [
      sceneNodeStringSchema,
      sceneNodeNumberSchema,
      sceneNodeBooleanSchema,
      sceneNodeObjectSchema,
      sceneNodeArraySchema,
    ])
    .superRefine((node, ctx) => {
      if (node.$type === "number") {
        const hasMin = node.min !== undefined;
        const hasMax = node.max !== undefined;
        if (hasMin !== hasMax) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["min"],
            message: "Ranged number descriptor requires both min and max, or neither.",
          });
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["max"],
            message: "Ranged number descriptor requires both min and max, or neither.",
          });
        } else if (node.min !== undefined && node.max !== undefined && node.min > node.max) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["min"],
            message: `min (${node.min}) must be <= max (${node.max}).`,
          });
        }
      } else if (node.$type === "object") {
        const keys = Object.keys(node.properties);
        if (keys.length > SCENE_TRACKER_LIMITS.maxKeysPerObject) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Object exceeds max ${SCENE_TRACKER_LIMITS.maxKeysPerObject} keys (${keys.length}).`,
          });
        }
      }
    }),
);

/**
 * The root Scene schema: a fields map (implicit root object) — the natural
 * shape a user authors. Enforces reserved root keys, the root key cap, the
 * total-node limit, and the depth limit at the top level so every limit check
 * shares one source of truth.
 */
export const sceneTrackerDslSchema = z
  .record(sceneFieldNameSchema, sceneTrackerNodeSchema)
  .superRefine((dsl, ctx) => {
    const keys = Object.keys(dsl);
    if (keys.length > SCENE_TRACKER_LIMITS.maxKeysPerObject) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Schema root exceeds max ${SCENE_TRACKER_LIMITS.maxKeysPerObject} keys (${keys.length}).`,
      });
    }
    const nodes = countSceneSchemaNodes(dsl);
    if (nodes > SCENE_TRACKER_LIMITS.maxTotalNodes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Schema exceeds max ${SCENE_TRACKER_LIMITS.maxTotalNodes} total nodes (${nodes}).`,
      });
    }
    const depth = sceneSchemaDepth(dsl);
    if (depth > SCENE_TRACKER_LIMITS.maxDepth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Schema exceeds max depth ${SCENE_TRACKER_LIMITS.maxDepth} (${depth}).`,
      });
    }
  });

// ---------------------------------------------------------------------------
// Generated-data validator (dynamic, from a runtime DSL)
// ---------------------------------------------------------------------------

/**
 * Build the Zod schema for the value of one DSL node — used to validate the
 * LLM-generated scene state. Null is permitted only for primitive leaves;
 * objects and arrays are non-nullable. Arrays are bounded by
 * `maxArrayItems` (empty is valid); strings by `maxStringLength`; ranged
 * numbers by their descriptor. Unknown object properties are rejected with an
 * exact path (passthrough + refine so each unknown key is named individually).
 */
export function buildSceneValueSchema(node: SceneTrackerSchemaNode): z.ZodType {
  switch (node.$type) {
    case "string":
      return z.string().max(SCENE_TRACKER_LIMITS.maxStringLength).nullable();
    case "boolean":
      return z.boolean().nullable();
    case "number":
      return node.min !== undefined && node.max !== undefined
        ? z.number().min(node.min).max(node.max).nullable()
        : z.number().nullable();
    case "array":
      return z.array(buildSceneValueSchema(node.items)).max(SCENE_TRACKER_LIMITS.maxArrayItems);
    case "object": {
      const shape: Record<string, z.ZodType> = {};
      for (const [key, child] of Object.entries(node.properties)) {
        shape[key] = buildSceneValueSchema(child);
      }
      return rejectUnknownKeys(z.object(shape));
    }
  }
}

/**
 * Build the Zod schema validating generated scene data against a runtime DSL.
 * The Scene service passes the result to `parseStructuredOutput`, so generated
 * output is strict-validated through the same boundary the Objective Tracker
 * uses. A top-level refine enforces the global total-node limit on the data.
 */
export function buildSceneDataSchema(dsl: SceneTrackerDsl): z.ZodType {
  const root = rejectUnknownKeys(z.object(buildObjectShape(dsl)));
  return root.superRefine((value, ctx) => {
    const total = countSceneDataNodes(value);
    if (total > SCENE_TRACKER_LIMITS.maxTotalNodes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Scene data exceeds max ${SCENE_TRACKER_LIMITS.maxTotalNodes} total nodes (${total}).`,
      });
    }
  });
}

/** Validate generated scene data against a runtime DSL, returning exact-path errors. */
export function validateSceneData(
  dsl: SceneTrackerDsl,
  data: unknown,
): z.SafeParseReturnType<Record<string, unknown>, Record<string, unknown>> {
  return buildSceneDataSchema(dsl).safeParse(data) as z.SafeParseReturnType<
    Record<string, unknown>,
    Record<string, unknown>
  >;
}

function buildObjectShape(dsl: SceneTrackerDsl): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, node] of Object.entries(dsl)) {
    shape[key] = buildSceneValueSchema(node);
  }
  return shape;
}

/** Wrap an object schema so unknown keys are rejected, each at its own path. */
function rejectUnknownKeys<T extends z.ZodRawShape>(objectSchema: z.ZodObject<T>): z.ZodType {
  const knownKeys = new Set(Object.keys(objectSchema.shape));
  return objectSchema.passthrough().superRefine((value, ctx) => {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (!knownKeys.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Unknown property "${key}".`,
        });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Safe dotted edit paths
// ---------------------------------------------------------------------------

/** One non-empty segment that is not a reserved path segment. */
export const sceneTrackerEditPathSegmentSchema = z
  .string()
  .min(1)
  .refine((segment) => !isReservedSceneSegment(segment), (segment) => ({
    message: `Reserved path segment "${segment}" is not allowed.`,
  }));

/** A dotted edit path into a Scene schema — every segment non-reserved. */
export const sceneTrackerEditPathSchema = z.array(sceneTrackerEditPathSegmentSchema);

/** Result of resolving an edit path against a DSL. */
export type ScenePathResolution =
  | { success: true; node: SceneTrackerSchemaNode }
  | { success: false; error: string };

/**
 * Resolve a dotted edit path to its DSL node, or fail with an exact message.
 * Used by the structured editor (SCN-6/SCN-12) to navigate into nested objects.
 * Each step must descend into an object node and name an existing property.
 */
export function resolveSceneDslPath(dsl: SceneTrackerDsl, path: string[]): ScenePathResolution {
  if (path.length === 0) {
    return { success: false, error: "Edit path is empty." };
  }
  let current: SceneTrackerSchemaNode | undefined;
  let cursor: Readonly<Record<string, SceneTrackerSchemaNode>> = dsl;
  for (let i = 0; i < path.length; i += 1) {
    const segment = path[i];
    if (isReservedSceneSegment(segment)) {
      return { success: false, error: `Reserved path segment "${segment}" is not allowed (at depth ${i + 1}).` };
    }
    const node = cursor[segment];
    if (node === undefined) {
      return { success: false, error: `Path segment "${segment}" does not exist (at depth ${i + 1}).` };
    }
    if (i === path.length - 1) {
      current = node;
      break;
    }
    if (node.$type !== "object") {
      return { success: false, error: `Path segment "${segment}" is not an object (at depth ${i + 1}).` };
    }
    cursor = node.properties;
  }
  if (!current) {
    return { success: false, error: "Edit path did not resolve to a node." };
  }
  return { success: true, node: current };
}

// ---------------------------------------------------------------------------
// Per-chat config schemas
// ---------------------------------------------------------------------------

const autoModeSchema = z.enum([
  SCENE_AUTO_MODE.assistant,
  SCENE_AUTO_MODE.manual,
]);

const promptFormatSchema = z.enum([
  SCENE_PROMPT_FORMAT.json,
  SCENE_PROMPT_FORMAT.xml,
]);

/**
 * Full Scene Tracker config with fixed defaults. `revision` and `schemaHash`
 * are server-managed (an edit bumps revision and recomputes the hash). The
 * trailing transform reconciles `schemaHash`: an empty/absent hash is recomputed
 * from `schema` (so `parse({ schema: {} })` yields a consistent config), while
 * a non-empty hash that disagrees with `schema` is rejected — the config can
 * never silently drift out of integrity.
 */
export const sceneTrackerConfigSchema = z
  .object({
    schema: sceneTrackerDslSchema.default(() => ({})),
    autoMode: autoModeSchema.default(SCENE_AUTO_MODE.assistant),
    contextWindow: z.number().int().min(1).default(6),
    continuityLastN: z.number().int().min(0).default(3),
    injectionDepth: z.number().int().min(1).default(1),
    injectLastN: z.number().int().min(0).default(1),
    promptFormat: promptFormatSchema.default(SCENE_PROMPT_FORMAT.json),
    useChatModel: z.boolean().default(true),
    generatePrompt: z.string().default(""),
    injectPrompt: z.string().default(""),
    providerProfileId: z.string().nullable().default(null),
    model: z.string().nullable().default(null),
    revision: z.number().int().min(0).default(0),
    schemaHash: z.string().default(""),
  })
  .strict()
  .transform((config, ctx) => {
    const expected = computeSceneSchemaHash(config.schema);
    if (config.schemaHash !== "" && config.schemaHash !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schemaHash"],
        message: "schemaHash does not match the canonical hash of schema.",
      });
      return config;
    }
    return { ...config, schemaHash: expected };
  });

/**
 * Default-free partial PATCH body for the Scene config (mirrors
 * `updateObjectiveConfigSchema`). Every field is plain `.optional()` with NO
 * `.default()`: a default would silently reset an unmentioned field on patch.
 * `revision` and `schemaHash` are intentionally absent — they are server-
 * managed and recomputed on write (SCN-2 bumps revision whenever `schema`
 * changes and recomputes the hash).
 */
export const updateTrackerConfigSchema = z
  .object({
    schema: sceneTrackerDslSchema.optional(),
    autoMode: autoModeSchema.optional(),
    contextWindow: z.number().int().min(1).optional(),
    continuityLastN: z.number().int().min(0).optional(),
    injectionDepth: z.number().int().min(1).optional(),
    injectLastN: z.number().int().min(0).optional(),
    promptFormat: promptFormatSchema.optional(),
    useChatModel: z.boolean().optional(),
    generatePrompt: z.string().optional(),
    injectPrompt: z.string().optional(),
    providerProfileId: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
  })
  .strict();

export type SceneTrackerConfigInput = z.input<typeof sceneTrackerConfigSchema>;
export type SceneTrackerConfigParsed = z.output<typeof sceneTrackerConfigSchema>;
export type UpdateSceneTrackerConfig = z.input<typeof updateTrackerConfigSchema>;

/** Reserved segments re-exported for schema-level consumers/tests. */
export { SCENE_RESERVED_SEGMENTS, SCENE_TRACKER_LIMITS };
