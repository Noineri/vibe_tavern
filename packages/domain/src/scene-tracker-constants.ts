/**
 * Scene Tracker — strict bounded DSL, generated-data limits, and config
 * defaults (SCENE_TRACKER_PLAN, Wave 1 / SCN-1).
 *
 * This module is the leaf-layer source of truth for the shape grammar, the
 * central visible limits, the reserved path segments, the two small enums,
 * the canonical schema hash, and the fixed config defaults. The matching Zod
 * validators live in `@vibe-tavern/api-contracts` (`tracker-schema.ts`) and
 * import these constants so schema validation, generated-data validation, the
 * editor, and the renderer all share one set of numbers.
 *
 * Dependency note: `SceneTrackerConfig` / `SceneTrackerRecord` (the persisted
 * records) are declared in `entities.ts` because every other entity interface
 * lives there; they `import type` the grammar + enums from this file. This
 * file only `import type`s those interfaces back, so the two modules have a
 * type-only (erased) relationship and no runtime cycle.
 */

import type { SceneTrackerConfig } from "./entities.js";

// ---------------------------------------------------------------------------
// Central visible limits
// ---------------------------------------------------------------------------

/**
 * The single source of truth for every Scene Tracker bound. Shared by the DSL
 * validator, the generated-data validator, the editor, and the renderer, so a
 * limit change is felt everywhere at once. Validation errors name the exceeded
 * limit; there is no hidden renderer-only truncation or cap.
 */
export const SCENE_TRACKER_LIMITS = {
  /** Maximum nesting depth of the schema (a leaf directly under the root is depth 1). */
  maxDepth: 8,
  /** Maximum keys a single object node (or the root) may declare. */
  maxKeysPerObject: 64,
  /** Maximum total schema nodes across the whole DSL tree. */
  maxTotalNodes: 256,
  /** Maximum items a generated homogeneous array may carry. */
  maxArrayItems: 64,
  /** Maximum length of a generated string leaf. */
  maxStringLength: 4000,
} as const;

export type SceneTrackerLimit = keyof typeof SCENE_TRACKER_LIMITS;

// ---------------------------------------------------------------------------
// Reserved path segments
// ---------------------------------------------------------------------------

/**
 * Segments that are never allowed as an object key or an edit-path segment.
 *
 * `$type` is the DSL discriminator (allowing it as a field name would collide
 * with the grammar itself); `__proto__`, `prototype`, and `constructor` are
 * blocked so a user-authored shape can never describe a prototype-pollution
 * path. The editor, the dotted edit paths, and both validators reject these.
 */
export const SCENE_RESERVED_SEGMENTS = ["$type", "__proto__", "prototype", "constructor"] as const;

export type SceneReservedSegment = (typeof SCENE_RESERVED_SEGMENTS)[number];

export function isReservedSceneSegment(segment: string): boolean {
  return (SCENE_RESERVED_SEGMENTS as readonly string[]).includes(segment);
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * When the Scene Tracker auto-generates a record.
 *
 * - `assistant` (default) — auto-generate after every qualifying freshly
 *   committed assistant response (the `message.appended` assistant event).
 * - `manual` — never auto-generate; the user drives Generate/Update from the
 *   header. The feature stays on, only the automatic trigger is suppressed.
 */
export const SCENE_AUTO_MODE = {
  assistant: "assistant",
  manual: "manual",
} as const;

export type SceneAutoMode = (typeof SCENE_AUTO_MODE)[keyof typeof SCENE_AUTO_MODE];

/**
 * How the validated `sceneState` block is serialized for main-model injection.
 *
 * Scene generation output is ALWAYS strict schema-validated JSON; this only
 * controls the serialization of the validated block sent to the main model.
 * XML serialization escapes keys and values.
 */
export const SCENE_PROMPT_FORMAT = {
  json: "json",
  xml: "xml",
} as const;

export type ScenePromptFormat = (typeof SCENE_PROMPT_FORMAT)[keyof typeof SCENE_PROMPT_FORMAT];

// ---------------------------------------------------------------------------
// Shape grammar (DSL) types
// ---------------------------------------------------------------------------

/**
 * One node of the Scene Tracker shape grammar — the user-authored DSL that
 * describes the structure the model must fill.
 *
 * The grammar is intentionally narrow (not JSON Schema): primitive leaves,
 * nested objects, homogeneous arrays described by a single item template, and
 * an exact ranged-number descriptor. A `number` node is either unbounded
 * (`{ $type: "number" }`) or ranged (`{ $type: "number", min, max }`) — the
 * validator enforces both-or-neither and `min <= max`.
 *
 * `$type` is the discriminator; it is also a reserved key name, so it can
 * never appear as a user field.
 */
export type SceneTrackerSchemaNode =
  | { $type: "string" }
  | { $type: "number"; min?: number; max?: number }
  | { $type: "boolean" }
  | { $type: "object"; properties: Record<string, SceneTrackerSchemaNode> }
  | { $type: "array"; items: SceneTrackerSchemaNode };

/**
 * The root of a Scene schema is a fields map (an implicit object): the natural
 * shape a user authors in the editor, e.g.
 * `{ health: { $type: "number", min: 0, max: 100 }, allies: { $type: "array", items: { $type: "string" } } }`.
 */
export type SceneTrackerDsl = Record<string, SceneTrackerSchemaNode>;

// ---------------------------------------------------------------------------
// DSL traversal helpers (pure)
// ---------------------------------------------------------------------------

/** Count every schema node in the DSL (each leaf/object/array counts as one). */
export function countSceneSchemaNodes(dsl: SceneTrackerDsl): number {
  let total = 0;
  for (const node of Object.values(dsl)) total += countSceneSchemaNode(node);
  return total;
}

function countSceneSchemaNode(node: SceneTrackerSchemaNode): number {
  switch (node.$type) {
    case "string":
    case "number":
    case "boolean":
      return 1;
    case "array":
      return 1 + countSceneSchemaNode(node.items);
    case "object": {
      let sum = 1;
      for (const child of Object.values(node.properties)) sum += countSceneSchemaNode(child);
      return sum;
    }
  }
}

/**
 * Maximum nesting depth of the schema. A leaf directly under the root is
 * depth 1; each object/array wrapper adds one. An empty object is depth 1.
 */
export function sceneSchemaDepth(dsl: SceneTrackerDsl): number {
  let max = 0;
  for (const node of Object.values(dsl)) max = Math.max(max, sceneSchemaNodeDepth(node));
  return max;
}

function sceneSchemaNodeDepth(node: SceneTrackerSchemaNode): number {
  switch (node.$type) {
    case "string":
    case "number":
    case "boolean":
      return 1;
    case "array":
      return 1 + sceneSchemaNodeDepth(node.items);
    case "object": {
      let max = 0;
      for (const child of Object.values(node.properties)) max = Math.max(max, sceneSchemaNodeDepth(child));
      return 1 + max;
    }
  }
}

/** Count every value node in generated scene data (each primitive/null/container counts as one). */
export function countSceneDataNodes(value: unknown): number {
  if (Array.isArray(value)) {
    let sum = 1;
    for (const item of value) sum += countSceneDataNodes(item);
    return sum;
  }
  if (value !== null && typeof value === "object") {
    let sum = 1;
    for (const child of Object.values(value as Record<string, unknown>)) sum += countSceneDataNodes(child);
    return sum;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Canonical schema hash
// ---------------------------------------------------------------------------

/**
 * Canonical, deterministic hash of a Scene schema. Used as the `schemaHash`
 * stamped on a {@link SceneTrackerConfig} and on every generated
 * `SceneTrackerRecord`: when the DSL is edited the hash is recomputed, so
 * records generated under an old schema become invisible/non-injectable until
 * regenerated (the record's stamped hash no longer equals the config's hash).
 *
 * The hash is a 64-bit FNV-1a over the stable canonical JSON of the DSL. It is
 * an identity check, not a cryptographic primitive — but for a bounded DSL the
 * collision space is negligible, and staleness is a best-effort signal backed
 * by the server-side source/config/ownership revalidation after the LLM await.
 * Pure JS (no `node:crypto`) so it runs unchanged in the browser too.
 */
export function computeSceneSchemaHash(dsl: SceneTrackerDsl): string {
  return fnv1a64Hex(stableStringify(dsl));
}

/** Deterministic JSON serialization: object keys sorted ascending, arrays in order. */
function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + stableStringify(v)).join(",") + "}";
  }
  return "null";
}

/** 64-bit FNV-1a → 16-character lowercase hex string. */
function fnv1a64Hex(input: string): string {
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Hash of the empty schema — the default `schemaHash` before any field is authored. */
export const EMPTY_SCENE_SCHEMA_HASH = computeSceneSchemaHash({});

// ---------------------------------------------------------------------------
// Fixed config defaults
// ---------------------------------------------------------------------------

/**
 * The fixed scalar defaults for a Scene Tracker config. `schema`, `revision`,
 * and `schemaHash` are assembled by {@link createDefaultSceneTrackerConfig};
 * they are kept out of this plain const because `schemaHash` depends on
 * `schema` and must be computed, never hard-coded.
 */
export const DEFAULT_SCENE_TRACKER_CONFIG = {
  autoMode: SCENE_AUTO_MODE.assistant,
  contextWindow: 6,
  continuityLastN: 3,
  injectionDepth: 1,
  injectLastN: 1,
  promptFormat: SCENE_PROMPT_FORMAT.json,
  useChatModel: true,
  generatePrompt: "",
  injectPrompt: "",
  providerProfileId: null,
  model: null,
  revision: 0,
} as const;

/**
 * A freshly-enabled Scene Tracker config: an empty schema, every scalar at its
 * fixed default, `revision` 0, and a `schemaHash` matching the empty schema.
 * Old chats normalize to this when the feature is first turned on (SCN-2).
 */
export function createDefaultSceneTrackerConfig(): SceneTrackerConfig {
  const schema: SceneTrackerDsl = {};
  return {
    schema,
    ...DEFAULT_SCENE_TRACKER_CONFIG,
    schemaHash: computeSceneSchemaHash(schema),
  };
}
