import { and, asc, eq, sql } from 'drizzle-orm';
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
 * separately in CP-4); every row here is a user profile. `sortOrder` is the
 * manual list order WITHIN the profile's agent kind (ML-6; new profiles
 * append at the end of their kind's list, `reorder` rewrites it).
 * `createdAt`/`updatedAt` are kept for the store's total ordering and UI;
 * they are dropped when mapped to the API `CopilotProfile` shape. Leaner
 * than `CoauthorModuleRow` — no `description`,
 * no `openingMessage` (the copilot is not a chat-mode and does not greet), and
 * no `skillIds` (PM-8, owner ruling 2026-10-12: the skill catalog is ungated —
 * the legacy `skill_ids_json` column is never read or written; existing rows
 * keep their data untouched and are simply ignored).
 */
export interface CopilotProfileRow {
  id: string;
  name: string;
  basePrompt: string;
  toolSet: StoredCopilotToolSet;
  /** Owning agent kind (AS-3) — 'experience' for every pre-AS-3 row (the
   *  column default); immutable after create (update never writes it). */
  agentKind: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCopilotProfileData {
  name: string;
  basePrompt: string;
  toolSet: StoredCopilotToolSet;
  /** Omitted = 'experience' (the current web client sends no kind). */
  agentKind?: string;
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

  async list(kind?: string): Promise<CopilotProfileRow[]> {
    // Total ordering for the per-kind master list (ML-6): stored order first,
    // with a created_at → id fallback so ties (rows sharing the migration
    // backfill's default) still resolve deterministically. The unfiltered
    // list uses the same total order (no consumer depends on kind grouping
    // there — the adapter always filters).
    const order = [asc(copilotProfiles.sortOrder), asc(copilotProfiles.createdAt), asc(copilotProfiles.id)];
    const rows = kind === undefined
      ? await this.db.select().from(copilotProfiles).orderBy(...order).all()
      : await this.db.select().from(copilotProfiles).where(eq(copilotProfiles.agentKind, kind)).orderBy(...order).all();
    return rows.map((row) => this.mapRow(row));
  }

  async getById(id: string): Promise<CopilotProfileRow | null> {
    const row = await this.db.select().from(copilotProfiles).where(eq(copilotProfiles.id, id)).get();
    return row ? this.mapRow(row) : null;
  }

  async create(data: CreateCopilotProfileData): Promise<CopilotProfileRow> {
    const id = this.idGen.next('cprof');
    const now = this.clock.now();
    // Append at the end of THIS kind's list: sort_order = the kind's current
    // max + 1 (see CoauthorModuleStore.create / ProxyStore.create — the
    // store list-order rule, scoped by AS-3's kind dimension because the
    // ML-6 order lives within one kind's list).
    const agentKind = data.agentKind ?? 'experience';
    const maxRow = await this.db
      .select({ maxSort: sql<number>`COALESCE(MAX(${copilotProfiles.sortOrder}), -1)` })
      .from(copilotProfiles)
      .where(eq(copilotProfiles.agentKind, agentKind))
      .get();
    const nextSortOrder = (maxRow?.maxSort ?? -1) + 1;
    await this.db
      .insert(copilotProfiles)
      .values({
        id,
        name: data.name,
        basePrompt: data.basePrompt,
        toolSetJson: JSON.stringify(data.toolSet),
        agentKind,
        sortOrder: nextSortOrder,
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

    // AS-3: `agent_kind` is immutable — intentionally no branch for it here,
    // so an update can never convert a profile to another kind.
    const values: Partial<typeof copilotProfiles.$inferInsert> = { updatedAt: this.clock.now() };
    if (data.name !== undefined) values.name = data.name;
    if (data.basePrompt !== undefined) values.basePrompt = data.basePrompt;
    if (data.toolSet !== undefined) values.toolSetJson = JSON.stringify(data.toolSet);

    await this.db.update(copilotProfiles).set(values).where(eq(copilotProfiles.id, id)).run();
    const row = await this.getById(id);
    if (!row) throw new Error(`Copilot profile '${id}' not found after update`);
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(copilotProfiles).where(eq(copilotProfiles.id, id)).run();
  }

  /**
   * Rewrite the manual list order within ONE agent kind's list (ML-6). All
   * position updates run in ONE synchronous transaction (the ProxyStore /
   * CoauthorModuleStore.reorder pattern — drizzle-orm + bun:sqlite commits at
   * the end of the synchronous callback, so a throw rolls back every position
   * write). The WHERE pins BOTH the id and the kind: an update entry for
   * another kind's row is a no-op, so an id list can never rewrite another
   * kind's positions. Returns the kind's list in its new stored order.
   */
  async reorder(kind: string, updates: Array<{ id: string; sortOrder: number }>): Promise<CopilotProfileRow[]> {
    const now = this.clock.now();
    this.db.transaction((tx) => {
      for (const u of updates) {
        tx
          .update(copilotProfiles)
          .set({ sortOrder: u.sortOrder, updatedAt: now })
          .where(and(eq(copilotProfiles.id, u.id), eq(copilotProfiles.agentKind, kind)))
          .run();
      }
    });
    return this.list(kind);
  }

  private mapRow(row: typeof copilotProfiles.$inferSelect): CopilotProfileRow {
    return {
      id: row.id,
      name: row.name,
      basePrompt: row.basePrompt,
      toolSet: parseToolSet(row.toolSetJson),
      agentKind: row.agentKind,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
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
