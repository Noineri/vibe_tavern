/**
 * Attach a gallery image as an immutable chat attachment (MEDIA_GALLERY_REWORK
 * R5 / D1). The bytes move SERVER-SIDE: the backend copies the gallery row's
 * file into the general asset store (`data/assets/{assetId}`) via the
 * `promote-to-attachment` endpoint and returns a flat-attachment descriptor.
 * The resulting `Attachment` points at `data/assets/{assetId}`, so editing or
 * deleting the gallery image later never breaks the sent message (the core
 * data-integrity invariant from MEDIA_GALLERY_BACKEND_PLAN).
 *
 * Pre-populates `description` from the gallery row's vision description (if any),
 * so a described gallery image keeps its description when attached.
 *
 * Replaces the previous client re-upload flow (fetch → File → uploadAsset),
 * which shipped the same bytes over the wire twice. See the D1 design decision
 * in MEDIA_GALLERY_REWORK_PLAN.md ("Option B — server-side promote").
 */
import type { Attachment, CharacterAsset } from "@vibe-tavern/domain";
import { getGatewayBaseUrl, getMobileToken } from "../api/client.js";

/** `POST /api/characters/:cid/assets/:rowId/promote-to-attachment` response. */
interface PromoteResult {
  assetId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

async function promoteGalleryAsset(characterId: string, rowId: string): Promise<PromoteResult> {
  const response = await fetch(
    `${getGatewayBaseUrl()}/api/characters/${characterId}/assets/${rowId}/promote-to-attachment`,
    { method: "POST", headers: getMobileToken() ? { Authorization: `Bearer ${getMobileToken()}` } : undefined },
  );
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Promote gallery asset failed (${response.status}): ${errorBody}`);
  }
  return response.json();
}

export async function attachGalleryImageAsFlatAsset(
  characterId: string,
  row: CharacterAsset,
): Promise<Attachment> {
  const { assetId, name, mimeType, sizeBytes } = await promoteGalleryAsset(characterId, row.id as string);
  return {
    id: crypto.randomUUID(),
    assetId,
    type: "image",
    name,
    mimeType,
    sizeBytes,
    description: row.description ?? undefined,
  };
}
