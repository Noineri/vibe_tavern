import { resolve } from "node:path";
import type { ContentStore, StorageFolder } from "@vibe-tavern/db";
import { IMAGE_EXTENSIONS, STORAGE_FOLDERS } from "@vibe-tavern/db";

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Audio uploads for chat voice notes (STT_PLAN ST-6). MediaRecorder
 *  containers first (webm/opus, ogg/opus, Safari mp4), then common files a
 *  user may attach by hand. `;codecs=` parameters are stripped by the
 *  mime normalization in upload() — keys here are the bare base types. */
const AUDIO_MIME_TO_EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
};

const EXT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  webm: "audio/webm",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
};

const ALLOWED_MIMES = new Set([...Object.keys(MIME_TO_EXT), ...Object.keys(AUDIO_MIME_TO_EXT)]);

/** Maximum upload size for chat attachments (20 MB — most providers cap
 *  images at this; a dictation-length voice clip is far below it). */
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

/** Strip MediaRecorder codec parameters (`audio/webm;codecs=opus` →
 *  `audio/webm`) so the lookup tables only carry base types. */
function normalizeMime(mime: string): string {
  return mime.split(";", 1)[0].trim().toLowerCase();
}

/** Resolve a stored image extension to its MIME type. Used when re-importing an
 *  existing image buffer (avatar salvage) as a gallery row — the buffer's type
 *  must be reconstructed from the stored ext since there is no upload header. */
export function extToMime(ext: string): string {
  return EXT_TO_MIME[ext.toLowerCase()] ?? "application/octet-stream";
}

export class AssetService {
  /**
   * Optional ContentStore for folder-resident avatars
   * (data/{characters|personas}/{id}/avatar.{ext}). Chat attachments and legacy
   * flat avatars keep using {@link upload}/{@link serve}/{@link assetsDir}.
   * Folder methods throw if this is unset (e.g. in bare test helpers).
   */
  constructor(
    private readonly assetsDir: string,
  private readonly contentStore: ContentStore | null = null,
  /**
   * Resolves a character id → its on-disk folder name (HUMAN_READABLE_FOLDERS).
   * Applied only to the `characters` storage folder; persona I/O is untouched
   * (persona folders stay opaque-id). Optional — bare test helpers construct
   * AssetService without it.
   */
  private readonly resolveCharacterFolder: ((characterId: string) => Promise<string>) | null = null,
  ) {}

  /** Resolve an entity id to its on-disk folder name. Character folders are
   *  human-readable (slug) post-HRF; persona folders stay opaque-id. No-op when
   *  no resolver is wired (bare test helpers) or the folder isn't `characters`. */
  private async resolveEntityId(folder: StorageFolder, entityId: string): Promise<string> {
    return folder === STORAGE_FOLDERS.characters && this.resolveCharacterFolder
      ? await this.resolveCharacterFolder(entityId)
      : entityId;
  }

  async upload(file: File): Promise<{ assetId: string; url: string }> {
    const mime = normalizeMime(file.type);
    if (!ALLOWED_MIMES.has(mime)) {
      throw new Error(`Unsupported attachment type: ${file.type}. Allowed: jpeg, png, gif, webp, webm, ogg, m4a, mp3, wav, flac audio.`);
    }
    const ext = MIME_TO_EXT[mime] ?? AUDIO_MIME_TO_EXT[mime];
    const assetId = `asset_${crypto.randomUUID().replace(/-/g, "")}`;
    const fileName = `${assetId}.${ext}`;
    const filePath = resolve(this.assetsDir, fileName);
    const buffer = new Uint8Array(await file.arrayBuffer());
    if (buffer.length > MAX_IMAGE_SIZE) {
      throw new Error(`Attachment too large: ${(buffer.length / (1024 * 1024)).toFixed(1)} MB. Maximum: 20 MB.`);
    }
    await Bun.write(filePath, buffer);
    return { assetId, url: `/api/assets/${assetId}` };
  }

  async serve(assetId: string): Promise<Response | null> {
    // Prevent path traversal
    if (assetId.includes("/") || assetId.includes("\\") || assetId.includes("..")) {
      return null;
    }
    for (const ext of Object.keys(EXT_TO_MIME)) {
      const filePath = resolve(this.assetsDir, `${assetId}.${ext}`);
      try {
        const bunFile = Bun.file(filePath);
        // Eagerly read the file to avoid TOCTOU race with cleanup() unlink:
        // new Response(Bun.file()) is lazy — the file is opened when the response
        // is sent, which can race with a pending unlink() from a concurrent delete.
        const buffer = new Uint8Array(await bunFile.arrayBuffer());
        if (buffer.length > 0) {
          return new Response(buffer, {
            headers: {
              "Content-Type": EXT_TO_MIME[ext],
              "Cache-Control": "public, max-age=31536000",
            },
          });
        }
      } catch {
        // try next extension
      }
    }
    return null;
  }

  /** Load an attachment asset as a Buffer (for vision gate image processing). */
  async loadBuffer(assetId: string): Promise<Buffer | null> {
    if (assetId.includes("/") || assetId.includes("\\") || assetId.includes("..")) {
      return null;
    }
    for (const ext of Object.keys(EXT_TO_MIME)) {
      const filePath = resolve(this.assetsDir, `${assetId}.${ext}`);
      try {
        const bunFile = Bun.file(filePath);
        const buffer = await bunFile.arrayBuffer();
        if (buffer.byteLength > 0) {
          return Buffer.from(buffer);
        }
      } catch {
        // try next extension
      }
    }
    return null;
  }

  cleanup(assetId: string | null | undefined): void {
    if (!assetId) return;
    for (const ext of Object.keys(EXT_TO_MIME)) {
      const filePath = resolve(this.assetsDir, `${assetId}.${ext}`);
      Bun.file(filePath).unlink().catch(() => {});
    }
  }

  // ─── Folder-resident images (per-entity) ────────────────────────────
  // Images written inside an entity folder as {id}/{leafBase}.{ext}. Avatars
  // use leafBase "avatar" ({id}/avatar.{ext}); gallery rows use
  // "gallery/{rowId}" ({id}/gallery/{rowId}.{ext}). The ext is derived from
  // the upload mime type and returned so the caller persists it (avatarExt /
  // character_assets.ext). Serve/load/delete take that stored ext directly — no
  // probing. Chat attachments keep using the flat upload/serve above.

  /** MimeType derived from a stored extension, or null if unknown. Used by
   *  describe paths that only have the ext (folder avatars) to build an
   *  Attachment.mimeType for the vision ImagePart. */
  mimeForExt(ext: string): string | null {
    return EXT_TO_MIME[ext] ?? null;
  }

  private requireContentStore(): ContentStore {
    if (!this.contentStore) {
      throw new Error("AssetService is not configured for folder storage (contentStore missing).");
    }
    return this.contentStore;
  }

  // ─── Folder images: private generalized helpers (leafBase = pre-ext part) ─

  private async writeFolderImage(
    folder: StorageFolder,
    entityId: string,
    leafBase: string,
    file: File,
  ): Promise<{ ext: string; mimeType: string }> {
    const mime = file.type;
    if (!ALLOWED_MIMES.has(mime)) {
      throw new Error(`Unsupported image type: ${mime}. Allowed: jpeg, png, gif, webp.`);
    }
    const buffer = new Uint8Array(await file.arrayBuffer());
    if (buffer.length > MAX_IMAGE_SIZE) {
      throw new Error(`Image too large: ${(buffer.length / (1024 * 1024)).toFixed(1)} MB. Maximum: 20 MB.`);
    }
    const ext = MIME_TO_EXT[mime];
    const f = await this.resolveEntityId(folder, entityId);
    await this.requireContentStore().writeBinary(folder, f, `${leafBase}.${ext}`, buffer);
    return { ext, mimeType: mime };
  }

  private async serveFolderImage(
    folder: StorageFolder,
    entityId: string,
    leafBase: string,
    ext: string,
  ): Promise<Response | null> {
    if (!this.contentStore) return null;
    const f = await this.resolveEntityId(folder, entityId);
    const buf = await this.contentStore.readBinary(folder, f, `${leafBase}.${ext}`);
    if (!buf) return null;
    const mime = EXT_TO_MIME[ext] ?? "application/octet-stream";
    // Copy Buffer bytes into a fresh ArrayBuffer-backed Uint8Array so the value
    // satisfies Response's BodyInit (a Buffer/Buffer-backed view does not).
    const body = new Uint8Array(buf);
    return new Response(body, {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "public, max-age=31536000",
      },
    });
  }

  private async loadFolderImageBuffer(
    folder: StorageFolder,
    entityId: string,
    leafBase: string,
    ext: string,
  ): Promise<Buffer | null> {
    if (!this.contentStore) return null;
    const f = await this.resolveEntityId(folder, entityId);
    return this.contentStore.readBinary(folder, f, `${leafBase}.${ext}`);
  }

  private async deleteFolderImage(
    folder: StorageFolder,
    entityId: string,
    leafBase: string,
    ext: string,
  ): Promise<void> {
    if (!this.contentStore) return;
    const f = await this.resolveEntityId(folder, entityId);
    await this.contentStore.deleteBinary(folder, f, `${leafBase}.${ext}`);
  }

  // ─── Avatars (leafBase = "avatar") ──────────────────────────────────

  /**
   * Write avatar bytes into the character folder at {id}/avatar.{ext}.
   * Returns the ext so the caller stores it in `avatarExt`.
   */
  async writeCharacterAvatar(characterId: string, file: File): Promise<{ ext: string }> {
    const r = await this.writeFolderImage(STORAGE_FOLDERS.characters, characterId, "avatar", file);
    return { ext: r.ext };
  }

  /** Persona variant — {id}/avatar.{ext} under personas/. */
  async writePersonaAvatar(personaId: string, file: File): Promise<{ ext: string }> {
    const r = await this.writeFolderImage(STORAGE_FOLDERS.personas, personaId, "avatar", file);
    return { ext: r.ext };
  }

  /** Serve a folder-resident character avatar. `ext` is the stored avatarExt. */
  async serveCharacterAvatar(characterId: string, ext: string): Promise<Response | null> {
    return this.serveFolderImage(STORAGE_FOLDERS.characters, characterId, "avatar", ext);
  }

  /** Persona variant. */
  async servePersonaAvatar(personaId: string, ext: string): Promise<Response | null> {
    return this.serveFolderImage(STORAGE_FOLDERS.personas, personaId, "avatar", ext);
  }

  /** Load a folder-resident character avatar as a Buffer (for vision describe). */
  async loadCharacterAvatarBuffer(characterId: string, ext: string): Promise<Buffer | null> {
    return this.loadFolderImageBuffer(STORAGE_FOLDERS.characters, characterId, "avatar", ext);
  }

  /** D8: load the folder-resident FULL (uncropped) character avatar as a Buffer.
   *  Used by avatar salvage to re-import the prior avatar's full into the gallery. */
  async loadCharacterAvatarFullBuffer(characterId: string, ext: string): Promise<Buffer | null> {
    return this.loadFolderImageBuffer(STORAGE_FOLDERS.characters, characterId, "avatar-full", ext);
  }

  /** Persona variant. */
  async loadPersonaAvatarBuffer(personaId: string, ext: string): Promise<Buffer | null> {
    return this.loadFolderImageBuffer(STORAGE_FOLDERS.personas, personaId, "avatar", ext);
  }

  /** Persona variant — folder-resident FULL (uncropped) avatar as a Buffer.
   *  Used by persona export. Mirrors loadCharacterAvatarFullBuffer. */
  async loadPersonaAvatarFullBuffer(personaId: string, ext: string): Promise<Buffer | null> {
    return this.loadFolderImageBuffer(STORAGE_FOLDERS.personas, personaId, "avatar-full", ext);
  }

  // ─── Full avatars (leafBase = "avatar-full") ───────────────────────
  // The uncropped original, stored alongside the thumbnail avatar.{ext}.
  // Used by the large display slots (top-bar preview, editor). When a character
  // has no separate full (no crop was made), avatarFullExt is null and the
  // thumbnail avatar.{ext} IS the original — callers fall back to it.

  /** Write the uncropped full avatar into {id}/avatar-full.{ext}. */
  async writeCharacterAvatarFull(characterId: string, file: File): Promise<{ ext: string }> {
    const r = await this.writeFolderImage(STORAGE_FOLDERS.characters, characterId, "avatar-full", file);
    return { ext: r.ext };
  }

  /** Persona variant — {id}/avatar-full.{ext} under personas/. */
  async writePersonaAvatarFull(personaId: string, file: File): Promise<{ ext: string }> {
    const r = await this.writeFolderImage(STORAGE_FOLDERS.personas, personaId, "avatar-full", file);
    return { ext: r.ext };
  }

  /** Serve the folder-resident full character avatar. `ext` is the stored avatarFullExt. */
  async serveCharacterAvatarFull(characterId: string, ext: string): Promise<Response | null> {
    return this.serveFolderImage(STORAGE_FOLDERS.characters, characterId, "avatar-full", ext);
  }

  /** Persona variant. */
  async servePersonaAvatarFull(personaId: string, ext: string): Promise<Response | null> {
    return this.serveFolderImage(STORAGE_FOLDERS.personas, personaId, "avatar-full", ext);
  }

  // ─── Character media gallery (leafBase = "gallery/{rowId}") ──────────
  // Gallery images live at {characterId}/gallery/{rowId}.{ext}. `rowId` is the
  // character_assets.id the caller already generated; there is no separate
  // assetId — the row id IS the file identifier (MEDIA_GALLERY_BACKEND_PLAN).

  /**
   * Write a gallery image into the character folder at
   * {characterId}/gallery/{rowId}.{ext}. `rowId` is the character_assets.id the
   * caller already generated. Returns ext + mimeType (also derivable, but
   * returned for symmetry with the avatar writers).
   */
  async writeGalleryImage(
    characterId: string,
    rowId: string,
    file: File,
  ): Promise<{ ext: string; mimeType: string }> {
    return this.writeFolderImage(STORAGE_FOLDERS.characters, characterId, `gallery/${rowId}`, file);
  }

  /** Serve a gallery image. Caller passes the stored ext. */
  async serveGalleryImage(characterId: string, rowId: string, ext: string): Promise<Response | null> {
    return this.serveFolderImage(STORAGE_FOLDERS.characters, characterId, `gallery/${rowId}`, ext);
  }

  /** Load a gallery image as a Buffer (vision describe). Caller passes stored ext. */
  async loadGalleryImageBuffer(characterId: string, rowId: string, ext: string): Promise<Buffer | null> {
    return this.loadFolderImageBuffer(STORAGE_FOLDERS.characters, characterId, `gallery/${rowId}`, ext);
  }

  /** Delete a single gallery image file. No-op if missing. Caller passes stored ext. */
  async deleteGalleryImage(characterId: string, rowId: string, ext: string): Promise<void> {
    await this.deleteFolderImage(STORAGE_FOLDERS.characters, characterId, `gallery/${rowId}`, ext);
  }

  /**
   * Migrate an existing flat avatar asset into the entity folder. Copy-forward:
   * the flat file under data/assets/{assetId}.{ext} is probed once (the one and
   * only probe, at migration time) and copied to {id}/avatar.{ext}. Returns the
   * discovered ext so the caller stores it in `avatarExt`. Null if the flat
   * asset is gone (caller leaves `avatarAssetId` as-is — the avatar 404s, same
   * as today). Never deletes the flat source.
   */
  async migrateFlatAvatarToFolder(
    owner: { kind: "character" | "persona"; id: string },
    assetId: string,
  ): Promise<{ ext: string } | null> {
    if (!this.contentStore) return null;
    const folder = owner.kind === "character" ? STORAGE_FOLDERS.characters : STORAGE_FOLDERS.personas;
    const entityId = await this.resolveEntityId(folder, owner.id);
    // Delegate to ContentStore so the probe-and-copy logic lives in one place
    // (packages/db) and is shared with the stores' lazy getById migration.
    const ext = await this.contentStore.copyAssetToEntityFolder(assetId, folder, entityId, "avatar", IMAGE_EXTENSIONS);
    return ext === null ? null : { ext };
  }
}
