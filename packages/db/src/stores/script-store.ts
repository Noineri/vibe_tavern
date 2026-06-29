import { eq, and, or, asc, inArray } from 'drizzle-orm';
import { scripts, scriptLinks } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';
import type { ContentStore } from '../content-store.js';
import { STORAGE_FOLDERS } from '../file-store.js';

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

/**
 * Store-level Script — domain Script projected from a DB row.
 */
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

/**
 * Junction row: a script M:N-linked to a character or persona. Mirrors
 * `LorebookLink`. The script's home scope (FK on `scripts`) is tracked
 * separately; a link is an ADDITIONAL binding, not a replacement.
 */
export interface ScriptLink {
  scriptId: string;
  targetType: 'character' | 'persona';
  targetId: string;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class ScriptStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;
  private readonly content: ContentStore | null;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator; content?: ContentStore | null }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
    this.content = options?.content ?? null;
  }

  // ─── Read operations ───────────────────────────────────────────────────────

  async getById(id: string): Promise<Script | null> {
    const row = await this.db.select().from(scripts).where(eq(scripts.id, id)).get();
    if (!row) return null;

    // Lazy migration: generate file if it doesn't exist on disk
    if (this.content && !row.hasFileOnDisk) {
      const fileData = this.toFilePayload(row);
      const hash = await this.content.writeEntity(STORAGE_FOLDERS.scripts, id, fileData);
      await this.db.update(scripts)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(scripts.id, id))
        .run();
    }

    return this.mapRow(row);
  }

  async listByScope(scopeType: string, ownerId?: string): Promise<Script[]> {
    if (scopeType === 'global') {
      const rows = await this.db
        .select()
        .from(scripts)
        .where(eq(scripts.scopeType, 'global'))
        .orderBy(asc(scripts.sortOrder), asc(scripts.name))
        .all();
      return rows.map((r) => this.mapRow(r));
    }
    if (!ownerId) return [];
    const fkCol = scopeType === 'character' ? scripts.characterId
      : scopeType === 'persona' ? scripts.personaId
      : scripts.chatId;
    const directCondition = and(eq(scripts.scopeType, scopeType), eq(fkCol, ownerId));

    // Character/persona tabs show both directly scoped scripts and scripts
    // linked via the junction table (mirrors LorebookStore.listLorebooksByScope).
    // Chat scope remains direct-only — script_links supports character/persona
    // targets only, same as lorebook_links.
    if (scopeType === 'character' || scopeType === 'persona') {
      const linkedRows = await this.db
        .select({ scriptId: scriptLinks.scriptId })
        .from(scriptLinks)
        .where(and(eq(scriptLinks.targetType, scopeType), eq(scriptLinks.targetId, ownerId)))
        .all();
      const linkedIds = [...new Set(linkedRows.map((row) => row.scriptId))];
      const whereCondition = linkedIds.length > 0
        ? or(directCondition, inArray(scripts.id, linkedIds))
        : directCondition;
      const rows = await this.db
        .select()
        .from(scripts)
        .where(whereCondition)
        .orderBy(asc(scripts.scopeType), asc(scripts.sortOrder), asc(scripts.name))
        .all();
      return rows.map((r) => this.mapRow(r));
    }

    const rows = await this.db
      .select()
      .from(scripts)
      .where(directCondition)
      .orderBy(asc(scripts.sortOrder), asc(scripts.name))
      .all();
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * List ALL scripts across every scope, ordered for a stable overview view.
   * Mirrors `LorebookStore.listAllLorebooks` — the read-only "All" tab needs
   * the unfiltered set, ignoring ownerId.
   */
  async listAll(): Promise<Script[]> {
    const rows = await this.db
      .select()
      .from(scripts)
      .orderBy(asc(scripts.scopeType), asc(scripts.sortOrder), asc(scripts.name))
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

    // Dual-write: write canonical JSON file
    if (this.content) {
      const fileData = this.toFilePayload(row!);
      const hash = await this.content.writeEntity(STORAGE_FOLDERS.scripts, id, fileData);
      await this.db.update(scripts)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(scripts.id, id))
        .run();
    }

    return this.mapRow(row!);
  }

  async update(id: string, data: UpdateScriptData): Promise<Script> {
    const now = this.clock.now();
    const values: Partial<typeof scripts.$inferInsert> = { updatedAt: now };
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

    // Dual-write: update canonical JSON file
    if (this.content) {
      const fileData = this.toFilePayload(row);
      const hash = await this.content.writeEntity(STORAGE_FOLDERS.scripts, id, fileData);
      await this.db.update(scripts)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(scripts.id, id))
        .run();
    }

    return this.mapRow(row);
  }

  /** Atomically reassign a script's scope: clears ALL FK columns, then sets
   *  only the one matching `scopeType`. `ownerId` is null for 'global'.
   *  This is the safe write path for the persona/character binding UI — unlike
   *  a raw `update({ scopeType, personaId })`, it cannot leave a stale FK behind. */
  async setScope(id: string, scopeType: 'global' | 'character' | 'persona' | 'chat', ownerId: string | null): Promise<Script> {
    const now = this.clock.now();
    const values: Partial<typeof scripts.$inferInsert> = {
      updatedAt: now,
      scopeType,
      characterId: scopeType === 'character' ? ownerId : null,
      personaId: scopeType === 'persona' ? ownerId : null,
      chatId: scopeType === 'chat' ? ownerId : null,
    };
    const [row] = await this.db.update(scripts).set(values).where(eq(scripts.id, id)).returning();
    if (!row) throw new Error(`Script '${id}' not found after scope update`);
    if (this.content) {
      const fileData = this.toFilePayload(row);
      const hash = await this.content.writeEntity(STORAGE_FOLDERS.scripts, id, fileData);
      await this.db.update(scripts).set({ contentHash: hash, hasFileOnDisk: 1 }).where(eq(scripts.id, id)).run();
    }
    return this.mapRow(row);
  }

  async delete(id: string): Promise<void> {
    // Delete file from disk
    if (this.content) {
      await this.content.deleteEntity(STORAGE_FOLDERS.scripts, id);
    }

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
    const ids = new Set<string>();

    // FK-scoped sources: global, character-FK, persona-FK, chat-FK.
    const fkConditions = [
      eq(scripts.scopeType, 'global'),
      and(eq(scripts.scopeType, 'character'), eq(scripts.characterId, characterId)),
      and(eq(scripts.scopeType, 'chat'), eq(scripts.chatId, chatId)),
    ];
    if (personaId) {
      fkConditions.push(
        and(eq(scripts.scopeType, 'persona'), eq(scripts.personaId, personaId)),
      );
    }
    const fkRows = await this.db
      .select({ id: scripts.id })
      .from(scripts)
      .where(and(or(...fkConditions), eq(scripts.enabled, 1)))
      .all();
    for (const r of fkRows) ids.add(r.id);

    // Junction-linked sources (character ∪ persona). The resolver consults
    // BOTH FK and junction here. Scripts cannot rely on every FK-owned row
    // being junction-linked (the migration is incremental), so both sources
    // are unioned with Set-based dedup. LorebookStore.listAllActiveForChat
    // uses the same FK ∪ junction shape (fixed 2026-06-29 — see
    // packages/db/test/lorebook-fk-activation.test.ts); the two resolvers are
    // now consistent. Background in reports/script-link-binding-gap.md.
    const charLinkRows = await this.db
      .select({ scriptId: scriptLinks.scriptId })
      .from(scriptLinks)
      .innerJoin(scripts, and(eq(scriptLinks.scriptId, scripts.id), eq(scripts.enabled, 1)))
      .where(and(eq(scriptLinks.targetType, 'character'), eq(scriptLinks.targetId, characterId)))
      .all();
    for (const r of charLinkRows) ids.add(r.scriptId);

    if (personaId) {
      const personaLinkRows = await this.db
        .select({ scriptId: scriptLinks.scriptId })
        .from(scriptLinks)
        .innerJoin(scripts, and(eq(scriptLinks.scriptId, scripts.id), eq(scripts.enabled, 1)))
        .where(and(eq(scriptLinks.targetType, 'persona'), eq(scriptLinks.targetId, personaId)))
        .all();
      for (const r of personaLinkRows) ids.add(r.scriptId);
    }

    if (ids.size === 0) return [];

    const rows = await this.db
      .select()
      .from(scripts)
      .where(inArray(scripts.id, [...ids]))
      .all();

    return rows
      .map((r) => this.mapRow(r))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  // ─── Link management (mirrors LorebookStore link methods) ─────────────────

  /**
   * Get all junction links for a script (NOT its home-scope FK). These are the
   * ADDITIONAL character/persona bindings beyond the script's own scope.
   */
  async getLinks(scriptId: string): Promise<ScriptLink[]> {
    const rows = await this.db
      .select()
      .from(scriptLinks)
      .where(eq(scriptLinks.scriptId, scriptId))
      .all();
    return rows.map((r) => ({
      scriptId: r.scriptId,
      targetType: r.targetType as 'character' | 'persona',
      targetId: r.targetId,
    }));
  }

  /**
   * Replace all links for a script. Deletes existing and inserts new ones in a
   * transaction.
   */
  async setLinks(scriptId: string, links: Array<{ targetType: string; targetId: string }>): Promise<ScriptLink[]> {
    await this.db.transaction(async (tx) => {
      await tx.delete(scriptLinks).where(eq(scriptLinks.scriptId, scriptId)).run();
      for (const link of links) {
        await tx.insert(scriptLinks).values({
          scriptId,
          targetType: link.targetType,
          targetId: link.targetId,
        }).run();
      }
    });
    return this.getLinks(scriptId);
  }

  /**
   * Add a single link (idempotent — ignores duplicates).
   */
  async addLink(scriptId: string, targetType: string, targetId: string): Promise<void> {
    await this.db.insert(scriptLinks).values({
      scriptId,
      targetType,
      targetId,
    }).onConflictDoNothing().run();
  }

  /**
   * Remove a single link.
   */
  async removeLink(scriptId: string, targetType: string, targetId: string): Promise<void> {
    await this.db.delete(scriptLinks).where(
      and(
        eq(scriptLinks.scriptId, scriptId),
        eq(scriptLinks.targetType, targetType),
        eq(scriptLinks.targetId, targetId),
      ),
    ).run();
  }

  /**
   * Reverse query — list scripts M:N-linked to a given target (character or
   * persona), regardless of the script's own home scope. This is the
   * persona/character-editor view of "which scripts activate for me". Returns
   * links-only; FK-owned scripts surface via `listByScope` which unions FK +
   * links. Mirrors `LorebookStore.listLorebooksLinkedToTarget`.
   */
  async listScriptsLinkedToTarget(targetType: 'character' | 'persona', targetId: string): Promise<Script[]> {
    const linkedRows = await this.db
      .select({ scriptId: scriptLinks.scriptId })
      .from(scriptLinks)
      .where(and(eq(scriptLinks.targetType, targetType), eq(scriptLinks.targetId, targetId)))
      .all();
    const linkedIds = [...new Set(linkedRows.map((row) => row.scriptId))];
    if (linkedIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(scripts)
      .where(inArray(scripts.id, linkedIds))
      .orderBy(asc(scripts.sortOrder), asc(scripts.name))
      .all();
    return rows.map((r) => this.mapRow(r));
  }

  // ─── File payload ──────────────────────────────────────────────────────────

  private toFilePayload(row: typeof scripts.$inferSelect): Record<string, unknown> {
    return {
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
    };
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
