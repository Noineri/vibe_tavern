import { z } from "zod";

export const coauthorToolSetSchema = z.object({
  edit_profile: z.boolean().optional(),
  edit_section: z.boolean().optional(),
  edit_greeting: z.boolean().optional(),
  add_alt_greeting: z.boolean().optional(),
  edit_alt_greeting: z.boolean().optional(),
});

export type CoauthorToolSet = z.infer<typeof coauthorToolSetSchema>;

export const coauthorModuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  basePromptFile: z.string().min(1),
  skillIds: z.array(z.string().min(1)),
  toolSet: coauthorToolSetSchema,
  maxSteps: z.number().int().min(1).max(20),
});

export type CoauthorModule = z.infer<typeof coauthorModuleSchema>;

export const coauthorModuleListSchema = z.array(coauthorModuleSchema);

export const setCoauthorModuleSchema = z.object({
  moduleId: z.string().min(1).nullable(),
});
