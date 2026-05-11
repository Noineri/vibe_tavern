import { z } from "zod";

export const setPersonalLorebookSchema = z.object({
  enabled: z.boolean(),
});

export const updateLorebookSchema = z.object({
  chatId: z.string(),
  lorebookRaw: z.string(),
});

export const testActivationSchema = z.object({
  text: z.string(),
});

const loreEntryCoreSchema = z.object({
  title: z.string(),
  content: z.string(),
  keys: z.array(z.string()),
  secondaryKeys: z.array(z.string()),
  logic: z.string(),
  position: z.string(),
  depth: z.number(),
  priority: z.number(),
  stickyWindow: z.number(),
  cooldownWindow: z.number(),
  delayWindow: z.number(),
  enabled: z.boolean(),
});

export const createLoreEntrySchema = loreEntryCoreSchema.partial();

export const updateLoreEntrySchema = loreEntryCoreSchema.partial();
