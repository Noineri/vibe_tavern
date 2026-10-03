import { eq, asc, sql } from 'drizzle-orm';
import { aiInstructionTemplates } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

/**
 * User-saved instruction templates for the message AI editor
 * (AI_EDITOR_INSTRUCTION_TEMPLATES) — a file-by-file fork of the
 * format-template store (LOCAL_SUPPORT_PLAN LS-10, the sampler-set store
 * pattern): dumb CRUD + name lookups; collisions resolve ABOVE this store
 * (the adapter checks `getByName` and maps to a Conflict 409). The one named
 * deviation from the twin: the payload column is a plain `text` field, not a
 * JSON blob — an instruction template IS its text, there is no shape to
 * serialize.
 */
export interface AiInstructionTemplateRow {
  id: string;
  name: string;
  sortOrder: number;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAiInstructionTemplateData {
  name: string;
  text: string;
  /** Explicit order (mass import assigns sequential); default = appended last. */
  sortOrder?: number;
}

export type UpdateAiInstructionTemplateData = Partial<CreateAiInstructionTemplateData>;

export class AiInstructionTemplateStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  async list(): Promise<AiInstructionTemplateRow[]> {
    const rows = await this.db
      .select()
      .from(aiInstructionTemplates)
      .orderBy(asc(aiInstructionTemplates.sortOrder), asc(aiInstructionTemplates.name))
      .all();
    return rows.map((row) => this.mapRow(row));
  }

  async getById(id: string): Promise<AiInstructionTemplateRow | null> {
    const row = await this.db.select().from(aiInstructionTemplates).where(eq(aiInstructionTemplates.id, id)).get();
    return row ? this.mapRow(row) : null;
  }

  /** Exact-name lookup — the adapter's rename/create collision probe. */
  async getByName(name: string): Promise<AiInstructionTemplateRow | null> {
    const row = await this.db.select().from(aiInstructionTemplates).where(eq(aiInstructionTemplates.name, name)).get();
    return row ? this.mapRow(row) : null;
  }

  async create(data: CreateAiInstructionTemplateData): Promise<AiInstructionTemplateRow> {
    const id = this.idGen.next('aitpl');
    const now = this.clock.now();
    await this.db
      .insert(aiInstructionTemplates)
      .values({
        id,
        name: data.name,
        sortOrder: data.sortOrder ?? (await this.nextSortOrder()),
        text: data.text,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const row = await this.getById(id);
    if (!row) throw new Error(`AI instruction template '${id}' not found after create`);
    return row;
  }

  async update(id: string, data: UpdateAiInstructionTemplateData): Promise<AiInstructionTemplateRow> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`AI instruction template '${id}' not found`);

    const values: Partial<typeof aiInstructionTemplates.$inferInsert> = { updatedAt: this.clock.now() };
    if (data.name !== undefined) values.name = data.name;
    if (data.text !== undefined) values.text = data.text;
    if (data.sortOrder !== undefined) values.sortOrder = data.sortOrder;

    await this.db.update(aiInstructionTemplates).set(values).where(eq(aiInstructionTemplates.id, id)).run();
    const row = await this.getById(id);
    if (!row) throw new Error(`AI instruction template '${id}' not found after update`);
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(aiInstructionTemplates).where(eq(aiInstructionTemplates.id, id)).run();
  }

  /** Next list-order slot: max(sortOrder) + 1. */
  private async nextSortOrder(): Promise<number> {
    const rows = await this.db
      .select({ maxOrder: sql<number>`max(${aiInstructionTemplates.sortOrder})` })
      .from(aiInstructionTemplates)
      .all();
    const max = rows[0]?.maxOrder;
    return typeof max === 'number' && Number.isFinite(max) ? max + 1 : 0;
  }

  private mapRow(row: typeof aiInstructionTemplates.$inferSelect): AiInstructionTemplateRow {
    return {
      id: row.id,
      name: row.name,
      sortOrder: row.sortOrder,
      text: row.text,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
