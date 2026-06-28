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

/** The ST-extension pronoun declension shape (verified against a real ST backup file).
 *  Same 5 forms as PronounForms, but ST uses camelCase posDet / posPro keys. */
export const stPronounSchema = z.object({
  subjective: z.string(),
  objective: z.string(),
  posDet: z.string(),
  posPro: z.string(),
  reflexive: z.string(),
});

/** SillyTavern backup/restore persona shape (top-level, not settings.json power_user).
 *  Verified 2026-06-27 against an actual `personas_<date>.json` export:
 *  - `personas` maps avatar-key → name (string).
 *  - `persona_descriptions` maps key → descriptor; position/depth/role/lorebook/title
 *    are ST injection knobs we emit with neutral defaults (the import side ignores them).
 *  - `pronoun` is the Wolfsblvt extension field; absent on older backups.
 *  - `default_persona` is the key of the default persona (or empty). */
export const stPersonaBackupSchema = z.object({
  personas: z.record(z.string(), z.string()),
  persona_descriptions: z.record(
    z.string(),
    z.object({
      description: z.string().optional().default(""),
      position: z.number().optional().default(0),
      depth: z.number().optional().default(2),
      role: z.number().optional().default(0),
      lorebook: z.string().optional().default(""),
      title: z.string().optional().default(""),
      pronoun: stPronounSchema.optional().nullable(),
    }).passthrough(),
  ),
  default_persona: z.string().optional().default(""),
}).passthrough();

/** Bulk VT export: an array of VT payloads (symmetric with the ST backup in being
 *  a single self-contained JSON file). */
export const personaExportVtBulkSchema = z.array(personaExportVtSchema);
