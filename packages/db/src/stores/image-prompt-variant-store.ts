import { and, eq, asc } from 'drizzle-orm';
import { imagePromptVariants } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';
import type { ImageGenerationMode, ImagePromptFamilyId } from '@vibe-tavern/domain';

/**
 * The row-key axis of the variants table (IPT Wave 1): a generation-mode
 * slug, or the literal `"negative"` for the shared negative row. Assist and
 * quality rows are not keyed here (quality rides its own column on the
 * (mode, family) row; the assist core is a canon asset, not an override).
 */
export type ImagePromptVariantKey = ImageGenerationMode | 'negative';

/** Store-level row — user customization for one (rowKey, family). */
export interface ImagePromptVariantRow {
  id: string;
  rowKey: ImagePromptVariantKey;
  family: ImagePromptFamilyId;
  body: string;
  qualityText: string | null;
  updatedAt: string;
}

export interface ImagePromptVariantUpsertData {
  rowKey: ImagePromptVariantKey;
  family: ImagePromptFamilyId;
  body: string;
  /** Full-row upsert: undefined/null clears the column (back to canon). */
  qualityText?: string | null;
}

/**
 * Persistence for user-customized image prompt variants (IPT Wave 1).
 * OVERRIDES-ONLY: a row exists iff the user customized that (rowKey,
 * family); the canon lives in authored assets, so `reset` is a DELETE
 * (back to canon — no tombstone, no "empty body" convention). Upsert
 * replaces the row in full (body + qualityText as given); it is not a
 * patch — partial edits read-modify-write above the store, at the API
 * boundary. Dumb keyed storage, matching the small-resource store
 * pattern: no validation of rowKey/family against the domain registries
 * (strict zod happens at the adapter boundary; unknown keys simply
 * never resolve canon and stay inert).
 */
export class ImagePromptVariantStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  async get(rowKey: ImagePromptVariantKey, family: ImagePromptFamilyId): Promise<ImagePromptVariantRow | null> {
    const row = await this.db
      .select()
      .from(imagePromptVariants)
      .where(and(eq(imagePromptVariants.rowKey, rowKey), eq(imagePromptVariants.family, family)))
      .get();
    return row ? this.mapRow(row) : null;
  }

  async upsert(data: ImagePromptVariantUpsertData): Promise<ImagePromptVariantRow> {
    const now = this.clock.now();
    await this.db
      .insert(imagePromptVariants)
      .values({
        id: this.idGen.next('igptv'),
        rowKey: data.rowKey,
        family: data.family,
        body: data.body,
        qualityText: data.qualityText ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [imagePromptVariants.rowKey, imagePromptVariants.family],
        set: {
          body: data.body,
          qualityText: data.qualityText ?? null,
          updatedAt: now,
        },
      })
      .run();
    const row = await this.get(data.rowKey, data.family);
    if (!row) throw new Error(`Image prompt variant (${data.rowKey}, ${data.family}) not found after upsert`);
    return row;
  }

  /** Delete the override — the (rowKey, family) resolves back to canon. Idempotent. */
  async reset(rowKey: ImagePromptVariantKey, family: ImagePromptFamilyId): Promise<void> {
    await this.db
      .delete(imagePromptVariants)
      .where(and(eq(imagePromptVariants.rowKey, rowKey), eq(imagePromptVariants.family, family)))
      .run();
  }

  async listAll(): Promise<ImagePromptVariantRow[]> {
    const rows = await this.db
      .select()
      .from(imagePromptVariants)
      .orderBy(asc(imagePromptVariants.rowKey), asc(imagePromptVariants.family))
      .all();
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: typeof imagePromptVariants.$inferSelect): ImagePromptVariantRow {
    return {
      id: row.id,
      rowKey: row.rowKey as ImagePromptVariantKey,
      family: row.family as ImagePromptFamilyId,
      body: row.body,
      qualityText: row.qualityText ?? null,
      updatedAt: row.updatedAt,
    };
  }
}
