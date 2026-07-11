import type { ContentStore } from '../content-store.js';
import { STORAGE_FOLDERS, IMAGE_EXTENSIONS } from '../file-store.js';
import {
  serializeCharacterFolder,
  parseCharacterFolder,
  type VtfCharacterContent,
  type FolderFileEntry,
} from '../vtf/index.js';
import { parseGreetingsIndex } from '../vtf/greetings.js';

// `data/characters/{id}/` is the on-disk home of a character: the VTF file set
// (profile.md + instructions.json + extensions.json + greetings/), the legacy
// card.json, the folder-resident avatars (avatar.{ext} / avatar-full.{ext}), and
// the non-active version snapshots under versions/{vid}/. `CharacterFolder` is
// the single FS-bound collaborator for that folder. It wraps a `ContentStore`
// and composes the PURE format codec from `vtf/` (serialize/parse) with the
// actual file reads/writes — it owns the folder LAYOUT and nothing else.
//
// Layering (no cycles):
//   vtf/index.ts        — pure format codec (no I/O, no DB) [already extracted]
//   CharacterFolder     — FS binding of the codec to data/characters/{id}/ (this file)
//   CharacterStore      — DB-row CRUD + Character↔Vtf projection + read-time
//                         migration orchestration; delegates every FS touch here
//
// CharacterFolder does NO DB access and never sees the store's `Character` type.
// It speaks in `VtfCharacterContent` / `FolderFileEntry`; the store performs the
// `Character ↔ VtfCharacterContent` projection (`toVtfContent` / `mergeVtfContent`)
// on either side of these calls. Hash-returning methods (`writeVtfFolder`,
// `ensureCardFile`) return the combined content hash so the store can stamp
// `{ contentHash, hasFileOnDisk }` on the DB row — the DB write is the store's
// job, the FS bytes + hash are this class's job.
//
// Read-time self-healing is NOT triggered here. The store's `getById` owns the
// migration gates (`!hasFileOnDisk`, `!avatarExt`, `!avatarFullExt`) and calls
// `ensureCardFile` / `migrateAvatar` / `migrateAvatarFull` only when a gate fires;
// this class just performs the FS work it is asked to do.

const FOLDER = STORAGE_FOLDERS.characters;

export class CharacterFolder {
  private readonly content: ContentStore;

  constructor(content: ContentStore) {
    this.content = content;
  }

  // ─── VTF content folder (profile.md + instructions.json + extensions.json + greetings/) ───

  /**
   * Serialize a character's content to the canonical VTF folder and return the
   * combined sha256 over the entry set (sorted by path). Greetings are rewritten
   * wholesale: the old `greetings/` subfolder is removed first to garbage-collect
   * stale files left by deleted alternates (rename-free ids mean content edits
   * reuse filenames, but removed alternates must not leave orphans).
   */
  async writeVtfFolder(id: string, content: VtfCharacterContent): Promise<string> {
    const entries = serializeCharacterFolder(content);
    await this.content.removeEntitySubfolder(FOLDER, id, 'greetings');
    for (const entry of entries) {
      await this.content.writeEntityTextFile(FOLDER, id, entry.path, entry.content);
    }
    return this.hashEntries(entries);
  }

  /**
   * Read the root VTF folder and, if it has a `profile.md`, parse it into a
   * {@link VtfCharacterContent}. Returns `null` when there is no `profile.md`
   * (legacy card.json-only or pre-VTF rows) or when the folder is empty — the
   * caller (the store) then falls back to the DB-row content. The `profile.md`
   * existence check is the fast-path that keeps non-VTF characters on a single
   * cheap read instead of a full folder parse.
   */
  async readVtfOverride(id: string): Promise<VtfCharacterContent | null> {
    const profileText = await this.content.readEntityTextFile(FOLDER, id, 'profile.md');
    if (profileText === null) return null;
    const entries = await this.readEntriesAt(id, '');
    if (entries.length === 0) return null;
    return parseCharacterFolder(entries);
  }

  /**
   * Read every VTF leaf file for an entity into a {@link FolderFileEntry} list.
   * `subdir` reads from a nested folder (e.g. `versions/{vid}`); the returned
   * entry `path` is always relative to the entity ROOT (no subdir prefix), so a
   * caller can write the entries back to any target unchanged.
   */
  async readEntriesAt(id: string, subdir: string): Promise<FolderFileEntry[]> {
    const prefix = subdir ? `${subdir}/` : '';
    const entries: FolderFileEntry[] = [];
    const profileMd = await this.content.readEntityTextFile(FOLDER, id, `${prefix}profile.md`);
    if (profileMd !== null) entries.push({ path: 'profile.md', content: profileMd });
    const instructionsJson = await this.content.readEntityTextFile(FOLDER, id, `${prefix}instructions.json`);
    if (instructionsJson !== null) entries.push({ path: 'instructions.json', content: instructionsJson });
    const extensionsJson = await this.content.readEntityTextFile(FOLDER, id, `${prefix}extensions.json`);
    if (extensionsJson !== null) entries.push({ path: 'extensions.json', content: extensionsJson });
    // Greetings are manifest-driven: read _index.yaml, then each referenced file.
    const indexYaml = await this.content.readEntityTextFile(FOLDER, id, `${prefix}greetings/_index.yaml`);
    if (indexYaml !== null) {
      entries.push({ path: 'greetings/_index.yaml', content: indexYaml });
      const manifest = parseGreetingsIndex(indexYaml);
      for (const row of manifest) {
        if (!row.file) continue;
        const body = await this.content.readEntityTextFile(FOLDER, id, `${prefix}greetings/${row.file}`);
        if (body !== null) entries.push({ path: `greetings/${row.file}`, content: body });
      }
    }
    return entries;
  }

  // ─── Legacy card.json migration (read-time self-healing FS mechanics) ───

  /**
   * Card-migration FS mechanics for `getById`'s `!hasFileOnDisk` gate: if a
   * legacy flat file exists, copy it forward into `{id}/card.json` and hash it;
   * otherwise write a fresh `card.json` from the supplied fallback (the store's
   * V3-shaped projection of the DB row). Either way returns the card's hash so
   * the store can stamp `{ contentHash, hasFileOnDisk: 1 }`. The store owns the
   * gate and the DB stamp; this method owns the file.
   */
  async ensureCardFile(id: string, fallbackCardJson: Record<string, unknown>): Promise<string> {
    const migrated = await this.content.migrateFlatToFolder(FOLDER, id, 'card');
    if (migrated) {
      const copied = await this.content.readEntityFile<unknown>(FOLDER, id, 'card');
      return this.content.hashContent(copied);
    }
    return this.content.writeEntityFile(FOLDER, id, 'card', fallbackCardJson);
  }

  // ─── Legacy avatar migration (read-time self-healing FS mechanics) ───

  /** Copy a legacy flat avatar asset into `{id}/avatar.{ext}`; return the ext, or null if the asset is gone. */
  async migrateAvatar(id: string, assetId: string): Promise<string | null> {
    return this.content.copyAssetToEntityFolder(assetId, FOLDER, id, 'avatar', IMAGE_EXTENSIONS);
  }

  /** Copy a legacy flat FULL avatar asset into `{id}/avatar-full.{ext}`; return the ext, or null if the asset is gone. */
  async migrateAvatarFull(id: string, assetId: string): Promise<string | null> {
    return this.content.copyAssetToEntityFolder(assetId, FOLDER, id, 'avatar-full', IMAGE_EXTENSIONS);
  }

  // ─── Folder-resident avatar copy (used by `duplicate`) ───

  /** Copy the folder-resident thumbnail avatar `{srcId}/avatar.{ext}` into `{dstId}/avatar.{ext}` (no-op if absent). */
  async copyAvatarFile(srcId: string, dstId: string, ext: string): Promise<void> {
    const buf = await this.content.readBinary(FOLDER, srcId, `avatar.${ext}`);
    if (buf) {
      await this.content.writeBinary(FOLDER, dstId, `avatar.${ext}`, new Uint8Array(buf));
    }
  }

  /** Copy the folder-resident FULL avatar `{srcId}/avatar-full.{ext}` into `{dstId}/avatar-full.{ext}` (no-op if absent). */
  async copyAvatarFullFile(srcId: string, dstId: string, ext: string): Promise<void> {
    const buf = await this.content.readBinary(FOLDER, srcId, `avatar-full.${ext}`);
    if (buf) {
      await this.content.writeBinary(FOLDER, dstId, `avatar-full.${ext}`, new Uint8Array(buf));
    }
  }

  // ─── Version folder snapshots (VTF Phase 3) ───
  // The active version's content lives at the entity root; non-active versions
  // are full folder snapshots under `versions/{vid}/`. These move the canonical
  // VTF file set between root and a version slot. `VersionStore` orchestrates
  // them and owns the `character_versions` DB rows; `getById` stays
  // version-agnostic (it always reads the root, which reflects the active version).

  /** Snapshot the current root VTF folder into `versions/{vid}/` (overwrites, GCs stale greetings). */
  async snapshotToVersion(id: string, versionId: string): Promise<void> {
    const entries = await this.readEntriesAt(id, '');
    // Clear the target slot first so a stale snapshot leaves no orphaned greeting files.
    await this.content.removeEntitySubfolder(FOLDER, id, `versions/${versionId}`);
    for (const entry of entries) {
      await this.content.writeEntityTextFile(FOLDER, id, `versions/${versionId}/${entry.path}`, entry.content);
    }
  }

  /** Restore a version snapshot from `versions/{vid}/` to the root folder (GCs root greetings first). */
  async restoreFromVersion(id: string, versionId: string): Promise<void> {
    const entries = await this.readEntriesAt(id, `versions/${versionId}`);
    if (entries.length === 0) return;
    // Clear root greetings first (GC); profile/instructions/extensions are overwritten in place.
    await this.content.removeEntitySubfolder(FOLDER, id, 'greetings');
    for (const entry of entries) {
      await this.content.writeEntityTextFile(FOLDER, id, entry.path, entry.content);
    }
  }

  /** Remove the `versions/{vid}/` subfolder. No-op if missing. */
  async removeVersionFolder(id: string, versionId: string): Promise<void> {
    await this.content.removeEntitySubfolder(FOLDER, id, `versions/${versionId}`);
  }

  /** True if a version snapshot with a `profile.md` exists at `versions/{vid}/`. */
  async versionExists(id: string, versionId: string): Promise<boolean> {
    return this.content.entityLeafExists(FOLDER, id, `versions/${versionId}/profile.md`);
  }

  // ─── Folder teardown ───

  /**
   * Remove the whole per-entity folder (card.json, profile.md, avatars, version
   * snapshots, future gallery/). Legacy flat files (`{id}.json` /
   * `{id}.{slug}.json`) are intentionally left in place by `deleteEntityFolder` —
   * copy-forward policy; they become harmless orphans.
   */
  async removeAll(id: string): Promise<void> {
    await this.content.deleteEntityFolder(FOLDER, id);
  }

  // ─── Internals ───

  /** Combined sha256 over canonical VTF entries (sorted by path, content concatenated with NUL/unit separators). */
  private hashEntries(entries: FolderFileEntry[]): string {
    const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const combined = sorted.map((e) => `${e.path}\u0000${e.content}`).join('\u0001');
    return this.content.hashText(combined);
  }
}
