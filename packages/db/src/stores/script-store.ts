import { eq, and, or } from 'drizzle-orm';
import { scripts } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

// ─── Input types ──────────────────────────────────────────────────────────────

export interface CreateScriptData {
  name: string;
  description?: string;
  code?: string;
  enabled?: boolean;
  scopeType?: string;
  sortOrder?: number;
  characterId?: string | null;
  personaId?: string | null;
  chatId?: string | null;
  extensions?: Record<string, unknown>;
}

export type UpdateScriptData = Partial<CreateScriptData>;

// ─── Return type ──────────────────────────────────────────────────────────────

export interface Script {
  id: string;
  name: string;
  description: string;
  code: string;
  enabled: boolean;
  scopeType: string;
  sortOrder: number;
  characterId: string | null;
  personaId: string | null;
  chatId: string | null;
  extensions: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class ScriptStore {
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

  async getById(id: string): Promise<Script | null> {
    const row = await this.db.select().from(scripts).where(eq(scripts.id, id)).get();
    return row ? this.mapRow(row) : null;
  }

  async listByScope(scopeType: string, ownerId?: string): Promise<Script[]> {
    if (scopeType === 'global') {
      const rows = await this.db
        .select()
        .from(scripts)
        .where(eq(scripts.scopeType, 'global'))
        .all();
      return rows.map((r) => this.mapRow(r));
    }
    if (!ownerId) return [];
    const fkCol = scopeType === 'character' ? scripts.characterId
      : scopeType === 'persona' ? scripts.personaId
      : scripts.chatId;
    const rows = await this.db
      .select()
      .from(scripts)
      .where(and(eq(scripts.scopeType, scopeType), eq(fkCol, ownerId)))
      .all();
    return rows.map((r) => this.mapRow(r));
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  async create(data: CreateScriptData): Promise<Script> {
    const id = this.idGen.next('script');
    const now = this.clock.now();
    const [row] = await this.db
      .insert(scripts)
      .values({
        id,
        name: data.name,
        description: data.description ?? '',
        code: data.code ?? '',
        enabled: (data.enabled ?? true) ? 1 : 0,
        scopeType: data.scopeType ?? 'character',
        sortOrder: data.sortOrder ?? 0,
        characterId: data.characterId ?? null,
        personaId: data.personaId ?? null,
        chatId: data.chatId ?? null,
        extensionsJson: JSON.stringify(data.extensions ?? {}),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return this.mapRow(row!);
  }

  async update(id: string, data: UpdateScriptData): Promise<Script> {
    const now = this.clock.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const values: Record<string, any> = { updatedAt: now };
    if (data.name !== undefined) values.name = data.name;
    if (data.description !== undefined) values.description = data.description;
    if (data.code !== undefined) values.code = data.code;
    if (data.enabled !== undefined) values.enabled = data.enabled ? 1 : 0;
    if (data.scopeType !== undefined) values.scopeType = data.scopeType;
    if (data.sortOrder !== undefined) values.sortOrder = data.sortOrder;
    if (data.characterId !== undefined) values.characterId = data.characterId;
    if (data.personaId !== undefined) values.personaId = data.personaId;
    if (data.chatId !== undefined) values.chatId = data.chatId;
    if (data.extensions !== undefined) values.extensionsJson = JSON.stringify(data.extensions);

    const [row] = await this.db
      .update(scripts)
      .set(values)
      .where(eq(scripts.id, id))
      .returning();
    if (!row) throw new Error(`Script '${id}' not found after update`);
    return this.mapRow(row);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(scripts).where(eq(scripts.id, id)).run();
  }

  // ─── Scope-aware listing (pipeline entry point) ────────────────────────────

  /**
   * Returns all enabled scripts visible to a chat session across all scopes,
   * sorted by sortOrder.
   *
   * Scope resolution: global → character → persona → chat.
   * Scripts run synchronously in this order — script #2 can read state from script #1.
   */
  async listAllEnabledForChat(
    characterId: string,
    personaId: string | null,
    chatId: string,
  ): Promise<Script[]> {
    const conditions = [
      eq(scripts.scopeType, 'global'),
      eq(scripts.characterId, characterId),
      eq(scripts.chatId, chatId),
    ];
    if (personaId) {
      conditions.push(eq(scripts.personaId, personaId));
    }

    const rows = await this.db
      .select()
      .from(scripts)
      .where(
        and(
          or(...conditions),
          eq(scripts.enabled, 1),
        ),
      )
      .all();

    return rows
      .map((r) => this.mapRow(r))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  // ─── Row mapper ────────────────────────────────────────────────────────────

  private mapRow(row: typeof scripts.$inferSelect): Script {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      code: row.code,
      enabled: row.enabled === 1,
      scopeType: row.scopeType,
      sortOrder: row.sortOrder,
      characterId: row.characterId,
      personaId: row.personaId,
      chatId: row.chatId,
      extensions: JSON.parse(row.extensionsJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
