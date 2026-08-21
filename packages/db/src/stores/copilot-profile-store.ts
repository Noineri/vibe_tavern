import { eq } from 'drizzle-orm';
import { copilotProfiles } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

/**
 * Stored tool-set shape. Structurally identical to the api-contracts
 * `CopilotToolSet` (a partial record of tool-name → enabled), but defined
 * locally because `@vibe-tavern/db` sits below `@vibe-tavern/api-contracts` in
 * the package graph and must not import it. The resolver coerces this to the
 * strict `CopilotToolSet` at resolve time. Unlike `StoredCoauthorToolSet`, it
 * carries NO legacy alias (the copilot toolSet has no renames to normalize).
 */
export type StoredCopilotToolSet = Partial<Record<string, boolean>>;

/**
 * Store-level copilot profile — a user-created profile projected from a DB row.
 * `isBuiltIn` is NOT stored (the built-in seed is code-defined and resolved
 * separately in CP-4); every row here is a user profile. `createdAt`/`updatedAt`
 * are kept for ordering and UI; they are dropped when mapped to the API
 * `CopilotProfile` shape. Leaner than `CoauthorModuleRow` — no `description`,
 * no `openingMessage` (the copilot is not a chat-mode and does not greet).
 */
export interface CopilotProfileRow {
  id: string;
  name: string;
  basePrompt: string;
  skillIds: string[];
  toolSet: StoredCopilotToolSet;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCopilotProfileData {
  name: string;
  basePrompt: string;
  skillIds: string[];
  toolSet: StoredCopilotToolSet;
}

export type UpdateCopilotProfileData = Partial<CreateCopilotProfileData>;

/**
 * Persistence for user-created experience-copilot profiles
 * (EXPERIENCE_COPILOT_PROFILES_PLAN, CP-3). The built-in "Experience Authoring"
 * profile is a code-defined read-only seed (CP-4) and never touches this table.
 * CRUD mirrors `CoauthorModuleStore`: create returns the new row, update merges
 * a partial, delete is idempotent.
 */
export class CopilotProfileStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  async list(): Promise<CopilotProfileRow[]> {
    const rows = await this.db.select().from(copilotProfiles).all();
    return rows.map((row) => this.mapRow(row));
  }

  async getById(id: string): Promise<CopilotProfileRow | null> {
    const row = await this.db.select().from(copilotProfiles).where(eq(copilotProfiles.id, id)).get();
    return row ? this.mapRow(row) : null;
  }

  async create(data: CreateCopilotProfileData): Promise<CopilotProfileRow> {
    const id = this.idGen.next('cprof');
    const now = this.clock.now();
    await this.db
      .insert(copilotProfiles)
      .values({
        id,
        name: data.name,
        basePrompt: data.basePrompt,
        skillIdsJson: JSON.stringify(data.skillIds),
        toolSetJson: JSON.stringify(data.toolSet),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const row = await this.getById(id);
    if (!row) throw new Error(`Copilot profile '${id}' not found after create`);
    return row;
  }

  async update(id: string, data: UpdateCopilotProfileData): Promise<CopilotProfileRow> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Copilot profile '${id}' not found`);

    const values: Partial<typeof copilotProfiles.$inferInsert> = { updatedAt: this.clock.now() };
    if (data.name !== undefined) values.name = data.name;
    if (data.basePrompt !== undefined) values.basePrompt = data.basePrompt;
    if (data.skillIds !== undefined) values.skillIdsJson = JSON.stringify(data.skillIds);
    if (data.toolSet !== undefined) values.toolSetJson = JSON.stringify(data.toolSet);

    await this.db.update(copilotProfiles).set(values).where(eq(copilotProfiles.id, id)).run();
    const row = await this.getById(id);
    if (!row) throw new Error(`Copilot profile '${id}' not found after update`);
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(copilotProfiles).where(eq(copilotProfiles.id, id)).run();
  }

  private mapRow(row: typeof copilotProfiles.$inferSelect): CopilotProfileRow {
    return {
      id: row.id,
      name: row.name,
      basePrompt: row.basePrompt,
      skillIds: parseStringArray(row.skillIdsJson),
      toolSet: parseToolSet(row.toolSetJson),
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

/** Parse a JSON column that holds a CopilotToolSet, defending against malformed rows. */
function parseToolSet(text: string): StoredCopilotToolSet {
  try {
    const parsed: unknown = JSON.parse(text || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as StoredCopilotToolSet;
  } catch {
    return {};
  }
}
