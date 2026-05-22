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
});

export const updateLorebookMetaSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  scanDepth: z.number().optional(),
  tokenBudget: z.number().optional(),
  recursiveScanning: z.boolean().optional(),
  scopeType: z.string().optional(),
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

export const updateLoreEntrySchema = loreEntryCoreSchema;

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
