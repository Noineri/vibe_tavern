import { z } from "zod";

// ─── Closed vocabularies ──────────────────────────────────────────────────────

/**
 * ST regex placement codes, preserved numerically for card/preset import
 * parity (domain `REGEX_PLACEMENT`). `3` = SLASH_COMMAND is reserved: VT has
 * no slash-command surface today, so no VT call site ever requests it.
 */
export const regexPlacementSchema = z.union([
  z.literal(1), // USER_INPUT
  z.literal(2), // AI_OUTPUT
  z.literal(3), // SLASH_COMMAND — reserved, never requested by VT call sites
  z.literal(5), // WORLD_INFO
  z.literal(6), // REASONING
]);
export type RegexPlacementCode = z.infer<typeof regexPlacementSchema>;

/** How macros are substituted into the find pattern (ST `substituteRegex`). */
export const regexSubstituteSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export type RegexSubstituteCode = z.infer<typeof regexSubstituteSchema>;

/** UI-facing union of the four markdownOnly/promptOnly combinations (domain
 *  `RegexApplyTarget`). Expanded server-side via domain `applyTargetFlags`. */
export const regexApplyTargetSchema = z.enum(["persist", "display", "prompt", "display_prompt"]);
export type RegexApplyTargetValue = z.infer<typeof regexApplyTargetSchema>;

/** Binding targets for a regex preset (domain `REGEX_TARGET_TYPE`) — character
 *  and prompt preset only; persona excluded by design. */
export const regexTargetTypeSchema = z.enum(["character", "preset"]);
export type RegexTargetTypeValue = z.infer<typeof regexTargetTypeSchema>;

// ─── Create / update ─────────────────────────────────────────────────────────

export const createRegexPresetSchema = z.object({
  /** Human-readable preset name. */
  name: z.string().min(1),
  /** Find pattern in ST's `/pattern/flags` notation. */
  findRegex: z.string().min(1),
  /** Replacement; supports `{{match}}`, `$1`.. capture groups and `$<name>`. */
  replaceString: z.string().optional().default(""),
  /** Substrings stripped from each match before replacement (ST "Trim Out"). */
  trimStrings: z.array(z.string()).optional().default([]),
  /** Macro substitution mode into the find pattern: 0=NONE, 1=RAW, 2=ESCAPED. */
  substituteRegex: regexSubstituteSchema.optional().default(0),
  /** Disabled presets never run; imported embedded scripts land disabled. */
  disabled: z.boolean().optional().default(false),
  /** ST ephemerality flag: transform display only, never the stored message. */
  markdownOnly: z.boolean().optional().default(false),
  /** ST ephemerality flag: transform the prompt only, never the display. */
  promptOnly: z.boolean().optional().default(false),
  /** Re-run when an existing message is edited. */
  runOnEdit: z.boolean().optional().default(true),
  /** Depth window lower bound (`null` = unlimited; depth 0 = last message). */
  minDepth: z.number().int().nullable().optional(),
  /** Depth window upper bound (`null` = unlimited). */
  maxDepth: z.number().int().nullable().optional(),
  /** Hooks this preset runs at (ST numeric codes). Default = AI_OUTPUT only. */
  placement: z.array(regexPlacementSchema).optional().default([2]),
  /** Applies to every chat regardless of bindings (like global lorebooks). */
  isGlobal: z.boolean().optional().default(false),
  /** Deterministic application order within the resolved set. */
  sortOrder: z.number().optional().default(0),
});
export type CreateRegexPresetInput = z.infer<typeof createRegexPresetSchema>;

export const updateRegexPresetSchema = z.object({
  name: z.string().min(1).optional(),
  findRegex: z.string().min(1).optional(),
  replaceString: z.string().optional(),
  trimStrings: z.array(z.string()).optional(),
  substituteRegex: regexSubstituteSchema.optional(),
  disabled: z.boolean().optional(),
  markdownOnly: z.boolean().optional(),
  promptOnly: z.boolean().optional(),
  runOnEdit: z.boolean().optional(),
  minDepth: z.number().int().nullable().optional(),
  maxDepth: z.number().int().nullable().optional(),
  placement: z.array(regexPlacementSchema).optional(),
  isGlobal: z.boolean().optional(),
  sortOrder: z.number().optional(),
  /** Write-mode selector — expanded server-side into markdownOnly/promptOnly
   *  via domain `applyTargetFlags`. Absent = leave the flag pair untouched. */
  applyTarget: regexApplyTargetSchema.optional(),
});
export type UpdateRegexPresetInput = z.infer<typeof updateRegexPresetSchema>;

// ─── Links / resolution ───────────────────────────────────────────────────────

/** Replace-all binding payload for a regex preset (mirrors ScriptStore link API). */
export const setRegexLinksSchema = z.object({
  links: z.array(
    z.object({
      targetType: regexTargetTypeSchema,
      targetId: z.string().min(1),
    }),
  ),
});
export type SetRegexLinksInput = z.infer<typeof setRegexLinksSchema>;

/** Query params for resolving the active preset set for one chat turn. */
export const resolveActiveRegexQuerySchema = z.object({
  characterId: z.string().optional(),
  presetId: z.string().optional(),
});
export type ResolveActiveRegexQuery = z.infer<typeof resolveActiveRegexQuerySchema>;
