/**
 * Persona export serialization (PR-4).
 *
 * Reads a persona row + resolves avatar bytes (thumbnail + full) into a neutral
 * {@link PersonaExportPayload}. Format shaping (ST `power_user` vs VT-native) is the
 * route layer's job (PR-5); this module is format-agnostic.
 *
 * Placement note: lives in the service layer, NOT in `persona-store.ts` (the plan's
 * suggested home), because resolving the legacy `avatarAssetId` avatar requires the
 * AssetService + characterAssets store, which the db-layer PersonaStore does not have.
 * The branch logic mirrors {@link PersonaAdapter.servePersonaAvatar} exactly.
 */

import type { PersonaRecord } from "@vibe-tavern/api-contracts";
import type { PronounForms } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import { resolvePronounForms } from "@vibe-tavern/prompt-pipeline";
import type { AssetService } from "../asset/asset-service.js";

/** A resolved avatar: its file extension (no dot) + raw image bytes. */
export interface PersonaAvatarExport {
  ext: string;
  bytes: Buffer;
}

/** Neutral persona export payload — the row plus both avatar paths, if present. */
export interface PersonaExportPayload {
  persona: PersonaRecord;
  avatarThumb: PersonaAvatarExport | null;
  avatarFull: PersonaAvatarExport | null;
}

const PNG_EXT = "png";

/**
 * Serialize a persona for export. Returns null when the persona does not exist.
 *
 * Avatar resolution:
 * - Thumbnail: folder-resident (`avatarExt`) wins; else legacy gallery asset
 *   (`avatarAssetId`); else null.
 * - Full: folder-resident only (`avatarFullExt`); the thumbnail is itself the
 *   uncropped original when no separate full exists, so a null full is lossless.
 */
export async function serializePersona(
  stores: StoreContainer,
  assetService: AssetService,
  id: string,
): Promise<PersonaExportPayload | null> {
  const persona = await stores.personas.getById(id);
  if (!persona) return null;

  const avatarThumb = await resolveThumbnail(stores, assetService, persona);
  const avatarFull = await resolveFull(assetService, persona);

  return { persona, avatarThumb, avatarFull };
}

async function resolveThumbnail(
  stores: StoreContainer,
  assetService: AssetService,
  persona: PersonaRecord,
): Promise<PersonaAvatarExport | null> {
  // Folder-resident (the modern path).
  if (persona.avatarExt) {
    const bytes = await assetService.loadPersonaAvatarBuffer(persona.id, persona.avatarExt);
    if (bytes) return { ext: persona.avatarExt, bytes };
    // Folder path declared but file missing — fall through to legacy, then null.
  }
  // Legacy flat avatar (gallery asset).
  if (persona.avatarAssetId) {
    const bytes = await assetService.loadBuffer(persona.avatarAssetId);
    if (bytes) {
      const ext = (await stores.characterAssets.getById(persona.avatarAssetId))?.ext ?? PNG_EXT;
      return { ext, bytes };
    }
  }
  return null;
}

async function resolveFull(
  assetService: AssetService,
  persona: PersonaRecord,
): Promise<PersonaAvatarExport | null> {
  if (!persona.avatarFullExt) return null;
  const bytes = await assetService.loadPersonaAvatarFullBuffer(persona.id, persona.avatarFullExt);
  return bytes ? { ext: persona.avatarFullExt, bytes } : null;
}

// ─── Format builders ─────────────────────────────────────────────────────────
// Both shapes are built from a neutral PersonaExportPayload (serializePersona).
// The ST format mirrors a real ST backup file's persona slice (verified 2026-06-27):
// top-level `personas` + `persona_descriptions` dicts keyed by avatar filename,
// plus a `default_persona` key. The VT format is the lossless v1 payload.

/** The 5-form pronoun shape ST stores (Wolfsblvt extension). VT's PronounForms
 *  uses possessive/possessivePronoun; ST uses posDet/posPro. */
function toStPronoun(forms: PronounForms): {
  subjective: string; objective: string; posDet: string; posPro: string; reflexive: string;
} {
  return {
    subjective: forms.subjective,
    objective: forms.objective,
    posDet: forms.possessive,
    posPro: forms.possessivePronoun,
    reflexive: forms.reflexive,
  };
}

/** A single persona's slice in the ST backup shape. */
export interface StPersonaSlice {
  personas: Record<string, string>;
  persona_descriptions: Record<string, {
    description: string;
    position: number;
    depth: number;
    role: number;
    lorebook: string;
    title: string;
    pronoun?: { subjective: string; objective: string; posDet: string; posPro: string; reflexive: string };
  }>;
}

/** Build one persona's contribution to the ST backup shape.
 *  `avatarKey` is the caller-chosen filename key (used to correlate the dict entries).
 *  Preset pronoun forms are expanded to the full 5-form ST shape via resolvePronounForms
 *  (ST always stores full declensions even for presets — that's how the extension reads them). */
export function buildStPersonaSlice(payload: PersonaExportPayload, avatarKey: string): StPersonaSlice {
  const { persona } = payload;
  const forms = resolvePronounForms({ pronouns: persona.pronouns, pronounForms: persona.pronounForms });
  return {
    personas: { [avatarKey]: persona.name },
    persona_descriptions: {
      [avatarKey]: {
        description: persona.description,
        position: 0,
        depth: 2,
        role: 0,
        lorebook: "",
        title: "",
        ...(forms ? { pronoun: toStPronoun(forms) } : {}),
      },
    },
  };
}

/** VT-native lossless payload (version 1). Avatars base64-encoded for JSON. */
export interface VtPersonaPayload {
  version: 1;
  name: string;
  description: string;
  pronouns: string | null;
  pronounForms: PronounForms | null;
  avatarDescription: string | null;
  includeAvatarInPrompt: boolean;
  defaultForNewChats: boolean;
  avatarThumb: { ext: string; bytesBase64: string } | null;
  avatarFull: { ext: string; bytesBase64: string } | null;
}

/** Build the VT lossless payload from a neutral export payload. */
export function buildVtPersonaPayload(payload: PersonaExportPayload): VtPersonaPayload {
  const { persona, avatarThumb, avatarFull } = payload;
  return {
    version: 1,
    name: persona.name,
    description: persona.description,
    pronouns: persona.pronouns,
    pronounForms: persona.pronounForms,
    avatarDescription: persona.avatarDescription,
    includeAvatarInPrompt: persona.includeAvatarInPrompt,
    defaultForNewChats: persona.defaultForNewChats,
    avatarThumb: avatarThumb ? { ext: avatarThumb.ext, bytesBase64: avatarThumb.bytes.toString("base64") } : null,
    avatarFull: avatarFull ? { ext: avatarFull.ext, bytesBase64: avatarFull.bytes.toString("base64") } : null,
  };
}

/** Merge multiple ST persona slices into the top-level ST backup shape. */
export function mergeStSlices(slices: Array<{ slice: StPersonaSlice; isDefault: boolean }>): StPersonaSlice & { default_persona: string } {
  const merged: StPersonaSlice & { default_persona: string } = {
    personas: {},
    persona_descriptions: {},
    default_persona: "",
  };
  for (const { slice, isDefault } of slices) {
    Object.assign(merged.personas, slice.personas);
    Object.assign(merged.persona_descriptions, slice.persona_descriptions);
    if (isDefault) {
      const key = Object.keys(slice.personas)[0];
      if (key) merged.default_persona = key;
    }
  }
  return merged;
}
