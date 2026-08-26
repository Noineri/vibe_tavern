import { z } from "zod";
import { SERVICE_PROMPT_FIELD_KEYS } from "@vibe-tavern/domain";

export const servicePromptFieldKeySchema = z.enum(SERVICE_PROMPT_FIELD_KEYS);
export type ServicePromptFieldKeyValue = z.infer<typeof servicePromptFieldKeySchema>;

export const servicePromptOverridesSchema = z
  .object({
    script: z.string().optional(),
    dice_script: z.string().optional(),
    lore_entry: z.string().optional(),
    lore_keys: z.string().optional(),
    chat_impersonate: z.string().optional(),
    md_import: z.string().optional(),
    vision_describe: z.string().optional(),
    scene_schema: z.string().optional(),
    scene_rules: z.string().optional(),
    message_edit: z.string().optional(),
    message_merge: z.string().optional(),
    summary: z.string().optional(),
    objective_generate: z.string().optional(),
    objective_generate_goals: z.string().optional(),
    objective_check: z.string().optional(),
    scene_generate: z.string().optional(),
    coauthor_base: z.string().optional(),
    copilot_base: z.string().optional(),
    copilot_user_flow: z.string().optional(),
    interactive_rules: z.string().optional(),
    interactive_visual: z.string().optional(),
  })
  .strict();
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
