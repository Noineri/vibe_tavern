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
  /** Display order (drag-and-drop reorder). Lower = earlier. */
  order: number;
  /** Creation timestamp (ISO). */
  createdAt: Timestamp;
}
