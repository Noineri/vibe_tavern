import { eq, asc, sql } from 'drizzle-orm';
import { imageGenSamplerSets } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';
import type { ImageGenSamplerSet, ImageGenSamplerSetPayload } from '@vibe-tavern/domain';

/**
 * Stored image-gen sampler-set payload (IG-CF15). Defined locally as a loose
 * record because `@vibe-tavern/db` sits below `@vibe-tavern/api-contracts`
 * and must not import it — the strict zod validation happens at the API
 * adapter boundary (the sampler-set-store `SamplerSetPayload` convention).
 */
export type ImageGenSamplerSetStoredPayload = Record<string, unknown>;

/** Store-level row — same fields as the domain `ImageGenSamplerSet`. */
export interface ImageGenSamplerSetRow {
  id: string;
  name: string;
  sortOrder: number;
  payload: ImageGenSamplerSetStoredPayload;
  createdAt: string;
  updatedAt: string;
}

export interface CreateImageGenSamplerSetData {
  name: string;
  payload: ImageGenSamplerSetPayload | ImageGenSamplerSetStoredPayload;
  /** Explicit order (mass import assigns sequential); default = appended last. */
  sortOrder?: number;
}

export type UpdateImageGenSamplerSetData = Partial<CreateImageGenSamplerSetData>;

/**
 * Persistence for named image-gen sampler sets (IG-CF15 — the LLM
 * `SamplerSetStore` fork; the LS-5a mechanic carried to image-gen). Sets are
 * inert templates (copy-on-select): no links, no enabled flag — a set stores
 * only the five scalar generation params. Name collisions are resolved ABOVE
 * this store (the adapter checks `getByName` and maps to Conflict 409); the
 * store itself is dumb CRUD, matching the small-resource store pattern.
 */
export class ImageGenSamplerSetStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  async list(): Promise<ImageGenSamplerSetRow[]> {
    const rows = await this.db
      .select()
      .from(imageGenSamplerSets)
      .orderBy(asc(imageGenSamplerSets.sortOrder), asc(imageGenSamplerSets.name))
      .all();
    return rows.map((row) => this.mapRow(row));
  }

  async getById(id: string): Promise<ImageGenSamplerSetRow | null> {
    const row = await this.db.select().from(imageGenSamplerSets).where(eq(imageGenSamplerSets.id, id)).get();
    return row ? this.mapRow(row) : null;
  }

  /** Exact-name lookup — the adapter's rename/create collision probe. */
  async getByName(name: string): Promise<ImageGenSamplerSetRow | null> {
    const row = await this.db.select().from(imageGenSamplerSets).where(eq(imageGenSamplerSets.name, name)).get();
    return row ? this.mapRow(row) : null;
  }

  async create(data: CreateImageGenSamplerSetData): Promise<ImageGenSamplerSetRow> {
    const id = this.idGen.next('igset');
    const now = this.clock.now();
    await this.db
      .insert(imageGenSamplerSets)
      .values({
        id,
        name: data.name,
        sortOrder: data.sortOrder ?? (await this.nextSortOrder()),
        payloadJson: JSON.stringify(data.payload),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const row = await this.getById(id);
    if (!row) throw new Error(`Image-gen sampler set '${id}' not found after create`);
    return row;
  }

  async update(id: string, data: UpdateImageGenSamplerSetData): Promise<ImageGenSamplerSetRow> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Image-gen sampler set '${id}' not found`);

    const values: Partial<typeof imageGenSamplerSets.$inferInsert> = { updatedAt: this.clock.now() };
    if (data.name !== undefined) values.name = data.name;
    if (data.payload !== undefined) values.payloadJson = JSON.stringify(data.payload);
    if (data.sortOrder !== undefined) values.sortOrder = data.sortOrder;

    await this.db.update(imageGenSamplerSets).set(values).where(eq(imageGenSamplerSets.id, id)).run();
    const row = await this.getById(id);
    if (!row) throw new Error(`Image-gen sampler set '${id}' not found after update`);
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(imageGenSamplerSets).where(eq(imageGenSamplerSets.id, id)).run();
  }

  /** Next list-order slot: max(sortOrder) + 1. */
  private async nextSortOrder(): Promise<number> {
    const rows = await this.db
      .select({ maxOrder: sql<number>`max(${imageGenSamplerSets.sortOrder})` })
      .from(imageGenSamplerSets)
      .all();
    const max = rows[0]?.maxOrder;
    return typeof max === 'number' && Number.isFinite(max) ? max + 1 : 0;
  }

  private mapRow(row: typeof imageGenSamplerSets.$inferSelect): ImageGenSamplerSetRow {
    return {
      id: row.id,
      name: row.name,
      sortOrder: row.sortOrder,
      payload: parsePayload(row.payloadJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

/** Parse a JSON column that holds the payload, defending against malformed rows. */
function parsePayload(text: string): ImageGenSamplerSetStoredPayload {
  try {
    const parsed: unknown = JSON.parse(text || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as ImageGenSamplerSetStoredPayload;
  } catch {
    return {};
  }
}

/** Domain row projection (brand-free timestamps as-is; the domain type is
 *  structural over the same fields). */
export function samplerSetRowToDomain(row: ImageGenSamplerSetRow): ImageGenSamplerSet {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    payload: row.payload as ImageGenSamplerSetPayload,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
