import { asc, eq } from 'drizzle-orm';
import { characterAssets } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

// ─── Input types ──────────────────────────────────────────────────────────────

export interface CreateCharacterAssetData {
  characterId: string;
  ext: string;
  mimeType: string;
  caption?: string;
  /** Display order (lower = earlier). Caller computes next position. */
  order: number;
}

export interface UpdateCharacterAssetData {
  caption?: string;
  /** Pass null to clear the description. */
  description?: string | null;
}

/**
 * Store-level CharacterAsset — projected from a DB row.
 * Uses plain `string` IDs (brands are applied at the API boundary), matching
 * the other stores. DB-only: file I/O (the gallery/{id}.{ext} binary) lives in
 * AssetService; `delete()` returns the ext so the adapter can remove the file.
 */
export interface CharacterAsset {
  id: string;
  characterId: string;
  ext: string;
  mimeType: string;
  caption: string;
  description: string | null;
  order: number;
  createdAt: string;
}

export class CharacterAssetStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  // ─── Read operations ───────────────────────────────────────────────────────

  /** List all gallery assets for a character, ordered by `order` then `createdAt`. */
  async listByCharacter(characterId: string): Promise<CharacterAsset[]> {
    const rows = await this.db
      .select()
      .from(characterAssets)
      .where(eq(characterAssets.characterId, characterId))
      .orderBy(asc(characterAssets.order), asc(characterAssets.createdAt))
      .all();
    return rows.map((row) => this.mapRow(row));
  }

  async getById(id: string): Promise<CharacterAsset | null> {
    const row = await this.db.select().from(characterAssets).where(eq(characterAssets.id, id)).get();
    return row ? this.mapRow(row) : null;
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  async create(data: CreateCharacterAssetData): Promise<CharacterAsset> {
    const id = this.idGen.next('char_asset');
    const now = this.clock.now();

    const [row] = await this.db
      .insert(characterAssets)
      .values({
        id,
        characterId: data.characterId,
        ext: data.ext,
        mimeType: data.mimeType,
        caption: data.caption ?? '',
        description: null,
        order: data.order,
        createdAt: now,
      })
      .returning();

    return this.mapRow(row!);
  }

  async update(id: string, patch: UpdateCharacterAssetData): Promise<CharacterAsset | null> {
    const values: { caption?: string; description?: string | null } = {};
    if (patch.caption !== undefined) values.caption = patch.caption;
    if (patch.description !== undefined) values.description = patch.description;

    const [row] = await this.db
      .update(characterAssets)
      .set(values)
      .where(eq(characterAssets.id, id))
      .returning();

    return row ? this.mapRow(row) : null;
  }

  /**
   * Rewrite the `order` field to 0..n-1 following the given id sequence.
   * Scoped to `characterId`: ids that do not belong to this character are
   * silently ignored, and numbering stays continuous (no holes from foreign
   * ids). Use this to persist a drag-and-drop reorder from the UI.
   */
  async reorder(characterId: string, orderedIds: string[]): Promise<void> {
    const validRows = await this.db
      .select({ id: characterAssets.id })
      .from(characterAssets)
      .where(eq(characterAssets.characterId, characterId))
      .all();
    const valid = new Set(validRows.map((r) => r.id));
    const ordered = orderedIds.filter((id) => valid.has(id));

    await this.db.transaction(async (tx) => {
      for (let i = 0; i < ordered.length; i++) {
        await tx
          .update(characterAssets)
          .set({ order: i })
          .where(eq(characterAssets.id, ordered[i]!))
          .run();
      }
    });
  }

  /**
   * Delete a gallery row. Returns `{ characterId, ext }` so the adapter can
   * remove the file at {characterId}/gallery/{id}.{ext}; null if the row was
   * already gone. Does NOT touch the filesystem.
   */
  async delete(id: string): Promise<{ characterId: string; ext: string } | null> {
    const row = await this.db.select().from(characterAssets).where(eq(characterAssets.id, id)).get();
    if (!row) return null;
    await this.db.delete(characterAssets).where(eq(characterAssets.id, id)).run();
    return { characterId: row.characterId, ext: row.ext };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private mapRow(row: typeof characterAssets.$inferSelect): CharacterAsset {
    return {
      id: row.id,
      characterId: row.characterId,
      ext: row.ext,
      mimeType: row.mimeType,
      caption: row.caption,
      description: row.description,
      order: row.order,
      createdAt: row.createdAt,
    };
  }
}
