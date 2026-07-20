import type { ContentStore } from "../content-store.js";
import { STORAGE_FOLDERS } from "../file-store.js";
import { parseProfileMd } from "../vtf/profile-md.js";

/**
 * Character directory registry (HUMAN_READABLE_FOLDERS).
 *
 * The filesystem-owned authority that maps an immutable `CharacterId` to its
 * CURRENT on-disk directory name under `data/characters/`. Identity lives
 * inside each directory's canonical `profile.md` as `vt.storage_id` (stamped
 * by the storage write path — see HRF-3b), NOT in the DB and NOT in the
 * directory basename. The basename is presentation: it follows the character's
 * display name and may change on rename. This registry is what lets the store
 * find a character's files after a rename without storing a path in the DB.
 *
 * Scan model. {@link init} (or the first {@link resolve}) scans the IMMEDIATE
 * subdirectories of `data/characters/`, reads each `profile.md`, extracts
 * `vt.storage_id`, and builds `characterId → directoryName`. A directory
 * without `storage_id` is a legacy opaque-id folder (pre-migration): it is
 * mapped by its own name (`dirName → dirName`), preserving today's behavior
 * (`folder_name = ''` → folder == id) until HRF-5 migrates it.
 *
 * Resilience. {@link resolve} verifies the mapped path still exists; if it has
 * disappeared (out-of-band rename/delete) it rescans once and rediscovers the
 * directory by its `storage_id`. A brand-new character written after `init` is
 * found the same way (rescan-on-miss). Duplicate `storage_id`s across two
 * directories are a hard diagnostic ({@link DuplicateStorageIdError}) — the
 * registry never silently picks a winner. Orphan/unidentified directories are
 * never deleted; they are simply mapped by name and ignored if unused.
 *
 * Rename. {@link renameDirectory} is the cache-aware, collision-safe primitive
 * used by the HRF-4 directory lifecycle: it rejects an occupied destination,
 * delegates to `ContentStore.renameEntityFolder`, and updates the in-memory map
 * only after a successful rename.
 */
export class CharacterDirectoryRegistry {
  private readonly content: ContentStore;
  /** characterId → current directory name. Identity-keyed, not name-keyed. */
  private readonly byId = new Map<string, string>();
  private scanned = false;

  constructor(content: ContentStore) {
    this.content = content;
  }

  /** Scan `data/characters/` and (re)build the characterId → directory map. */
  async init(): Promise<void> {
    await this.scan();
  }

  /**
   * Scan immediate subdirectories, read each `profile.md`'s `vt.storage_id`,
   * and build the identity map. Throws {@link DuplicateStorageIdError} on a
   * duplicate identity (data corruption); never throws on missing folders,
   * missing `profile.md`, or absent `storage_id` (legacy fallback).
   */
  async scan(): Promise<void> {
    const dirs = await this.content.listSubdirs(STORAGE_FOLDERS.characters);
    const identified = new Map<string, string>(); // storage_id → dirName
    const legacyByName = new Map<string, string>(); // dirName → dirName (no storage_id)
    for (const dirName of dirs) {
      const profileText = await this.content.readEntityTextFile(STORAGE_FOLDERS.characters, dirName, "profile.md");
      const storageId = profileText ? parseProfileMd(profileText).storageId : null;
      if (storageId) {
        const existing = identified.get(storageId);
        if (existing !== undefined) {
          throw new DuplicateStorageIdError(storageId, [existing, dirName]);
        }
        identified.set(storageId, dirName);
      } else {
        // Legacy opaque-id folder (pre-migration): assume dir name == characterId.
        legacyByName.set(dirName, dirName);
      }
    }
    // Merge: identified (by storage_id) overrides legacy (by dir name) on a key
    // collision — the migrated directory is the character's current home, and a
    // stray old-name folder must not shadow it.
    this.byId.clear();
    for (const [name, dir] of legacyByName) this.byId.set(name, dir);
    for (const [id, dir] of identified) this.byId.set(id, dir);
    this.scanned = true;
  }

  /**
   * Resolve an immutable `CharacterId` to its current on-disk directory name.
   * Returns `null` when the character has no directory on disk. Triggers ONE
   * rescan when the character was not yet mapped or its mapped path has
   * disappeared (out-of-band rename/delete), so a renamed directory is
   * rediscovered by its `storage_id` without a server restart.
   */
  async resolve(characterId: string): Promise<string | null> {
    if (!this.scanned) await this.scan();
    const mapped = this.byId.get(characterId);
    if (mapped !== undefined) {
      // Verify the mapped path still exists (out-of-band rename/delete guard).
      if (await this.content.entityFolderExists(STORAGE_FOLDERS.characters, mapped)) return mapped;
      // Path disappeared — rescan once to rediscover by storage_id.
      await this.scan();
      return this.byId.get(characterId) ?? null;
    }
    // Not mapped — rescan once (brand-new character written after init, or a
    // directory renamed out-of-band to a name this registry hasn't seen).
    await this.scan();
    return this.byId.get(characterId) ?? null;
  }

  /**
   * Rename a character's directory, rejecting an occupied destination. Updates
   * the in-memory map only AFTER a successful rename. The caller (HRF-4
   * lifecycle) supplies the already-collision-resolved name; this method does
   * not derive or suffix display names. No-op when old == new.
   */
  async renameDirectory(characterId: string, newDirName: string): Promise<void> {
    const oldDirName = await this.resolve(characterId);
    if (oldDirName === null) {
      throw new Error(`CharacterDirectoryRegistry.renameDirectory: character '${characterId}' has no directory`);
    }
    if (oldDirName === newDirName) return; // no-op
    // renameEntityFolder rejects an occupied destination and evicts old cache
    // entries atomically with the filesystem rename.
    await this.content.renameEntityFolder(STORAGE_FOLDERS.characters, oldDirName, newDirName);
    this.byId.set(characterId, newDirName);
  }
}

/**
 * Thrown by {@link CharacterDirectoryRegistry.scan} when two directories claim
 * the same `vt.storage_id`. This is data corruption (a manual directory copy,
 * or a half-applied migration), not a normal state: each character has exactly
 * one immutable id stamped in exactly one `profile.md`. The registry surfaces
 * the collision (both directory names) for repair rather than silently picking
 * a winner, which would silently orphan one character's files.
 */
export class DuplicateStorageIdError extends Error {
  constructor(
    readonly storageId: string,
    readonly directories: string[],
  ) {
    super(
      `Duplicate vt.storage_id '${storageId}' found in directories: ${directories.join(", ")}. ` +
        "Each character must own a unique storage id; rename or remove the duplicate directory.",
    );
    this.name = "DuplicateStorageIdError";
  }
}
