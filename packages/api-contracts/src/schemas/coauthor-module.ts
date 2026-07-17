import { z } from "zod";

export const coauthorToolSetSchema = z.object({
  write_profile: z.boolean().optional(),
  edit_personality: z.boolean().optional(),
  edit_scenario: z.boolean().optional(),
  edit_examples: z.boolean().optional(),
  write_personality: z.boolean().optional(),
  write_scenario: z.boolean().optional(),
  write_examples: z.boolean().optional(),
  edit_greeting: z.boolean().optional(),
  add_alt_greeting: z.boolean().optional(),
  edit_alt_greeting: z.boolean().optional(),
  // ── Wave 4: proposal-only lore authoring (CTX-L1/L2). Lore tools are a new
  // scope, independent of the profile write_*/edit_* scope (CED-2). The three
  // non-delegation tools land in L1; the two AI-delegation toggles
  // (ai_write_lore_entry / ai_generate_lore_keys) are added in L2 alongside
  // their tool implementations.
  create_lorebook: z.boolean().optional(),
  create_lore_entry: z.boolean().optional(),
  set_lore_activation: z.boolean().optional(),
});

export type CoauthorToolSet = z.infer<typeof coauthorToolSetSchema>;

/**
 * A resolved Co-Author module as served to the client / consumed by the
 * prompt assembler. `basePrompt` is INLINE prompt text (not a file reference):
 * seed modules load their `.md` at registry init, user modules store prompt
 * text directly in the DB. `isBuiltIn` marks seed modules as read-only for the
 * editor UI (CS-25); user-created modules always have `isBuiltIn: false`.
 * `openingMessage` is seeded as the chat's first assistant turn on chat birth
 * (CS-29); empty string = co-author starts blank.
 */
export const coauthorModuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  basePrompt: z.string().min(1),
  openingMessage: z.string(),
  skillIds: z.array(z.string().min(1)),
  toolSet: coauthorToolSetSchema,
  maxSteps: z.number().int().min(1).max(20),
  isBuiltIn: z.boolean(),
});

export type CoauthorModule = z.infer<typeof coauthorModuleSchema>;

export const coauthorModuleListSchema = z.array(coauthorModuleSchema);

export const setCoauthorModuleSchema = z.object({
  moduleId: z.string().min(1).nullable(),
});

/**
 * Input for creating a user module. `id` is assigned by the store; `isBuiltIn`
 * is always `false` for user-created modules (enforced server-side, never
 * accepted from the client).
 */
export const coauthorModuleCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  basePrompt: z.string().min(1),
  openingMessage: z.string(),
  skillIds: z.array(z.string().min(1)),
  toolSet: coauthorToolSetSchema,
  maxSteps: z.number().int().min(1).max(20),
});

export type CoauthorModuleCreate = z.infer<typeof coauthorModuleCreateSchema>;

/** Partial update for a user module. Every field is optional. */
export const coauthorModuleUpdateSchema = coauthorModuleCreateSchema.partial();

export type CoauthorModuleUpdate = z.infer<typeof coauthorModuleUpdateSchema>;
