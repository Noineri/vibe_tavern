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
  /** characterId → confirmed current ON-DISK directory name. */
  private readonly byId = new Map<string, string>();
  /** First-write names reserved by create/duplicate but not yet confirmed on disk. */
  private readonly reservations = new Map<string, string>();
  /** Non-poisoning single-process queue: every directory mutation runs sequentially. */
  private mutationTail: Promise<void> = Promise.resolve();
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
    // Filesystem readdir order is unspecified; stable basename ordering makes
    // duplicate diagnostics and reconciliation suffix ownership deterministic.
    const dirs = (await this.content.listSubdirs(STORAGE_FOLDERS.characters)).sort();
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
    for (const [id, dir] of identified) {
      this.byId.set(id, dir);
      // A successful first write materializes profile.md with storage_id; scan
      // confirms it and retires the pending reservation. Reservations for other
      // in-flight writes intentionally survive the rescan.
      this.reservations.delete(id);
    }
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
    await this.serializeMutation(() => this.renameDirectoryUnlocked(characterId, newDirName));
  }

  /** The mutation implementation; callers already inside the queue use this to avoid nested-queue deadlock. */
  private async renameDirectoryUnlocked(characterId: string, newDirName: string, knownOldDir?: string): Promise<void> {
    const oldDirName = knownOldDir ?? await this.resolve(characterId);
    if (oldDirName === null) {
      throw new Error(`CharacterDirectoryRegistry.renameDirectory: character '${characterId}' has no directory`);
    }
    if (oldDirName === newDirName) return; // no-op
    // renameEntityFolder rejects an occupied destination and evicts old cache
    // entries atomically with the filesystem rename.
    await this.content.renameEntityFolder(STORAGE_FOLDERS.characters, oldDirName, newDirName);
    this.byId.set(characterId, newDirName);
    this.reservations.delete(characterId);
  }

  /**
   * Derive a collision-free directory name for a character from its display
   * name and commit it to the registry (HRF-4 directory lifecycle — used by
   * CharacterStore.create/duplicate before their first folder write).
   *
   * - Brand-new character (no directory yet): the name is reserved in-memory
   *   and returned; the caller MUST then create the folder (writeVtfFolder)
   *   under that name. A degenerate display name (no alphanumerics) falls back
   *   to the opaque characterId so no empty/invalid directory is ever created.
   * - Existing character whose derived name DIFFERS from its current directory:
   *   performs the cache-aware rename and updates the map.
   * - Derived name equals the current directory: no-op.
   *
   * The character's own current directory never counts as a collision, so a
   * rename to the same name (or a reclaim after a transient off-band change) is
   * safe. Collision suffixing is deterministic (`-2`, `-3`, …).
   */
  async ensureDirectory(characterId: string, displayName: string): Promise<string> {
    return this.serializeMutation(async () => {
      const base = sanitizeDirectoryName(displayName) || characterId;
      const resolved = await this.collisionResolve(base, characterId);
      const current = this.byId.get(characterId) ?? null;
      if (current !== null && this.sameDirectoryName(current, resolved)) return current; // existing-directory no-op
      if (current === null) {
        // Brand-new character: reserve separately from confirmed disk mappings.
        // A missing-id resolve() may rescan while the caller writes profile.md;
        // scan must not forget this in-flight collision claim.
        this.reservations.set(characterId, resolved);
        return resolved;
      }
      // Backward-compatible existing-character path; update() uses the explicit
      // write-before-rename method below so failed renames remain recoverable.
      await this.renameDirectoryUnlocked(characterId, resolved, current);
      return resolved;
    });
  }

  /**
   * Rename an EXISTING character directory for a new display name. Unlike
   * ensureDirectory's first-write reservation, this resolves the directory from
   * disk before deriving the target. CharacterStore calls it only AFTER writing
   * the canonical new profile into the old/current directory, so a failed
   * cosmetic rename leaves readable data and startup reconciliation can retry
   * from the profile's new name.
   */
  async renameForDisplayName(characterId: string, displayName: string): Promise<string> {
    return this.serializeMutation(async () => {
      const current = await this.resolve(characterId);
      if (current === null) {
        throw new Error(`CharacterDirectoryRegistry.renameForDisplayName: character '${characterId}' has no directory`);
      }
      const base = sanitizeDirectoryName(displayName) || characterId;
      const target = await this.collisionResolve(base, characterId);
      if (this.sameDirectoryName(target, current)) return current;
      await this.renameDirectoryUnlocked(characterId, target, current);
      return target;
    });
  }

  /**
   * Return a collision-free directory name for `base`, suffixing `-2`, `-3`, …
   * against actual on-disk directories AND in-memory reservations owned by
   * OTHER characters. The owner's own current directory never counts as a
   * collision. Does not mutate the map. (HRF-4.)
   */
  private async collisionResolve(base: string, ownerId: string): Promise<string> {
    // Windows paths are case-insensitive: an out-of-band `Andrea/` must occupy
    // the app candidate `andrea`. App-derived candidates are lowercase, but
    // actual disk entries may not be.
    const normalize = (name: string): string => name.toLowerCase();
    const taken = new Set<string>((await this.content.listSubdirs(STORAGE_FOLDERS.characters)).map(normalize));
    // The owner's own CONFIRMED directory never counts as a collision. A pending
    // reservation is not removed from actual disk occupancy: if an out-of-band
    // writer created that path after reservation, suffix rather than overwrite.
    const ownDir = this.byId.get(ownerId);
    if (ownDir !== undefined) taken.delete(normalize(ownDir));
    for (const [id, dir] of this.byId) {
      if (id !== ownerId) taken.add(normalize(dir));
    }
    for (const [id, dir] of this.reservations) {
      if (id !== ownerId) taken.add(normalize(dir));
    }
    if (!taken.has(normalize(base))) return base;
    let n = 2;
    while (taken.has(normalize(`${base}-${n}`))) n++;
    return `${base}-${n}`;
  }

  /** Serialize mutations without poisoning later work when one operation fails. */
  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation, operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Startup reconciliation (HRF-4): compare each character's directory
   * basename with the display name derived from its `profile.md` and rename
   * mismatches left by an interrupted/failed rename. Opaque-id directories
   * (basename === characterId — pre-HRF-4 / pre-migration) are skipped; HRF-5
   * migrates them. A directory whose basename IS the derived name or a valid
   * collision suffix of it is consistent and left alone. Safe to run on every
   * startup; a consistent tree yields no repairs. Individual rename failures
   * (e.g. an occupied destination) are reported with `failed: true`, not thrown
   * — the character stays readable (`storage_id` intact) and is retried next run.
   */
  async reconcile(): Promise<DirectoryRepair[]> {
    if (!this.scanned) await this.scan();
    const repairs: DirectoryRepair[] = [];
    // Snapshot the map — reconcile mutates it via renameDirectory.
    for (const [characterId, dirName] of [...this.byId]) {
      if (dirName === characterId) continue; // opaque-id dir → HRF-5
      const profileText = await this.content.readEntityTextFile(STORAGE_FOLDERS.characters, dirName, "profile.md");
      if (!profileText) continue;
      const expectedBase = sanitizeDirectoryName(parseProfileMd(profileText).profile.name ?? "");
      if (!expectedBase) continue; // degenerate name → leave as-is
      if (this.sameDirectoryName(dirName, expectedBase) || this.isCollisionSuffix(dirName, expectedBase)) continue;
      const target = await this.collisionResolve(expectedBase, characterId);
      if (target === dirName) continue; // collision-resolved to the same name
      try {
        await this.renameDirectory(characterId, target);
        repairs.push({ characterId, from: dirName, to: target });
      } catch (error) {
        // Occupied destination or filesystem error — surface as a failed
        // repair; the character remains readable, retried next startup.
        repairs.push({
          characterId,
          from: dirName,
          to: target,
          failed: true,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return repairs;
  }

  /** Portable path equality: Windows is case-insensitive, so all platforms honor that stricter identity rule. */
  private sameDirectoryName(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase();
  }

  /** True when `dirName` is `base` followed by a `-<digits>` collision suffix (e.g. `oliver-2`). */
  private isCollisionSuffix(dirName: string, base: string): boolean {
    const m = dirName.toLowerCase().match(/^(.+)-(\d+)$/);
    return m !== null && m[1] === base.toLowerCase();
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

/** One directory rename performed (or attempted) by {@link CharacterDirectoryRegistry.reconcile}. */
export interface DirectoryRepair {
  characterId: string;
  from: string;
  to: string;
  /** Set when the rename failed (occupied destination / filesystem error); the character stays readable and is retried next startup. */
  failed?: boolean;
  /** Diagnostic text for a failed repair. */
  error?: string;
}

/** Windows-reserved directory names that must never be used verbatim (case-insensitive, checked post-slug). */
const WINDOWS_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/** Maximum directory component length — leaves headroom for a `-NN` collision suffix. */
const MAX_DIR_NAME = 60;

/**
 * Derive a filesystem-safe directory name from a character display name
 * (HUMAN_READABLE_FOLDERS). Lowercases, collapses non-alphanumeric runs to a
 * single hyphen, trims edge hyphens, caps length, and avoids Windows-reserved
 * names (CON/PRN/AUX/NUL/COMn/LPTn) by appending a hyphen. Returns "" for a
 * degenerate name (no alphanumerics); the caller (ensureDirectory) falls back
 * to the opaque characterId. This is the single derivation rule shared by the
 * create/duplicate/update lifecycle and startup reconciliation, so a tree
 * written by the lifecycle is always consistent with reconciliation.
 */
export function sanitizeDirectoryName(name: string): string {
  let s = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > MAX_DIR_NAME) s = s.slice(0, MAX_DIR_NAME).replace(/-+$/g, "");
  if (WINDOWS_RESERVED.has(s)) s += "-";
  return s;
}
