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
  avatarFullAssetId: z.string().nullable().optional(),
  avatarCropJson: z.string().nullable().optional(),
  // Avatar-appearance prompt injection (MEDIA_GALLERY). Personas have no
  // gallery, only the avatar toggle + description.
  includeAvatarInPrompt: z.boolean().optional(),
  avatarDescription: z.string().nullable().optional(),
});

export const setPersonaSchema = z.object({
  personaId: z.string(),
});
