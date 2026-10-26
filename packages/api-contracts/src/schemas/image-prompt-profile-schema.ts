import { z } from "zod";

import { IMAGE_GENERATION_MODES, IMAGE_PROMPT_FAMILY_IDS } from "@vibe-tavern/domain";

import { imagePromptTemplateCellSchema } from "./image-gen-schema.js";

// ─── Image prompt profiles (IF-1b — IMAGEGEN_FOLLOWUP_REPORT) ─────────────────
//
// A deliberate fork of the service-prompt profile contract surface with the
// flat field-key axis replaced by (rowKey | family) CELLS. The profile
// collection lives apart from service-prompt profiles and LLM presets.

/** The row axis of the cell keys: the eight generation modes, the shared
 *  negative row, and the assist row (SC-8d — `assist|prose` is the
 *  extraction-core override, `assist|<family>` that family's addendum
 *  override; mirrors the domain's ImagePromptVariantRowKey). */
const PROFILE_ROW_KEYS: readonly string[] = [...Object.values(IMAGE_GENERATION_MODES), "negative", "assist"];

/** Every legal `"rowKey|family"` composition, as a closed enum. */
const CELL_KEYS: readonly [string, ...string[]] = Array.from(
  PROFILE_ROW_KEYS.flatMap((rowKey) => IMAGE_PROMPT_FAMILY_IDS.map((family) => `${rowKey}|${family}`)),
) as [string, ...string[]];

export const imagePromptCellKeySchema = z.enum(CELL_KEYS);
export type ImagePromptCellKeyValue = z.infer<typeof imagePromptCellKeySchema>;

/** One cell's override payload. `body` min 1 mirrors the cell upsert
 *  contract — an emptied editor cell is the key's ABSENCE (reset to canon),
 *  never a blank override. `qualityText` null/absent = the family canon;
 *  only quality-authoring families may carry a string (adapter guard). */
export const imagePromptCellOverrideSchema = z.object({
  body: z.string().min(1),
  qualityText: z.string().nullable().optional(),
});
export type ImagePromptCellOverrideValue = z.infer<typeof imagePromptCellOverrideSchema>;

/** Partial by design: an absent key = that cell resolves to canon (the
 *  overrides-only contract — no blank-value convention, the key simply is
 *  not there). Unknown keys are rejected by the enum. */
export const imagePromptProfileOverridesSchema = z.partialRecord(imagePromptCellKeySchema, imagePromptCellOverrideSchema);
export type ImagePromptProfileOverridesValue = z.infer<typeof imagePromptProfileOverridesSchema>;

export const imagePromptProfileSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  isDefault: z.boolean(),
  sortOrder: z.number(),
  overrides: imagePromptProfileOverridesSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ImagePromptProfileValue = z.infer<typeof imagePromptProfileSchema>;

export const createImagePromptProfileRequestSchema = z.object({
  name: z.string().min(1),
  overrides: imagePromptProfileOverridesSchema.optional(),
});
export type CreateImagePromptProfileRequest = z.infer<typeof createImagePromptProfileRequestSchema>;

export const updateImagePromptProfileRequestSchema = z.object({
  name: z.string().min(1).optional(),
  overrides: imagePromptProfileOverridesSchema.optional(),
});
export type UpdateImagePromptProfileRequest = z.infer<typeof updateImagePromptProfileRequestSchema>;

export const imagePromptProfileListResponseSchema = z.object({
  profiles: z.array(imagePromptProfileSchema),
  activeProfileId: z.string().nullable(),
});
export type ImagePromptProfileListResponse = z.infer<typeof imagePromptProfileListResponseSchema>;

/** GET detail: the profile plus the PROFILE-SCOPED template catalog — the
 *  same shape as GET /api/image-gen/prompt-templates (tier-resolved cells,
 *  canon quality blocks, assist core + addenda), with every cell's custom
 *  tier sourced from THIS profile's overrides. The pane renders the Default
 *  profile view from the same shape (all cells canon). */
export const imagePromptProfileDetailResponseSchema = z.object({
  profile: imagePromptProfileSchema,
  catalog: z.object({
    cells: z.array(imagePromptTemplateCellSchema),
    qualityCanon: z.record(z.string(), z.string()),
    assist: z.object({
      core: z.string(),
      addenda: z.record(z.string(), z.string()),
      /** SC-8d: the assist parts' custom tier, sourced from THIS profile's
       *  overrides — `assist|prose` for the core, `assist|<family>` for the
       *  addendum. `text` null = canon (not customized). `addendaCustom` is
       *  keyed exactly like `addenda` (canon-addendum families only — prose
       *  has no addendum editor, the quality-layer precedent). */
      coreCustom: z.object({ text: z.string().nullable(), isCustomized: z.boolean() }),
      addendaCustom: z.record(z.string(), z.object({ text: z.string().nullable(), isCustomized: z.boolean() })),
    }),
  }),
});
export type ImagePromptProfileDetailResponse = z.infer<typeof imagePromptProfileDetailResponseSchema>;

export const setActiveImagePromptProfileRequestSchema = z.object({
  profileId: z.string().nullable(),
});
export type SetActiveImagePromptProfileRequest = z.infer<typeof setActiveImagePromptProfileRequestSchema>;

export const reorderImagePromptProfilesSchema = z.object({
  updates: z.array(z.object({ id: z.string(), sortOrder: z.number() })),
});
export type ReorderImagePromptProfilesRequest = z.infer<typeof reorderImagePromptProfilesSchema>;
