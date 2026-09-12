import { z } from "zod";
import { samplerPresetPayloadSchema } from "./provider-schema.js";

/**
 * Named sampler sets (LOCAL_SUPPORT_PLAN LS-5b). The payload is the SAME
 * bundle the sampler clipboard carried — `samplerPresetPayloadSchema` (= the
 * per-model overlay schema) IS the set value format; the clipboard trio
 * (schema + apply + extract) is the set engine, only the copy/paste buttons
 * were replaced by the set row. A set is an inert template: applying it
 * copies the values into the provider profile/overlay (copy-on-select).
 */

/** Wire record — as served by GET /api/sampler-sets and returned by mutations. */
export const samplerSetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sortOrder: z.number().int(),
  payload: samplerPresetPayloadSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type SamplerSet = z.infer<typeof samplerSetSchema>;

export const samplerSetListSchema = z.array(samplerSetSchema);

export type SamplerSetList = z.infer<typeof samplerSetListSchema>;

/** Create from the panel's current values (the «+» flow): name + extracted payload. */
export const createSamplerSetSchema = z.object({
  name: z.string().min(1),
  payload: samplerPresetPayloadSchema,
});

export type SamplerSetCreate = z.infer<typeof createSamplerSetSchema>;

/** Partial update: rename (pencil morph) and/or overwrite the stored payload (💾). */
export const updateSamplerSetSchema = z.object({
  name: z.string().min(1).optional(),
  payload: samplerPresetPayloadSchema.optional(),
});

export type SamplerSetUpdate = z.infer<typeof updateSamplerSetSchema>;

/**
 * Import body (upload button + mass-import prep): `name` + the RAW parsed
 * JSON file content. The backend sniffs the shape (VT-native set JSON vs ST
 * TextGen Settings file) and pre-maps ST spellings onto the VT payload —
 * see `parseStTextgen` in @vibe-tavern/import-export.
 */
export const importSamplerSetSchema = z.object({
  name: z.string().min(1),
  raw: z.unknown(),
});

export type SamplerSetImport = z.infer<typeof importSamplerSetSchema>;
