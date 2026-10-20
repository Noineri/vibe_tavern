import { z } from "zod";
import { SERVICE_PROMPT_FIELD_KEYS } from "@vibe-tavern/domain";

export const servicePromptFieldKeySchema = z.enum(SERVICE_PROMPT_FIELD_KEYS);
export type ServicePromptFieldKeyValue = z.infer<typeof servicePromptFieldKeySchema>;

/** SC-8d: the overrides map is DERIVED from the domain's shared key list
 *  (one source — the pane, the db store, and this contract all read
 *  SERVICE_PROMPT_FIELD_KEYS). The previous hand-written key list here lagged
 *  seven keys behind the shared list, so prompts the pane listed refused to
 *  save with a 400. Strictness is kept via `z.strictObject`: unknown keys —
 *  the IPT-6-retired `image_*` fields included — are still rejected. */
const servicePromptOverrideShape = Object.fromEntries(
  SERVICE_PROMPT_FIELD_KEYS.map((key) => [key, z.string().optional()]),
) as Record<ServicePromptFieldKeyValue, z.ZodOptional<z.ZodString>>;

export const servicePromptOverridesSchema = z.strictObject(servicePromptOverrideShape);
export type ServicePromptOverrides = z.infer<typeof servicePromptOverridesSchema>;

export const servicePromptProfileSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  isDefault: z.boolean(),
  sortOrder: z.number(),
  overrides: servicePromptOverridesSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ServicePromptProfile = z.infer<typeof servicePromptProfileSchema>;

export const createServicePromptProfileRequestSchema = z.object({
  name: z.string().min(1),
  overrides: servicePromptOverridesSchema,
});
export type CreateServicePromptProfileRequest = z.infer<typeof createServicePromptProfileRequestSchema>;

export const updateServicePromptProfileRequestSchema = z.object({
  name: z.string().min(1).optional(),
  overrides: servicePromptOverridesSchema.optional(),
});
export type UpdateServicePromptProfileRequest = z.infer<typeof updateServicePromptProfileRequestSchema>;

export const servicePromptProfileListResponseSchema = z.object({
  profiles: z.array(servicePromptProfileSchema),
  activeProfileId: z.string().nullable(),
});
export type ServicePromptProfileListResponse = z.infer<typeof servicePromptProfileListResponseSchema>;

export const servicePromptProfileDetailResponseSchema = z.object({
  profile: servicePromptProfileSchema,
  resolved: z.record(
    servicePromptFieldKeySchema,
    z.object({ override: z.string().nullable(), default: z.string() }),
  ),
});
export type ServicePromptProfileDetailResponse = z.infer<typeof servicePromptProfileDetailResponseSchema>;

export const setActiveServicePromptProfileRequestSchema = z.object({
  profileId: z.string().nullable(),
});
export type SetActiveServicePromptProfileRequest = z.infer<typeof setActiveServicePromptProfileRequestSchema>;

export const reorderServicePromptProfilesSchema = z.object({
  updates: z.array(z.object({ id: z.string(), sortOrder: z.number() })),
});
export type ReorderServicePromptProfilesRequest = z.infer<typeof reorderServicePromptProfilesSchema>;
