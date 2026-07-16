import { eq } from 'drizzle-orm';
import { coauthorModules } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

/**
 * Stored tool-set shape. Structurally identical to the api-contracts
 * `CoauthorToolSet` (a partial record of tool-name → enabled), but defined
 * locally because `@vibe-tavern/db` sits below `@vibe-tavern/api-contracts` in
 * the package graph and must not import it. The registry coerces this to the
 * strict `CoauthorToolSet` at resolve time.
 */
export type StoredCoauthorToolSet = Partial<Record<string, boolean>>;

/**
 * Store-level Co-Author module — a user-created module projected from a DB row.
 * `isBuiltIn` is NOT stored (it's derived in the registry merge: seed defs are
 * built-in, every row here is a user module). `createdAt`/`updatedAt` are kept
 * for ordering and UI; they are dropped when the registry maps to the API
 * `CoauthorModule` shape.
 */
export interface CoauthorModuleRow {
  id: string;
  name: string;
  description: string;
  basePrompt: string;
  openingMessage: string;
  skillIds: string[];
  toolSet: StoredCoauthorToolSet;
  maxSteps: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCoauthorModuleData {
  name: string;
  description: string;
  basePrompt: string;
  openingMessage: string;
  skillIds: string[];
  toolSet: StoredCoauthorToolSet;
  maxSteps: number;
}

export type UpdateCoauthorModuleData = Partial<CreateCoauthorModuleData>;

/**
 * Persistence for user-created Co-Author modules (CS-24). Seed modules are
 * code-defined in the registry and never touch this table. CRUD mirrors the
 * shape of ScriptStore / LorebookStore: create returns the new row, update
 * merges a partial, delete is idempotent.
 */
export class CoauthorModuleStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  async list(): Promise<CoauthorModuleRow[]> {
    const rows = await this.db.select().from(coauthorModules).all();
    return rows.map((row) => this.mapRow(row));
  }

  async getById(id: string): Promise<CoauthorModuleRow | null> {
    const row = await this.db.select().from(coauthorModules).where(eq(coauthorModules.id, id)).get();
    return row ? this.mapRow(row) : null;
  }

  async create(data: CreateCoauthorModuleData): Promise<CoauthorModuleRow> {
    const id = this.idGen.next('cmod');
    const now = this.clock.now();
    await this.db
      .insert(coauthorModules)
      .values({
        id,
        name: data.name,
        description: data.description,
        basePrompt: data.basePrompt,
        openingMessage: data.openingMessage,
        skillIdsJson: JSON.stringify(data.skillIds),
        toolSetJson: JSON.stringify(data.toolSet),
        maxSteps: data.maxSteps,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const row = await this.getById(id);
    if (!row) throw new Error(`Co-Author module '${id}' not found after create`);
    return row;
  }

  async update(id: string, data: UpdateCoauthorModuleData): Promise<CoauthorModuleRow> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Co-Author module '${id}' not found`);

    const values: Partial<typeof coauthorModules.$inferInsert> = { updatedAt: this.clock.now() };
    if (data.name !== undefined) values.name = data.name;
    if (data.description !== undefined) values.description = data.description;
    if (data.basePrompt !== undefined) values.basePrompt = data.basePrompt;
    if (data.openingMessage !== undefined) values.openingMessage = data.openingMessage;
    if (data.skillIds !== undefined) values.skillIdsJson = JSON.stringify(data.skillIds);
    if (data.toolSet !== undefined) values.toolSetJson = JSON.stringify(data.toolSet);
    if (data.maxSteps !== undefined) values.maxSteps = data.maxSteps;

    await this.db.update(coauthorModules).set(values).where(eq(coauthorModules.id, id)).run();
    const row = await this.getById(id);
    if (!row) throw new Error(`Co-Author module '${id}' not found after update`);
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(coauthorModules).where(eq(coauthorModules.id, id)).run();
  }

  private mapRow(row: typeof coauthorModules.$inferSelect): CoauthorModuleRow {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      basePrompt: row.basePrompt,
      openingMessage: row.openingMessage,
      skillIds: parseStringArray(row.skillIdsJson),
      toolSet: parseToolSet(row.toolSetJson) as StoredCoauthorToolSet,
      maxSteps: row.maxSteps,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

/** Parse a JSON column that holds a string array, defending against malformed rows. */
function parseStringArray(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text || '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Parse a JSON column that holds a CoauthorToolSet, defending against malformed rows. */
function parseToolSet(text: string): Partial<Record<string, boolean>> {
  try {
    const parsed: unknown = JSON.parse(text || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    const raw = parsed as Partial<Record<string, boolean>>;
    // Legacy alias: `edit_profile` was renamed to `write_profile` (whole-document
    // write, to match the edit=search/replace vs write=full-replace taxonomy).
    // Modules saved before that rename carry `edit_profile`; normalize on read so
    // the tool stays enabled without a data migration. The registry reads toolSet
    // raw (it does not re-validate through the api-contracts schema), so this read
    // boundary is the single place the alias must live.
    if (raw.edit_profile !== undefined && raw.write_profile === undefined) {
      raw.write_profile = raw.edit_profile;
      delete raw.edit_profile;
    }
    return raw;
  } catch {
    return {};
  }
}
