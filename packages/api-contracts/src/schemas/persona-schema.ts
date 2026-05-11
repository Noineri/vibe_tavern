import { z } from "zod";

export const createPersonaSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(""),
  pronouns: z.string().nullable().optional(),
  defaultForNewChats: z.boolean().optional(),
});

export const updatePersonaSchema = z.object({
  chatId: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  pronouns: z.string().nullable().optional(),
  avatarAssetId: z.string().nullable().optional(),
});

export const setPersonaSchema = z.object({
  personaId: z.string(),
});
