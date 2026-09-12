import { eq, asc, sql } from 'drizzle-orm';
import { formatTemplates } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

/**
 * Stored format-template payload. Structurally a serialized GenerationFormat
 * (LOCAL_SUPPORT_PLAN LS-10 — the ST instruct DSL shape), but defined locally
 * as a loose record because `@vibe-tavern/db` sits below
 * `@vibe-tavern/api-contracts` in the package graph and must not import it.
 * The strict zod validation happens at the API adapter boundary
 * (createFormatTemplateSchema / updateFormatTemplateSchema).
 */
export type FormatTemplatePayload = Record<string, unknown>;

/**
 * Store-level format template — projected from a DB row (the sampler-set
 * store pattern, LS-10: the format-block counterpart of the sampler-set
 * library). Name collisions are resolved ABOVE this store (the adapter
 * checks `getByName` and maps to a Conflict 409); the store itself is dumb
 * CRUD.
 */
export interface FormatTemplateRow {
  id: string;
  name: string;
  sortOrder: number;
  payload: FormatTemplatePayload;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFormatTemplateData {
  name: string;
  payload: FormatTemplatePayload;
  /** Explicit order (mass import assigns sequential); default = appended last. */
  sortOrder?: number;
}

export type UpdateFormatTemplateData = Partial<CreateFormatTemplateData>;

export class FormatTemplateStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  async list(): Promise<FormatTemplateRow[]> {
    const rows = await this.db
      .select()
      .from(formatTemplates)
      .orderBy(asc(formatTemplates.sortOrder), asc(formatTemplates.name))
      .all();
    return rows.map((row) => this.mapRow(row));
  }

  async getById(id: string): Promise<FormatTemplateRow | null> {
    const row = await this.db.select().from(formatTemplates).where(eq(formatTemplates.id, id)).get();
    return row ? this.mapRow(row) : null;
  }

  /** Exact-name lookup — the adapter's rename/create collision probe. */
  async getByName(name: string): Promise<FormatTemplateRow | null> {
    const row = await this.db.select().from(formatTemplates).where(eq(formatTemplates.name, name)).get();
    return row ? this.mapRow(row) : null;
  }

  async create(data: CreateFormatTemplateData): Promise<FormatTemplateRow> {
    const id = this.idGen.next('ftpl');
    const now = this.clock.now();
    await this.db
      .insert(formatTemplates)
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
    if (!row) throw new Error(`Format template '${id}' not found after create`);
    return row;
  }

  async update(id: string, data: UpdateFormatTemplateData): Promise<FormatTemplateRow> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Format template '${id}' not found`);

    const values: Partial<typeof formatTemplates.$inferInsert> = { updatedAt: this.clock.now() };
    if (data.name !== undefined) values.name = data.name;
    if (data.payload !== undefined) values.payloadJson = JSON.stringify(data.payload);
    if (data.sortOrder !== undefined) values.sortOrder = data.sortOrder;

    await this.db.update(formatTemplates).set(values).where(eq(formatTemplates.id, id)).run();
    const row = await this.getById(id);
    if (!row) throw new Error(`Format template '${id}' not found after update`);
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(formatTemplates).where(eq(formatTemplates.id, id)).run();
  }

  /** Next list-order slot: max(sortOrder) + 1. */
  private async nextSortOrder(): Promise<number> {
    const rows = await this.db
      .select({ maxOrder: sql<number>`max(${formatTemplates.sortOrder})` })
      .from(formatTemplates)
      .all();
    const max = rows[0]?.maxOrder;
    return typeof max === 'number' && Number.isFinite(max) ? max + 1 : 0;
  }

  private mapRow(row: typeof formatTemplates.$inferSelect): FormatTemplateRow {
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

/** Parse a JSON column that holds the template payload, defending against malformed rows. */
function parsePayload(text: string): FormatTemplatePayload {
  try {
    const parsed: unknown = JSON.parse(text || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as FormatTemplatePayload;
  } catch {
    return {};
  }
}
