import { eq, asc, sql } from 'drizzle-orm';
import { samplerSets } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

/**
 * Stored sampler-set payload. Structurally a serialized ModelSettingsOverlay
 * (LOCAL_SUPPORT_PLAN LS-5a — the samplerPresetPayloadSchema bundle), but
 * defined locally as a loose record because `@vibe-tavern/db` sits below
 * `@vibe-tavern/api-contracts` in the package graph and must not import it.
 * The strict zod validation happens at the API adapter boundary
 * (createSamplerSetSchema / updateSamplerSetSchema / import sniffing).
 */
export type SamplerSetPayload = Record<string, unknown>;

/**
 * Store-level sampler set — projected from a DB row. `createdAt`/`updatedAt`
 * are kept for UI ordering; the wire `SamplerSet` shape drops nothing (it is
 * the same fields plus the parsed payload).
 */
export interface SamplerSetRow {
  id: string;
  name: string;
  sortOrder: number;
  payload: SamplerSetPayload;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSamplerSetData {
  name: string;
  payload: SamplerSetPayload;
  /** Explicit order (mass import assigns sequential); default = appended last. */
  sortOrder?: number;
}

export type UpdateSamplerSetData = Partial<CreateSamplerSetData>;

/**
 * Persistence for named sampler sets (LOCAL_SUPPORT_PLAN LS-5a). Sets are
 * inert templates (copy-on-select): no links, no enabled flag, no
 * per-provider rows — a set stores only the sampler value bundle. Name
 * collisions are resolved ABOVE this store (the adapter checks `getByName`
 * and maps to a Conflict 409); the store itself is dumb CRUD, matching the
 * small-resource store pattern (CopilotProfileStore).
 */
export class SamplerSetStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  async list(): Promise<SamplerSetRow[]> {
    const rows = await this.db
      .select()
      .from(samplerSets)
      .orderBy(asc(samplerSets.sortOrder), asc(samplerSets.name))
      .all();
    return rows.map((row) => this.mapRow(row));
  }

  async getById(id: string): Promise<SamplerSetRow | null> {
    const row = await this.db.select().from(samplerSets).where(eq(samplerSets.id, id)).get();
    return row ? this.mapRow(row) : null;
  }

  /** Exact-name lookup — the adapter's rename/create collision probe. */
  async getByName(name: string): Promise<SamplerSetRow | null> {
    const row = await this.db.select().from(samplerSets).where(eq(samplerSets.name, name)).get();
    return row ? this.mapRow(row) : null;
  }

  async create(data: CreateSamplerSetData): Promise<SamplerSetRow> {
    const id = this.idGen.next('sset');
    const now = this.clock.now();
    await this.db
      .insert(samplerSets)
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
    if (!row) throw new Error(`Sampler set '${id}' not found after create`);
    return row;
  }

  async update(id: string, data: UpdateSamplerSetData): Promise<SamplerSetRow> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Sampler set '${id}' not found`);

    const values: Partial<typeof samplerSets.$inferInsert> = { updatedAt: this.clock.now() };
    if (data.name !== undefined) values.name = data.name;
    if (data.payload !== undefined) values.payloadJson = JSON.stringify(data.payload);
    if (data.sortOrder !== undefined) values.sortOrder = data.sortOrder;

    await this.db.update(samplerSets).set(values).where(eq(samplerSets.id, id)).run();
    const row = await this.getById(id);
    if (!row) throw new Error(`Sampler set '${id}' not found after update`);
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(samplerSets).where(eq(samplerSets.id, id)).run();
  }

  /** Next list-order slot: max(sortOrder) + 1. */
  private async nextSortOrder(): Promise<number> {
    const rows = await this.db
      .select({ maxOrder: sql<number>`max(${samplerSets.sortOrder})` })
      .from(samplerSets)
      .all();
    const max = rows[0]?.maxOrder;
    return typeof max === 'number' && Number.isFinite(max) ? max + 1 : 0;
  }

  private mapRow(row: typeof samplerSets.$inferSelect): SamplerSetRow {
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

/** Parse a JSON column that holds the sampler payload, defending against malformed rows. */
function parsePayload(text: string): SamplerSetPayload {
  try {
    const parsed: unknown = JSON.parse(text || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as SamplerSetPayload;
  } catch {
    return {};
  }
}
