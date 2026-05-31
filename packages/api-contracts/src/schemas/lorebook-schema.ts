import { z } from "zod";

export const setPersonalLorebookSchema = z.object({
  enabled: z.boolean(),
});

export const testActivationSchema = z.object({
  text: z.string(),
});

export const createLorebookSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(""),
  scopeType: z.string(),
  characterId: z.string().optional(),
  personaId: z.string().optional(),
  chatId: z.string().optional(),
  scanDepth: z.number().optional().default(50),
  tokenBudget: z.number().optional().default(2048),
  recursiveScanning: z.boolean().optional().default(false),
  maxRecursionSteps: z.number().optional().default(5),
  includeNames: z.boolean().optional().default(false),
  minActivations: z.number().optional().default(0),
  minActivationsDepthMax: z.number().optional().default(0),
  overflowAlert: z.boolean().optional().default(false),
  characterStrategy: z.number().optional().default(0),
  enabled: z.boolean().optional().default(true),
});

export const updateLorebookMetaSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  scanDepth: z.number().optional(),
  tokenBudget: z.number().optional(),
  recursiveScanning: z.boolean().optional(),
  maxRecursionSteps: z.number().optional(),
  includeNames: z.boolean().optional(),
  minActivations: z.number().optional(),
  minActivationsDepthMax: z.number().optional(),
  overflowAlert: z.boolean().optional(),
  characterStrategy: z.number().optional(),
  scopeType: z.string().optional(),
  enabled: z.boolean().optional(),
});

const loreEntryCoreSchema = z.object({
  title: z.string().optional().default(""),
  content: z.string().optional().default(""),
  keys: z.array(z.string()).optional().default([]),
  secondaryKeys: z.array(z.string()).optional().default([]),
  logic: z.string().optional().default("and_any"),
  position: z.string().optional().default("before_char"),
  depth: z.number().optional().default(4),
  priority: z.number().optional().default(10),
  order: z.number().optional().default(0),
  constant: z.boolean().optional().default(false),
  probability: z.number().optional().default(100),
  ignoreBudget: z.boolean().optional().default(false),
  role: z.string().optional().default("system"),
  groupName: z.string().optional().default(""),
  groupWeight: z.number().optional().default(1),
  prioritizeInclusion: z.boolean().optional().default(false),
  excludeRecursion: z.boolean().optional().default(false),
  preventRecursion: z.boolean().optional().default(false),
  delayUntilRecursion: z.boolean().optional().default(false),
  recursionLevel: z.number().optional().default(0),
  scanDepthOverride: z.number().nullable().optional().default(null),
  caseSensitive: z.boolean().optional().default(false),
  matchWholeWords: z.boolean().optional().default(false),
  characterFilter: z.array(z.string()).optional().default([]),
  characterFilterExclude: z.boolean().optional().default(false),
  triggers: z.array(z.string()).optional().default([]),
  matchSources: z.array(z.string()).optional().default([]),
  enabled: z.boolean().optional().default(true),
  stickyWindow: z.number().optional().default(0),
  cooldownWindow: z.number().optional().default(0),
  delayWindow: z.number().optional().default(0),
});

export const createLoreEntrySchema = loreEntryCoreSchema;

// Update schema: NO defaults — only provided fields are patched
const loreEntryUpdateSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  keys: z.array(z.string()).optional(),
  secondaryKeys: z.array(z.string()).optional(),
  logic: z.string().optional(),
  position: z.string().optional(),
  depth: z.number().optional(),
  priority: z.number().optional(),
  order: z.number().optional(),
  constant: z.boolean().optional(),
  probability: z.number().optional(),
  ignoreBudget: z.boolean().optional(),
  role: z.string().optional(),
  groupName: z.string().optional(),
  groupWeight: z.number().optional(),
  prioritizeInclusion: z.boolean().optional(),
  excludeRecursion: z.boolean().optional(),
  preventRecursion: z.boolean().optional(),
  delayUntilRecursion: z.boolean().optional(),
  recursionLevel: z.number().optional(),
  scanDepthOverride: z.number().nullable().optional(),
  caseSensitive: z.boolean().optional(),
  matchWholeWords: z.boolean().optional(),
  characterFilter: z.array(z.string()).optional(),
  characterFilterExclude: z.boolean().optional(),
  triggers: z.array(z.string()).optional(),
  matchSources: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  stickyWindow: z.number().optional(),
  cooldownWindow: z.number().optional(),
  delayWindow: z.number().optional(),
});

export const updateLoreEntrySchema = loreEntryUpdateSchema;

export const reorderLoreEntriesSchema = z.object({
  updates: z.array(z.object({
    id: z.string(),
    sortOrder: z.number(),
    position: z.string().optional(),
  })),
});

export const importLorebookSchema = z.object({
  format: z.enum(["st", "janitor"]).optional().default("st"),
  data: z.unknown(),
  mode: z.enum(["merge", "replace", "new"]).optional().default("new"),
  scopeType: z.string().optional().default("character"),
  characterId: z.string().optional(),
  personaId: z.string().optional(),
  chatId: z.string().optional(),
  fallbackName: z.string().optional(),
});
