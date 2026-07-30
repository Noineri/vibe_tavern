import { asc, and, eq } from 'drizzle-orm';
import { characterVersions } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';
import { CharacterFolder } from './character-folder.js';
import type { CharacterDirectoryRegistry } from './character-directory-registry.js';
import { brandId, type CharacterVersion, type CharacterVersionId, type CharacterId } from '@vibe-tavern/domain';

/**
 * Version Switcher store (VTF Phase 3 — folder-snapshot branching).
 *
 * Owns the `character_versions` DB rows + the single-active invariant. The
 * active version's content lives at the character folder ROOT (read by
 * `CharacterStore.getById`, which is version-agnostic); non-active versions
 * live as full folder snapshots under `data/characters/{id}/versions/{vid}/`.
 * Folder mechanics (snapshot/restore/remove) are delegated to `CharacterFolder`,
 * which owns the on-disk character-folder layout.
 *
 * Branching model (decided): a character always has exactly one active version.
 * `createVersion` snapshots the current root into the OLD active version's slot
 * and flips a new version active — the root stays (the new version starts as an
 * identical copy of the forked version). `setActive` is a folder swap
 * (root → versions/{cur}/, versions/{target}/ → root) + flag flip. Bootstrap
 * (`ensureBaseVersion`) materializes the implicit "Base" from the current root
 * for characters that predate this feature or were just created; the API layer
 * calls it after create and when listing versions.
 *
 * Crash window: the folder swap runs before the DB flag flip, so a crash leaves
 * the root reflecting the intended active version and re-running the op recovers.
 */
export class VersionStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;
  private readonly folder: CharacterFolder;
  private readonly registry: CharacterDirectoryRegistry | null;

  constructor(
    db: AppDb,
    options: { clock?: StoreClock; idGenerator?: StoreIdGenerator; folder: CharacterFolder; registry?: CharacterDirectoryRegistry | null },
  ) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
    this.folder = options.folder;
    this.registry = options.registry ?? null;
  }

  private mapRow(row: typeof characterVersions.$inferSelect): CharacterVersion {
    return {
      id: brandId<CharacterVersionId>(row.id),
      characterId: brandId<CharacterId>(row.characterId),
      title: row.title,
      isActive: row.isActive,
      createdAt: row.createdAt,
    };
  }

  /**
   * Resolve the on-disk directory name for a character via the filesystem
   * registry (HUMAN_READABLE_FOLDERS). VersionStore is a character-folder
   * collaborator but does NOT own the Character row, so it delegates to the
   * registry — falling back to the opaque id when the registry is absent (unit
   * tests) or the character has no directory yet. All CharacterFolder calls
   * route through this so snapshot/restore/remove target the renamed directory,
   * not a stale id-named one. No DB column represents a character directory
   * name (the transitional folder_name column was removed in HRF-6).
   */
  private async folderOf(characterId: string): Promise<string> {
    if (!this.registry) return characterId;
    return (await this.registry.resolve(characterId)) ?? characterId;
  }

  /** List all versions for a character in creation order (for ordinal labeling v1, v2…). */
  async listVersions(characterId: string): Promise<CharacterVersion[]> {
    const rows = await this.db
      .select()
      .from(characterVersions)
      .where(eq(characterVersions.characterId, characterId))
      .orderBy(asc(characterVersions.createdAt), asc(characterVersions.id))
      .all();
    return rows.map((row) => this.mapRow(row));
  }

  async getVersion(versionId: string): Promise<CharacterVersion | null> {
    const row = await this.db
      .select()
      .from(characterVersions)
      .where(eq(characterVersions.id, versionId))
      .get();
    return row ? this.mapRow(row) : null;
  }

  async getActiveVersion(characterId: string): Promise<CharacterVersion | null> {
    const row = await this.db
      .select()
      .from(characterVersions)
      .where(and(eq(characterVersions.characterId, characterId), eq(characterVersions.isActive, true)))
      .get();
    return row ? this.mapRow(row) : null;
  }

  /**
   * Materialize the implicit "Base" active version for a character that has none.
   * The current root folder IS the base content (no copy needed). Idempotent:
   * returns the existing active version if one already exists. If versions exist
   * but none is active (defensive), activates the first.
   */
  async ensureBaseVersion(characterId: string, title = 'Base'): Promise<CharacterVersion> {
    const active = await this.getActiveVersion(characterId);
    if (active) return active;
    const rows = await this.listVersions(characterId);
    if (rows.length > 0) {
      const first = rows[0];
      await this.activateOnly(characterId, first.id);
      return this.getVersion(first.id) as Promise<CharacterVersion>;
    }
    const id = this.idGen.next('charver');
    const now = this.clock.now();
    await this.db
      .insert(characterVersions)
      .values({ id, characterId, title, isActive: true, createdAt: now })
      .run();
    return {
      id: brandId<CharacterVersionId>(id),
      characterId: brandId<CharacterId>(characterId),
      title,
      isActive: true,
      createdAt: now,
    };
  }

  /**
   * Branch: fork the current root into a new active version. The current active
   * version's content is snapshotted to `versions/{cur}/` (preserved); the new
   * version becomes active with root content unchanged (identical copy at fork
   * time, editable thereafter). Bootstraps the implicit Base first if needed.
   */
  async createVersion(characterId: string, title: string): Promise<CharacterVersion> {
    const current = await this.ensureBaseVersion(characterId);
    // Preserve the currently-active version as a non-active snapshot. Root is
    // unchanged — the new version starts as an identical copy of `current`.
    await this.folder.snapshotToVersion(await this.folderOf(characterId), current.id);
    const id = this.idGen.next('charver');
    const now = this.clock.now();
    // Synchronous callback (ASYNC_TRANSACTION_AUDIT step 5): drizzle-orm +
    // bun:sqlite commits at the end of the callback's synchronous prefix, so an
    // async callback's post-await throw is never rolled back. Keeping this
    // synchronous means a failure on the insert rolls the clear back too — the
    // prior active version survives. (FS snapshot above is already outside the
    // DB transaction, as required.)
    this.db.transaction((tx) => {
      tx
        .update(characterVersions)
        .set({ isActive: false })
        .where(eq(characterVersions.characterId, characterId))
        .run();
      tx
        .insert(characterVersions)
        .values({ id, characterId, title, isActive: true, createdAt: now })
        .run();
    });
    return {
      id: brandId<CharacterVersionId>(id),
      characterId: brandId<CharacterId>(characterId),
      title,
      isActive: true,
      createdAt: now,
    };
  }

  /**
   * Switch the active version: folder swap (root → versions/{cur}/,
   * versions/{target}/ → root) + flag flip. No-op if target is already active.
   * The swap runs before the DB flip so a crash leaves the root reflecting the
   * intended active version. A snapshot is allowed to carry a different
   * character display name; after restore + DB activation, the registry applies
   * that canonical name as a cosmetic directory rename. Rename happens last so
   * its failure never rolls back or hides the successfully activated content,
   * and startup reconciliation can retry from the restored profile.md.
   */
  async setActive(characterId: string, versionId: string): Promise<CharacterVersion> {
    const target = await this.getVersion(versionId);
    if (!target) throw new Error(`Version '${versionId}' not found`);
    if (target.characterId !== brandId<CharacterId>(characterId)) {
      throw new Error(`Version '${versionId}' does not belong to character '${characterId}'`);
    }
    const current = await this.getActiveVersion(characterId);
    if (current && current.id === target.id) return target;
    const currentDir = await this.folderOf(characterId);
    if (current) {
      await this.folder.snapshotToVersion(currentDir, current.id);
    }
    await this.folder.restoreFromVersion(currentDir, versionId);
    await this.activateOnly(characterId, versionId);
    if (this.registry) {
      const restored = await this.folder.readVtfOverride(currentDir);
      if (restored) await this.registry.renameForDisplayName(characterId, restored.name);
    }
    return target;
  }

  /** Rename a version's title. Content is untouched. Returns null if not found. */
  async renameVersion(versionId: string, title: string): Promise<CharacterVersion | null> {
    const existing = await this.getVersion(versionId);
    if (!existing) return null;
    await this.db
      .update(characterVersions)
      .set({ title })
      .where(eq(characterVersions.id, versionId))
      .run();
    return this.getVersion(versionId);
  }

  /**
   * Delete a non-active version: removes its `versions/{vid}/` snapshot folder +
   * the DB row. Refuses (throws) if the version is active. Idempotent for
   * missing versions.
   */
  async deleteVersion(characterId: string, versionId: string): Promise<void> {
    const version = await this.getVersion(versionId);
    if (!version) return;
    if (version.isActive) {
      throw new Error('Cannot delete the active version');
    }
    await this.folder.removeVersionFolder(await this.folderOf(characterId), versionId);
    await this.db.delete(characterVersions).where(eq(characterVersions.id, versionId)).run();
  }

  /** Flip exactly one version active for a character (single-active invariant). */
  private async activateOnly(characterId: string, versionId: string): Promise<void> {
    // Synchronous callback (ASYNC_TRANSACTION_AUDIT step 5): see createVersion.
    // Both callers already guarantee `versionId` exists and belongs to
    // `characterId` — `setActive` validates via getVersion() up front, and
    // `ensureBaseVersion` passes a `first.id` taken straight from listVersions()
    // — so the clear-then-set-stale pattern is unreachable here. No target
    // validation is added because it would duplicate those upstream guards; a
    // failure on the second update rolls the clear back regardless.
    this.db.transaction((tx) => {
      tx
        .update(characterVersions)
        .set({ isActive: false })
        .where(eq(characterVersions.characterId, characterId))
        .run();
      tx
        .update(characterVersions)
        .set({ isActive: true })
        .where(eq(characterVersions.id, versionId))
        .run();
    });
  }
}
