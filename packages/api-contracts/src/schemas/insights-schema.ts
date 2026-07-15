import { OBJECTIVE_TASK_STATUS } from "@vibe-tavern/domain";
import { z } from "zod";
import { sceneTrackerConfigSchema, updateTrackerConfigSchema } from "./tracker-schema.js";

/**
 * Per-chat Insights config (INSIGHTS_PLAN): the two opt-in feature toggles for
 * the Objective Tracker and Scene Tracker. Both are OFF by default; when both
 * are off the assistant message header renders exactly as today (zero added
 * DOM) and no prompt layer is injected.
 *
 * The underlying DB column (`insights_config_json`) is freeform JSON. INS-1b
 * validates only the toggles end-to-end; per-feature config fields added later
 * (INS-5 / INS-10 — injection depth, scene inject-last-N, model pick, custom
 * prompts) extend these schemas at that point.
 */
export const insightsConfigSchema = z.object({
  objectiveEnabled: z.boolean().default(false),
  trackerEnabled: z.boolean().default(false),
  /**
   * Scene Tracker per-chat config (SCENE_TRACKER_PLAN SCN-2). Nested inside the
   * toggles JSON column (`insights_config_json.tracker`); absent on chats stored
   * before the feature existed, so optional here — readers normalize via
   * `normalizeSceneTrackerConfig`. Deep-merged field-by-field on PATCH (see
   * updateInsightsConfigSchema); Objective toggles/state are never touched.
   */
  tracker: sceneTrackerConfigSchema.optional(),
});

/**
 * PATCH body — mirrors `updateMemorySettings`'s wrapper shape
 * (`{ autoSummaryConfig: {...} }`): the partial config nests under
 * `insightsConfig`. Inner fields are plain `.optional()` (NO `.default()`):
 * a default would silently reset an unmentioned toggle to false on patch,
 * breaking partial-update semantics. The adapter merges with the stored
 * config, so only sent keys override.
 */
export const updateInsightsConfigSchema = z.object({
  insightsConfig: z.object({
    objectiveEnabled: z.boolean().optional(),
    trackerEnabled: z.boolean().optional(),
    /**
     * Partial Scene config PATCH (default-free, mirrors updateObjectiveConfig):
     * the store deep-merges it field-by-field into the stored `tracker`
     * sub-object, bumps `revision`, and recomputes `schemaHash` atomically. A
     * `schema` PATCH replaces the whole DSL. Server-managed `revision`/
     * `schemaHash` are intentionally absent.
     */
    tracker: updateTrackerConfigSchema.optional(),
  }).optional(),
});

/** Objective Tracker — manual action request bodies (INSIGHTS_PLAN INS-4).
 *  generate/check take an optional pinned provider + model (default: the active
 *  provider + its default model). The CRUD bodies mirror ObjectiveTask fields. */
export const objectiveModelSchema = z.object({
  providerProfileId: z.string().optional(),
  model: z.string().optional(),
});

/** Join the background insight job(s) associated with one committed assistant message.
 *  `variantId` is optional: present when the caller is Scene-aware (joins the
 *  exact variant's Scene job + revalidates variant ownership + returns the
 *  scoped message patch); absent for Objective-only refresh (SCENE_TRACKER_PLAN SCN-9). */
export const insightsCompletionRefreshSchema = z.object({
  target: z.object({
    branchId: z.string().trim().min(1),
    messageId: z.string().trim().min(1),
    variantId: z.string().trim().min(1).optional(),
  }),
});

/** Immutable Scene ownership identity (SCN-9). `variantId` is canonical — a
 *  job, RPC, record, or UI action never retargets when a variant index compacts. */
export const sceneTargetSchema = z.object({
  branchId: z.string().trim().min(1),
  messageId: z.string().trim().min(1),
  variantId: z.string().trim().min(1),
});

/** Generate (or regenerate) a Scene record for the target variant via the LLM.
 *  Both the missing-record Generate and the existing-record Update actions hit
 *  this — the service overwrites the prior record ONLY on success, so failure
 *  never erases a valid record (in-place Update semantics). */
export const sceneGenerateSchema = z.object({
  target: sceneTargetSchema,
});

/** Manual structured edit of the target variant's scene state (no LLM).
 *  `sceneState` is a freeform object here; the service validates it strictly
 *  against the chat's current DSL (paths/ranges/limits/ownership) and throws
 *  path-specific errors on mismatch — nothing persists on validation failure. */
export const sceneEditSchema = z.object({
  target: sceneTargetSchema,
  sceneState: z.record(z.string(), z.unknown()),
});

/** Target-scoped Scene status / explicit cancel (SCN-9). Status is
 *  server-authoritative for reload/multi-tab hydration and edit preflight. */
export const sceneTargetBodySchema = z.object({
  target: sceneTargetSchema,
});

/** Non-persisting Scene preview (SCN-11): runs the full generate pipeline with a
 *  DRAFT config against the target variant and returns the would-be scene state
 *  WITHOUT committing (no `setSceneRecord`). The config editor uses it to trial
 *  a schema/prompt/model change against the live RP world before saving.
 *  `config` is the FULL draft (recomputes `schemaHash` via `.transform`), so an
 *  invalid DSL is rejected at this boundary — the route never reaches the LLM. */
export const scenePreviewSchema = z.object({
  target: sceneTargetSchema,
  config: sceneTrackerConfigSchema,
});

export const objectiveTaskStatusSchema = z.enum([
  OBJECTIVE_TASK_STATUS.pending,
  OBJECTIVE_TASK_STATUS.active,
  OBJECTIVE_TASK_STATUS.completed,
  OBJECTIVE_TASK_STATUS.abandoned,
]);

const nonEmptyDescriptionSchema = z.string().trim().min(1);

export const addObjectiveTaskSchema = z.object({
  description: nonEmptyDescriptionSchema,
});

export const updateObjectiveTaskSchema = z.object({
  description: nonEmptyDescriptionSchema.optional(),
  status: objectiveTaskStatusSchema.optional(),
});

export const reorderObjectiveTasksSchema = z.object({
  taskIds: z.array(z.string().trim().min(1)).min(1),
}).refine(({ taskIds }) => new Set(taskIds).size === taskIds.length, {
  message: "Task ids must be unique.",
  path: ["taskIds"],
});

export const setObjectiveDescriptionSchema = z.object({
  objectiveDescription: nonEmptyDescriptionSchema,
});

/** Objective Tracker — advanced config (INS-5): auto-check frequency, injection
 *  depth, and custom prompt overrides (empty → the `.md` asset default). All
 *  optional; the service merges + clamps (frequency >= 0, depth >= 1). */
export const updateObjectiveConfigSchema = z.object({
  autoCheckFrequency: z.number().int().min(0).optional(),
  contextWindow: z.number().int().min(1).optional(),
  injectionDepth: z.number().int().min(1).optional(),
  generatePrompt: z.string().optional(),
  checkPrompt: z.string().optional(),
  injectPrompt: z.string().optional(),
  useChatModel: z.boolean().optional(),
  providerProfileId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});

// Scene Tracker manual route bodies (SCN-9). generate / edit / status / cancel /
// delete all key off the immutable variant id (`sceneTargetSchema`); the
// provider/model come from the stored Scene config, never the request body.
