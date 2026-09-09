import { z } from "zod";

/**
 * Generation format (LOCAL_SUPPORT_PLAN LS-3a): the prompt preset's TC
 * string-shape glue. Absent = auto (back-compat with pre-LS-3 presets).
 * Manual sequences mirror the ST instruct DSL near 1:1 (camelCase); every
 * field is optional and an absent/empty string renders as "".
 * Deliberately NO stop-sequence field here — imported stops land in the
 * EXISTING provider stop-sequences setting (owner correction 2026-09-09).
 */
const generationFormatSchema = z.object({
  mode: z.enum(["auto", "manual"]),
  inputSequence: z.string().optional(),
  outputSequence: z.string().optional(),
  firstOutputSequence: z.string().optional(),
  lastOutputSequence: z.string().optional(),
  systemSequence: z.string().optional(),
  systemSequencePrefix: z.string().optional(),
  systemSequenceSuffix: z.string().optional(),
  inputSuffix: z.string().optional(),
  outputSuffix: z.string().optional(),
  systemSuffix: z.string().optional(),
  wrap: z.boolean().optional(),
  namesBehavior: z.enum(["force", "always", "never"]).optional(),
});

const promptPresetCoreSchema = z.object({
  name: z.string(),
  system: z.string().optional(),
  jailbreak: z.string().optional(),
  prefill: z.string().optional(),
  authorsNote: z.string().optional(),
  authorsNoteDepth: z.number().optional(),
  authorsNotePosition: z.enum(["in_prompt", "in_chat", "after_chat"]).optional(),
  authorsNoteRole: z.enum(["system", "user", "assistant"]).optional(),
  summary: z.string().optional(),
  tools: z.string().optional(),
  nsfw: z.string().optional(),
  enhanceDefinitions: z.string().optional(),
  customInjections: z.array(z.unknown()).optional(),
  promptOrder: z.array(z.object({
    identifier: z.string(),
    enabled: z.boolean(),
    order: z.number().optional(),
    kind: z.enum(["built_in", "custom"]).optional(),
    zone: z.enum(["before_chat", "in_chat", "after_chat"]).optional(),
    depth: z.number().nullable().optional(),
    role: z.enum(["system", "user", "assistant"]).optional(),
  })).optional(),
  advancedMode: z.boolean().optional(),
  /** Per-send prefill entry point (LS-8). Default false. */
  perSendPrefillEnabled: z.boolean().optional(),
  mergeConsecutiveRoles: z.boolean().optional(),
  scriptAiSystemPrompt: z.string().optional(),
  aiAssistantPrompts: z.string().optional(),
  // `null` = clear back to auto (the update path needs an explicit clear);
  // absent = untouched on update, auto on create.
  generationFormat: generationFormatSchema.nullable().optional(),
});

export const createPromptPresetSchema = promptPresetCoreSchema;

export const updatePromptPresetSchema = promptPresetCoreSchema.partial();

export const setPromptPresetSchema = z.object({
  promptPresetId: z.string(),
});

export const reorderPromptPresetsSchema = z.object({
  updates: z.array(z.object({
    id: z.string(),
    sortOrder: z.number(),
  })),
});
