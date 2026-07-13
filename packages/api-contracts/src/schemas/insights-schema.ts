import { z } from "zod";

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
  }).optional(),
});
