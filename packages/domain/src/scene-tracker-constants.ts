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

// ---------------------------------------------------------------------------
// Config PATCH merge + read normalization (SCN-2)
// ---------------------------------------------------------------------------

/**
 * The settable fields of a {@link SceneTrackerConfig} PATCH — everything except
 * the server-managed `revision` and `schemaHash`, all optional. Structurally
 * mirrors the api-contracts `updateTrackerConfigSchema` input (db cannot import
 * api-contracts, so the store types the patch against this domain type); only
 * present keys override on merge.
 */
export type SceneTrackerConfigPatch = Partial<Omit<SceneTrackerConfig, "revision" | "schemaHash">>;

/** A finite integer >= `min` floored, else `fallback`. Used by read-time clamps. */
function finiteIntOr(value: unknown, min: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min
    ? Math.floor(value)
    : fallback;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a raw stored tracker value into a complete, integrity-correct
 * {@link SceneTrackerConfig}. Missing/invalid fields fall back to the fixed
 * defaults; `schemaHash` is always recomputed from the schema so a stored hash
 * can never drift from the schema it claims; `revision` is preserved when a
 * finite non-negative integer is present (else 0).
 *
 * This is the lazy no-migration path for chats whose `insightsConfigJson`
 * predates the `tracker` sub-object: the store calls it on the existing value
 * before applying a PATCH, and the client calls it on read so old chats
 * surface defaults. Full DSL validation (limits, reserved segments) is the
 * route's job via api-contracts; this only defends against corrupt/partial
 * stored JSON, so it never throws.
 */
export function normalizeSceneTrackerConfig(raw: unknown): SceneTrackerConfig {
  const base = createDefaultSceneTrackerConfig();
  if (!isPlainRecord(raw)) return base;
  const schema: SceneTrackerDsl = isPlainRecord(raw.schema) ? (raw.schema as SceneTrackerDsl) : base.schema;
  return {
    schema,
    autoMode: raw.autoMode === SCENE_AUTO_MODE.manual ? SCENE_AUTO_MODE.manual : base.autoMode,
    contextWindow: finiteIntOr(raw.contextWindow, 1, base.contextWindow),
    continuityLastN: finiteIntOr(raw.continuityLastN, 0, base.continuityLastN),
    injectionDepth: finiteIntOr(raw.injectionDepth, 1, base.injectionDepth),
    injectLastN: finiteIntOr(raw.injectLastN, 0, base.injectLastN),
    promptFormat: raw.promptFormat === SCENE_PROMPT_FORMAT.xml ? SCENE_PROMPT_FORMAT.xml : base.promptFormat,
    useChatModel: typeof raw.useChatModel === "boolean" ? raw.useChatModel : base.useChatModel,
    generatePrompt: typeof raw.generatePrompt === "string" ? raw.generatePrompt : base.generatePrompt,
    injectPrompt: typeof raw.injectPrompt === "string" ? raw.injectPrompt : base.injectPrompt,
    providerProfileId: typeof raw.providerProfileId === "string" && raw.providerProfileId ? raw.providerProfileId : null,
    model: typeof raw.model === "string" && raw.model ? raw.model : null,
    revision: finiteIntOr(raw.revision, 0, 0),
    schemaHash: computeSceneSchemaHash(schema),
  };
}

/**
 * Apply a partial tracker config PATCH to a full existing config: shallow-merge
 * the settable top-level fields (a `schema` PATCH replaces the whole DSL — DSL
 * trees are never merged node-by-node), recompute `schemaHash` from the merged
 * schema, and bump the internal `revision`. Only sent keys override; unmentioned
 * fields are never reset. `revision`/`schemaHash` are recomputed here, never
 * taken from the PATCH. Mirrors ObjectiveService.updateObjectiveConfig's merge.
 */
export function applySceneTrackerConfigPatch(
  existing: SceneTrackerConfig,
  patch: SceneTrackerConfigPatch,
): SceneTrackerConfig {
  const schema = patch.schema ?? existing.schema;
  return {
    ...existing,
    ...patch,
    schema,
    schemaHash: computeSceneSchemaHash(schema),
    revision: existing.revision + 1,
  };
}

/**
 * Rewrite the `variantId` ownership field inside a serialized Scene record JSON
 * to point at a different immutable variant, preserving every other field
 * (schemaHash, configRevision, sourceHash, sceneState, modelId, generatedAt).
 *
 * Used by branch fork: the copied variant gets a fresh immutable id, but its
 * content is identical to the source, so the captured `sourceHash` still
 * matches and the record stays valid for the forked variant. Only the
 * ownership identity (`variantId`) must move. A null/unparseable input yields
 * null (a corrupt stored record is dropped on fork rather than carried into
 * the new branch as corruption) — this is deliberate handling, not a swallowed
 * error: fork must not propagate a record it cannot trust.
 */
export function rekeySceneRecordJson(json: string | null, newVariantId: string): string | null {
  if (!json) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  parsed.variantId = newVariantId;
  return JSON.stringify(parsed);
}
