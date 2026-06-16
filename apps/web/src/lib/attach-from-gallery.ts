/**
 * Attach a gallery image as an immutable chat attachment (MEDIA_GALLERY_FRONTEND
 * F4). This is a COPY, not a reference: we fetch the served bytes, build a File,
 * and re-upload it as a flat asset via {@link uploadAsset}. The resulting
 * `Attachment` points at `data/assets/{assetId}`, so editing or deleting the
 * gallery image later never breaks the sent message (the core data-integrity
 * invariant from MEDIA_GALLERY_BACKEND_PLAN).
 *
 * Pre-populates `description` from the gallery row's vision description (if any),
 * so a described gallery image keeps its description when attached.
 */
import type { Attachment, CharacterAsset } from "@vibe-tavern/domain";
import { serveCharacterAssetUrl } from "../api/gallery-api.js";
import { uploadAsset } from "../api/asset-api.js";

export async function attachGalleryImageAsFlatAsset(
  characterId: string,
  row: CharacterAsset,
): Promise<Attachment> {
  const url = serveCharacterAssetUrl(characterId, row.id as string);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Could not load gallery image (${res.status})`);
  }
  const blob = await res.blob();
  const baseName = row.caption?.trim() || `gallery-${row.id as string}`;
  const file = new File([blob], `${baseName}.${row.ext}`, { type: row.mimeType });
  const { assetId } = await uploadAsset(file);
  return {
    id: crypto.randomUUID(),
    assetId,
    type: "image",
    name: file.name,
    mimeType: row.mimeType,
    sizeBytes: file.size,
    description: row.description ?? undefined,
  };
}
