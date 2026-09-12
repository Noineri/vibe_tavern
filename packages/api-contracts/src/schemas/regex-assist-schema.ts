import { z } from "zod";

export const regexAssistArchetypeSchema = z.enum([
  "invisible",
  "code_wrappers",
  "history_hygiene",
  "model_noise",
  "tts_prep",
  "custom",
]);
export type RegexAssistArchetype = z.infer<typeof regexAssistArchetypeSchema>;

export const regexAssistRuleDraftSchema = z.object({
  name: z.string().min(1),
  findRegex: z.string().min(1),
  replaceString: z.string(),
  trimStrings: z.array(z.string()),
  applyTarget: z.enum(["persist", "display", "prompt", "display_prompt"]),
  depthMode: z.enum(["all", "recent", "older", "range"]),
  depthValue: z.number().int().min(1).optional(),
  explanation: z.string(),
  sampleText: z.string().optional(),
});
export type RegexAssistRuleDraft = z.infer<typeof regexAssistRuleDraftSchema>;

export const regexAssistRequestSchema = z.object({
  providerProfileId: z.string().min(1),
  model: z.string().optional(),
  task: z.string().min(1),
  archetype: regexAssistArchetypeSchema.optional().default("custom"),
  sampleText: z.string().optional(),
  currentRule: z
    .object({
      name: z.string().optional(),
      findRegex: z.string().optional(),
      replaceString: z.string().optional(),
      trimStrings: z.array(z.string()).optional(),
      applyTarget: z.string().optional(),
      depthMode: z.string().optional(),
      depthValue: z.number().optional(),
    })
    .optional(),
  previousAttempt: z
    .object({
      rule: regexAssistRuleDraftSchema,
      testResult: z.string(),
    })
    .optional(),
});
export type RegexAssistRequest = z.infer<typeof regexAssistRequestSchema>;

export const regexAssistResponseSchema = z.object({
  draft: regexAssistRuleDraftSchema,
  rawText: z.string().optional(),
});
export type RegexAssistResponse = z.infer<typeof regexAssistResponseSchema>;
