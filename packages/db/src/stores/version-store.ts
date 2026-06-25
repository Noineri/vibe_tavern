import { asc, and, eq } from 'drizzle-orm';
import { characterVersions } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';
import type { CharacterStore } from './character-store.js';
import { brandId, type CharacterVersion, type CharacterVersionId, type CharacterId } from '@vibe-tavern/domain';

/**
 * Version Switcher store (VTF Phase 3 — folder-snapshot branching).
 *
 * Owns the `character_versions` DB rows + the single-active invariant. The
 * active version's content lives at the character folder ROOT (read by
 * `CharacterStore.getById`, which is version-agnostic); non-active versions
 * live as full folder snapshots under `data/characters/{id}/versions/{vid}/`.
 * Folder mechanics (snapshot/restore/remove) are delegated to `CharacterStore`
 * so the VTF codec knowledge stays in one place.
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
  private readonly characters: CharacterStore;

  constructor(
    db: AppDb,
    options: { clock?: StoreClock; idGenerator?: StoreIdGenerator; characters: CharacterStore },
  ) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
    this.characters = options.characters;
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
    await this.characters.snapshotRootToVersion(characterId, current.id);
    const id = this.idGen.next('charver');
    const now = this.clock.now();
    await this.db.transaction(async (tx) => {
      await tx
        .update(characterVersions)
        .set({ isActive: false })
        .where(eq(characterVersions.characterId, characterId))
        .run();
      await tx
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
   * intended active version.
   */
  async setActive(characterId: string, versionId: string): Promise<CharacterVersion> {
    const target = await this.getVersion(versionId);
    if (!target) throw new Error(`Version '${versionId}' not found`);
    if (target.characterId !== brandId<CharacterId>(characterId)) {
      throw new Error(`Version '${versionId}' does not belong to character '${characterId}'`);
    }
    const current = await this.getActiveVersion(characterId);
    if (current && current.id === target.id) return target;
    if (current) {
      await this.characters.snapshotRootToVersion(characterId, current.id);
    }
    await this.characters.restoreVersionToRoot(characterId, versionId);
    await this.activateOnly(characterId, versionId);
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
    await this.characters.removeVersionFolder(characterId, versionId);
    await this.db.delete(characterVersions).where(eq(characterVersions.id, versionId)).run();
  }

  /** Flip exactly one version active for a character (single-active invariant). */
  private async activateOnly(characterId: string, versionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(characterVersions)
        .set({ isActive: false })
        .where(eq(characterVersions.characterId, characterId))
        .run();
      await tx
        .update(characterVersions)
        .set({ isActive: true })
        .where(eq(characterVersions.id, versionId))
        .run();
    });
  }
}
