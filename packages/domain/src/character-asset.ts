// ─── Character asset (media gallery) types ─────────────────────────────────
//
// A single image in a character's media gallery. Stored as a folder-resident
// binary at data/characters/{characterId}/gallery/{id}.{ext} — the row `id` IS
// the file identifier (there is no separate assetId; see CHARACTER_FOLDER_STORAGE
// and MEDIA_GALLERY_BACKEND_PLAN). `ext` and `mimeType` are stored per row so
// serve / vision-load read them directly without probing.

import type { CharacterAssetId, CharacterId } from "./ids.js";
import type { Timestamp } from "./entities.js";

/** A single image in a character's media gallery. Folder-resident (no flat assetId). */
export interface CharacterAsset {
  /** Gallery row id (primary key). Also the filename leaf: gallery/{id}.{ext}. */
  id: CharacterAssetId;
  /** Owning character id. */
  characterId: CharacterId;
  /** Stored file extension (jpg/png/gif/webp). File is at {characterId}/gallery/{id}.{ext}. */
  ext: string;
  /** MIME type (needed to build Attachment for vision describe + serve Content-Type). */
  mimeType: string;
  /** User-provided caption. */
  caption: string;
  /** Vision-generated or user-edited description. Null = not described. */
  description: string | null;
  /** D7: per-image prompt inclusion. Only described rows with this flag are injected into the prompt (gated by the character's master includeGalleryInPrompt toggle). */
  includeInPrompt: boolean;
  /** D8: crop geometry (percentages JSON, from react-easy-crop) carried by a
   * gallery row that was salvaged from a previous character avatar. Null for
   * ordinary gallery images. The gallery always displays the full
   * (uncropped) image; this field is pure metadata used only to pre-fill the
   * crop modal when restoring the former avatar, so the exact previous crop is
   * recreated without re-cropping. */
  avatarCropJson: string | null;
  /** Display order (drag-and-drop reorder). Lower = earlier. */
  order: number;
  /** Creation timestamp (ISO). */
  createdAt: Timestamp;
}
