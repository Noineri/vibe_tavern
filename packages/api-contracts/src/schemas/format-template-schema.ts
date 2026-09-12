import { z } from "zod";
import { generationFormatSchema } from "./prompt-preset-schema.js";

/**
 * Named custom format templates (LOCAL_SUPPORT_PLAN LS-10) — the
 * format-block counterpart of the sampler-set library (the LS-5 pattern):
 * user-saved sequence bundles selectable in the provider format block's auto
 * dropdown and managed with the same save/rename/delete chrome. A template
 * payload is the SAME ST instruct DSL shape the preset format carries
 * (`generationFormatSchema` — one shape everywhere; the inner `mode` is
 * stored as "manual" on save and ignored at render).
 */

/** Wire record — as served by GET /api/format-templates and mutations. */
export const formatTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sortOrder: z.number().int(),
  payload: generationFormatSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type FormatTemplate = z.infer<typeof formatTemplateSchema>;

export const formatTemplateListSchema = z.array(formatTemplateSchema);

export type FormatTemplateList = z.infer<typeof formatTemplateListSchema>;

/** Create from the manual editor's current sequences (the «save-as-new» flow). */
export const createFormatTemplateSchema = z.object({
  name: z.string().min(1),
  payload: generationFormatSchema,
});

export type FormatTemplateCreate = z.infer<typeof createFormatTemplateSchema>;

/** Partial update: rename (the morph) and/or overwrite the stored payload. */
export const updateFormatTemplateSchema = z.object({
  name: z.string().min(1).optional(),
  payload: generationFormatSchema.optional(),
});

export type FormatTemplateUpdate = z.infer<typeof updateFormatTemplateSchema>;
