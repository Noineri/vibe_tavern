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

// ─── Persona export (PR-4) ────────────────────────────────────────────────────
// Export is symmetric to ST import (st-persona-parser.ts). Two formats:
//   - 'st': SillyTavern power_user fragment (lossy — drops pronounForms declensions,
//          avatarDescription, includeAvatarInPrompt). Default (user premise: "move out").
//   - 'vt': VT-native lossless payload (full Persona + avatar bytes base64).

/** Query param for single + bulk export endpoints. */
export const personaExportQuerySchema = z.object({
  format: z.enum(["st", "vt"]).default("st"),
});

/** Bulk export additionally takes a comma-separated id list. */
export const personaExportBulkQuerySchema = personaExportQuerySchema.extend({
  ids: z.string().min(1),
});

/** A single avatar in the VT export payload (bytes base64-encoded for JSON). */
export const personaExportAvatarSchema = z.object({
  ext: z.string(),
  bytesBase64: z.string(),
});

/** VT-native lossless persona payload (version 1). */
export const personaExportVtSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  description: z.string(),
  pronouns: z.string().nullable(),
  pronounForms: z
    .object({
      subjective: z.string(),
      objective: z.string(),
      possessive: z.string(),
      possessivePronoun: z.string(),
      reflexive: z.string(),
    })
    .nullable(),
  avatarDescription: z.string().nullable(),
  includeAvatarInPrompt: z.boolean(),
  defaultForNewChats: z.boolean(),
  avatarThumb: personaExportAvatarSchema.nullable(),
  avatarFull: personaExportAvatarSchema.nullable(),
});
