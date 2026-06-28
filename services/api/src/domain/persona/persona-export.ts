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
import type { StoreContainer } from "@vibe-tavern/db";
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
