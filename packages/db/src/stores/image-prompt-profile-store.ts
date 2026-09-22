import { asc, desc, eq } from 'drizzle-orm';

import { brandId } from '@vibe-tavern/domain';
import type { ImagePromptProfileId, ImagePromptCellKey, ImagePromptCellOverride } from '@vibe-tavern/domain';
import { parseImagePromptCellKey, isImagePromptCellOverride } from '@vibe-tavern/domain';

import type { AppDb } from '../db-connection.js';
import { imagePromptProfiles } from '../db-schema.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

// ─── Input types ──────────────────────────────────────────────────────────────

export type CreateImagePromptProfileData = {
  name: string;
  overrides?: ImagePromptOverridesInput;
};

export type UpdateImagePromptProfileData = {
  name?: string;
  overrides?: ImagePromptOverridesInput;
};

/** Overrides input at the store boundary: keyed by the domain cell key
 *  (unknown keys / wrong payloads are dropped by serializeOverrides).
 *  Optional qualityText mirrors the variant-store row semantics
 *  (null/undefined = family canon). */
export type ImagePromptOverridesInput = Partial<Record<ImagePromptCellKey, ImagePromptCellOverride>>;

export interface ImagePromptProfile {
  id: ImagePromptProfileId;
  name: string;
  isDefault: boolean;
  sortOrder: number;
  overrides: Partial<Record<ImagePromptCellKey, ImagePromptCellOverride>>;
  createdAt: string;
  updatedAt: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseOverrides(raw: string): ImagePromptProfile['overrides'] {
  try {
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: ImagePromptProfile['overrides'] = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!parseImagePromptCellKey(k)) continue;
      if (!isImagePromptCellOverride(v)) continue;
      out[k as ImagePromptCellKey] = { body: v.body, qualityText: v.qualityText ?? null };
    }
    return out;
  } catch {
    return {};
  }
}

function serializeOverrides(overrides: ImagePromptOverridesInput): string {
  // Validate again before write — drop unknown keys / wrong payloads.
  const filtered: ImagePromptProfile['overrides'] = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (!parseImagePromptCellKey(k)) continue;
    if (!isImagePromptCellOverride(v)) continue;
    filtered[k as ImagePromptCellKey] = { body: v.body, qualityText: v.qualityText ?? null };
  }
  return JSON.stringify(filtered);
}

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Persistence for separately-living image prompt profiles (IF-1a — the
 * IPT-1 rework): a deliberate fork of `ServicePromptProfileStore` with the
 * field-key axis replaced by the `(rowKey | family)` cell axis. All profile
 * semantics mirror the service-prompt store: seeded read-only "default" row
 * (self-healed by ensureDefault), sortOrder-based ordering with Default
 * pinned first, silent-ignore guards on default rename/override/delete, and
 * full-replace overrides updates. Canon text stays in authored assets — an
 * absent cell means canon; profiles carry overrides only.
 */
export class ImagePromptProfileStore {
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

  async listImagePromptProfiles(): Promise<ImagePromptProfile[]> {
    await this.ensureDefaultImagePromptProfile();
    const rows = await this.db
      .select()
      .from(imagePromptProfiles)
      .orderBy(desc(imagePromptProfiles.isDefault), asc(imagePromptProfiles.sortOrder), asc(imagePromptProfiles.name))
      .all();
    return rows.map((r) => this.mapRow(r));
  }

  async getImagePromptProfile(id: string): Promise<ImagePromptProfile | null> {
    await this.ensureDefaultImagePromptProfile();
    const row = await this.db
      .select()
      .from(imagePromptProfiles)
      .where(eq(imagePromptProfiles.id, id))
      .get();
    return row ? this.mapRow(row) : null;
  }

  async ensureDefaultImagePromptProfile(): Promise<ImagePromptProfile> {
    const existing = await this.db
      .select()
      .from(imagePromptProfiles)
      .where(eq(imagePromptProfiles.id, 'default'))
      .get();
    if (existing) return this.mapRow(existing);

    const now = this.clock.now();
    const [row] = await this.db
      .insert(imagePromptProfiles)
      .values({
        id: 'default',
        name: 'Default',
        isDefault: 1,
        overrides: '{}',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();

    if (row) return this.mapRow(row);

    // Race: another caller inserted concurrently.
    const raced = await this.db
      .select()
      .from(imagePromptProfiles)
      .where(eq(imagePromptProfiles.id, 'default'))
      .get();
    return this.mapRow(raced!);
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  async createImagePromptProfile(input: CreateImagePromptProfileData): Promise<ImagePromptProfile> {
    const id = this.idGen.next('image_prompt_profile');
    const now = this.clock.now();
    const rows = await this.db.select().from(imagePromptProfiles).all();
    const maxOrder = rows.reduce((m, r) => Math.max(m, r.sortOrder ?? 0), -1);
    const [row] = await this.db
      .insert(imagePromptProfiles)
      .values({
        id,
        name: input.name,
        isDefault: 0,
        sortOrder: maxOrder + 1,
        overrides: serializeOverrides(input.overrides ?? {}),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return this.mapRow(row!);
  }

  /**
   * Patch-apply update; bumps updatedAt. Returns null when id is unknown.
   *
   * Default-profile guard: mirrors ServicePromptProfileStore — the "default"
   * profile's name and overrides are immutable; refused fields are silently
   * ignored (no updatedAt bump) so callers stay idempotent.
   */
  async updateImagePromptProfile(
    id: string,
    patch: UpdateImagePromptProfileData,
  ): Promise<ImagePromptProfile | null> {
    const isDefault = id === 'default';
    const values: Partial<typeof imagePromptProfiles.$inferInsert> = {};

    // Default guard: never allow rename or overrides mutation.
    if (!isDefault) {
      if (patch.name !== undefined) values.name = patch.name;
      if (patch.overrides !== undefined) values.overrides = serializeOverrides(patch.overrides);
    } else {
      // If caller only tried to mutate refused fields, treat as no-op.
      if (patch.name === undefined && patch.overrides === undefined) return this.getImagePromptProfile(id);
      // Silently ignore refused fields — don't bump updatedAt.
      const existing = await this.db
        .select()
        .from(imagePromptProfiles)
        .where(eq(imagePromptProfiles.id, id))
        .get();
      return existing ? this.mapRow(existing) : null;
    }

    // If patch was empty after guard, nothing to update.
    if (Object.keys(values).length === 0) {
      const row = await this.db
        .select()
        .from(imagePromptProfiles)
        .where(eq(imagePromptProfiles.id, id))
        .get();
      return row ? this.mapRow(row) : null;
    }

    values.updatedAt = this.clock.now();

    const [row] = await this.db
      .update(imagePromptProfiles)
      .set(values)
      .where(eq(imagePromptProfiles.id, id))
      .returning();
    return row ? this.mapRow(row) : null;
  }

  /**
   * Deletes the profile. Refuses to delete the default profile (id "default")
   * — silent no-op, mirroring ServicePromptProfileStore.
   */
  async deleteImagePromptProfile(id: string): Promise<void> {
    if (id === 'default') return;
    await this.db.delete(imagePromptProfiles).where(eq(imagePromptProfiles.id, id)).run();
  }

  async reorderImagePromptProfiles(updates: Array<{ id: string; sortOrder: number }>): Promise<ImagePromptProfile[]> {
    for (const u of updates) {
      if (u.id === 'default') continue;
      await this.db
        .update(imagePromptProfiles)
        .set({ sortOrder: u.sortOrder, updatedAt: this.clock.now() })
        .where(eq(imagePromptProfiles.id, u.id))
        .run();
    }
    return this.listImagePromptProfiles();
  }

  // ─── Row mapper ────────────────────────────────────────────────────────────

  private mapRow(row: typeof imagePromptProfiles.$inferSelect): ImagePromptProfile {
    return {
      id: brandId<ImagePromptProfileId>(row.id),
      name: row.name,
      isDefault: row.isDefault === 1,
      sortOrder: row.sortOrder ?? 0,
      overrides: parseOverrides(row.overrides),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
