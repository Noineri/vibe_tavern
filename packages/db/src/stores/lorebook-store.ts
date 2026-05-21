import { eq, and, or } from 'drizzle-orm';
import { lorebooks, loreEntries } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

// ─── Input types ──────────────────────────────────────────────────────────────

export interface CreateLorebookData {
  name: string;
  description?: string;
  scopeType: string;
  scanDepth?: number;
  tokenBudget?: number;
  recursiveScanning?: boolean;
  sortOrder?: number;
  characterId?: string | null;
  personaId?: string | null;
  chatId?: string | null;
  extensions?: Record<string, unknown>;
}

export type UpdateLorebookData = Partial<CreateLorebookData>;

export interface CreateLoreEntryData {
  title?: string;
  content?: string;
  keys?: string[];
  secondaryKeys?: string[];
  logic?: string;
  position?: string;
  depth?: number;
  priority?: number;
  stickyWindow?: number;
  cooldownWindow?: number;
  delayWindow?: number;
  constant?: boolean;
  probability?: number;
  role?: string;
  group?: string;
  groupWeight?: number;
  prioritizeInclusion?: boolean;
  excludeRecursion?: boolean;
  preventRecursion?: boolean;
  delayUntilRecursion?: boolean;
  recursionLevel?: number;
  scanDepthOverride?: number | null;
  caseSensitive?: boolean;
  matchWholeWords?: boolean;
  characterFilter?: string[];
  characterFilterExclude?: boolean;
  triggers?: string[];
  matchSources?: string[];
  enabled?: boolean;
  sortOrder?: number;
  metadata?: Record<string, unknown>;
}

export type UpdateLoreEntryData = Partial<CreateLoreEntryData>;

// ─── Return types ─────────────────────────────────────────────────────────────

export interface Lorebook {
  id: string;
  name: string;
  description: string;
  scopeType: string;
  scanDepth: number;
  tokenBudget: number;
  recursiveScanning: boolean;
  sortOrder: number;
  characterId: string | null;
  personaId: string | null;
  chatId: string | null;
  extensions: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LoreEntry {
  id: string;
  lorebookId: string;
  title: string;
  content: string;
  keys: string[];
  secondaryKeys: string[];
  logic: string;
  position: string;
  depth: number;
  priority: number;
  stickyWindow: number;
  cooldownWindow: number;
  delayWindow: number;
  constant: boolean;
  probability: number;
  role: string;
  group: string;
  groupWeight: number;
  prioritizeInclusion: boolean;
  excludeRecursion: boolean;
  preventRecursion: boolean;
  delayUntilRecursion: boolean;
  recursionLevel: number;
  scanDepthOverride: number | null;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  characterFilter: string[];
  characterFilterExclude: boolean;
  triggers: string[];
  matchSources: string[];
  enabled: boolean;
  sortOrder: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class LorebookStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  // ─── Lorebook CRUD ─────────────────────────────────────────────────────────

  async getLorebook(id: string): Promise<Lorebook | null> {
    const row = await this.db.select().from(lorebooks).where(eq(lorebooks.id, id)).get();
    return row ? this.mapLorebookRow(row) : null;
  }

  async listLorebooksByScope(scopeType: string, ownerId?: string): Promise<Lorebook[]> {
    if (scopeType === 'global') {
      const rows = await this.db
        .select()
        .from(lorebooks)
        .where(and(eq(lorebooks.scopeType, 'global')))
        .all();
      return rows.map((r) => this.mapLorebookRow(r));
    }
    if (!ownerId) return [];
    const fkCol = scopeType === 'character' ? lorebooks.characterId
      : scopeType === 'persona' ? lorebooks.personaId
      : lorebooks.chatId;
    const rows = await this.db
      .select()
      .from(lorebooks)
      .where(and(eq(lorebooks.scopeType, scopeType), eq(fkCol, ownerId)))
      .all();
    return rows.map((r) => this.mapLorebookRow(r));
  }

  async createLorebook(data: CreateLorebookData): Promise<Lorebook> {
    const id = this.idGen.next('lorebook');
    const now = this.clock.now();
    const [row] = await this.db
      .insert(lorebooks)
      .values({
        id,
        name: data.name,
        description: data.description ?? '',
        scopeType: data.scopeType,
        scanDepth: data.scanDepth ?? 50,
        tokenBudget: data.tokenBudget ?? 1000,
        recursiveScanning: (data.recursiveScanning ?? false) ? 1 : 0,
        sortOrder: data.sortOrder ?? 0,
        characterId: data.characterId ?? null,
        personaId: data.personaId ?? null,
        chatId: data.chatId ?? null,
        extensionsJson: JSON.stringify(data.extensions ?? {}),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return this.mapLorebookRow(row!);
  }

  async updateLorebook(id: string, data: UpdateLorebookData): Promise<Lorebook> {
    const now = this.clock.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const values: Record<string, any> = { updatedAt: now };
    if (data.name !== undefined) values.name = data.name;
    if (data.description !== undefined) values.description = data.description;
    if (data.scopeType !== undefined) values.scopeType = data.scopeType;
    if (data.scanDepth !== undefined) values.scanDepth = data.scanDepth;
    if (data.tokenBudget !== undefined) values.tokenBudget = data.tokenBudget;
    if (data.recursiveScanning !== undefined) values.recursiveScanning = data.recursiveScanning ? 1 : 0;
    if (data.sortOrder !== undefined) values.sortOrder = data.sortOrder;
    if (data.characterId !== undefined) values.characterId = data.characterId;
    if (data.personaId !== undefined) values.personaId = data.personaId;
    if (data.chatId !== undefined) values.chatId = data.chatId;
    if (data.extensions !== undefined) values.extensionsJson = JSON.stringify(data.extensions);

    const [row] = await this.db
      .update(lorebooks)
      .set(values)
      .where(eq(lorebooks.id, id))
      .returning();
    if (!row) throw new Error(`Lorebook '${id}' not found after update`);
    return this.mapLorebookRow(row);
  }

  async deleteLorebook(id: string): Promise<void> {
    await this.db.delete(lorebooks).where(eq(lorebooks.id, id)).run();
  }

  // ─── Lore Entry CRUD ───────────────────────────────────────────────────────

  async getEntry(id: string): Promise<LoreEntry | null> {
    const row = await this.db.select().from(loreEntries).where(eq(loreEntries.id, id)).get();
    return row ? this.mapEntryRow(row) : null;
  }

  async listEntries(lorebookId: string): Promise<LoreEntry[]> {
    const rows = await this.db
      .select()
      .from(loreEntries)
      .where(eq(loreEntries.lorebookId, lorebookId))
      .all();
    return rows.map((r) => this.mapEntryRow(r));
  }

  async createEntry(lorebookId: string, data: CreateLoreEntryData): Promise<LoreEntry> {
    const id = this.idGen.next('lore_entry');
    const now = this.clock.now();
    const [row] = await this.db
      .insert(loreEntries)
      .values({
        id,
        lorebookId,
        title: data.title ?? '',
        content: data.content ?? '',
        keysJson: JSON.stringify(data.keys ?? []),
        secondaryKeysJson: JSON.stringify(data.secondaryKeys ?? []),
        logic: data.logic ?? 'and_any',
        position: data.position ?? 'in_prompt',
        depth: data.depth ?? 4,
        priority: data.priority ?? 100,
        stickyWindow: data.stickyWindow ?? 0,
        cooldownWindow: data.cooldownWindow ?? 0,
        delayWindow: data.delayWindow ?? 0,
        constant: (data.constant ?? false) ? 1 : 0,
        probability: data.probability ?? 100,
        role: data.role ?? 'system',
        groupName: data.group ?? '',
        groupWeight: data.groupWeight ?? 100,
        prioritizeInclusion: (data.prioritizeInclusion ?? false) ? 1 : 0,
        excludeRecursion: (data.excludeRecursion ?? false) ? 1 : 0,
        preventRecursion: (data.preventRecursion ?? false) ? 1 : 0,
        delayUntilRecursion: (data.delayUntilRecursion ?? false) ? 1 : 0,
        recursionLevel: data.recursionLevel ?? 0,
        scanDepthOverride: data.scanDepthOverride ?? null,
        caseSensitive: (data.caseSensitive ?? false) ? 1 : 0,
        matchWholeWords: (data.matchWholeWords ?? false) ? 1 : 0,
        characterFilterJson: JSON.stringify(data.characterFilter ?? []),
        characterFilterExclude: (data.characterFilterExclude ?? false) ? 1 : 0,
        triggersJson: JSON.stringify(data.triggers ?? []),
        matchSourcesJson: JSON.stringify(data.matchSources ?? []),
        enabled: (data.enabled ?? true) ? 1 : 0,
        sortOrder: data.sortOrder ?? 0,
        metadataJson: JSON.stringify(data.metadata ?? {}),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return this.mapEntryRow(row!);
  }

  async updateEntry(id: string, data: UpdateLoreEntryData): Promise<LoreEntry> {
    const now = this.clock.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const values: Record<string, any> = { updatedAt: now };
    if (data.title !== undefined) values.title = data.title;
    if (data.content !== undefined) values.content = data.content;
    if (data.keys !== undefined) values.keysJson = JSON.stringify(data.keys);
    if (data.secondaryKeys !== undefined) values.secondaryKeysJson = JSON.stringify(data.secondaryKeys);
    if (data.logic !== undefined) values.logic = data.logic;
    if (data.position !== undefined) values.position = data.position;
    if (data.depth !== undefined) values.depth = data.depth;
    if (data.priority !== undefined) values.priority = data.priority;
    if (data.stickyWindow !== undefined) values.stickyWindow = data.stickyWindow;
    if (data.cooldownWindow !== undefined) values.cooldownWindow = data.cooldownWindow;
    if (data.delayWindow !== undefined) values.delayWindow = data.delayWindow;
    if (data.constant !== undefined) values.constant = data.constant ? 1 : 0;
    if (data.probability !== undefined) values.probability = data.probability;
    if (data.role !== undefined) values.role = data.role;
    if (data.group !== undefined) values.groupName = data.group;
    if (data.groupWeight !== undefined) values.groupWeight = data.groupWeight;
    if (data.prioritizeInclusion !== undefined) values.prioritizeInclusion = data.prioritizeInclusion ? 1 : 0;
    if (data.excludeRecursion !== undefined) values.excludeRecursion = data.excludeRecursion ? 1 : 0;
    if (data.preventRecursion !== undefined) values.preventRecursion = data.preventRecursion ? 1 : 0;
    if (data.delayUntilRecursion !== undefined) values.delayUntilRecursion = data.delayUntilRecursion ? 1 : 0;
    if (data.recursionLevel !== undefined) values.recursionLevel = data.recursionLevel;
    if (data.scanDepthOverride !== undefined) values.scanDepthOverride = data.scanDepthOverride;
    if (data.caseSensitive !== undefined) values.caseSensitive = data.caseSensitive ? 1 : 0;
    if (data.matchWholeWords !== undefined) values.matchWholeWords = data.matchWholeWords ? 1 : 0;
    if (data.characterFilter !== undefined) values.characterFilterJson = JSON.stringify(data.characterFilter);
    if (data.characterFilterExclude !== undefined) values.characterFilterExclude = data.characterFilterExclude ? 1 : 0;
    if (data.triggers !== undefined) values.triggersJson = JSON.stringify(data.triggers);
    if (data.matchSources !== undefined) values.matchSourcesJson = JSON.stringify(data.matchSources);
    if (data.enabled !== undefined) values.enabled = data.enabled ? 1 : 0;
    if (data.sortOrder !== undefined) values.sortOrder = data.sortOrder;
    if (data.metadata !== undefined) values.metadataJson = JSON.stringify(data.metadata);

    const [row] = await this.db
      .update(loreEntries)
      .set(values)
      .where(eq(loreEntries.id, id))
      .returning();
    if (!row) throw new Error(`LoreEntry '${id}' not found after update`);
    return this.mapEntryRow(row);
  }

  async deleteEntry(id: string): Promise<void> {
    await this.db.delete(loreEntries).where(eq(loreEntries.id, id)).run();
  }

  // ─── Scope-aware listing (pipeline entry point) ────────────────────────────

  /**
   * Returns all lorebooks visible to a chat session across all scopes,
   * plus their enabled entries.
   *
   * Scope resolution order: global → character → persona → chat.
   * Only enabled entries are included.
   */
  async listAllActiveForChat(
    characterId: string,
    personaId: string | null,
    chatId: string,
  ): Promise<Array<{ lorebook: Lorebook; entries: LoreEntry[] }>> {
    const conditions = [
      eq(lorebooks.scopeType, 'global'),
      and(eq(lorebooks.scopeType, 'character'), eq(lorebooks.characterId, characterId)),
      and(eq(lorebooks.scopeType, 'chat'), eq(lorebooks.chatId, chatId)),
    ];
    if (personaId) {
      conditions.push(
        and(eq(lorebooks.scopeType, 'persona'), eq(lorebooks.personaId, personaId)),
      );
    }

    const bookRows = await this.db
      .select()
      .from(lorebooks)
      .where(or(...conditions))
      .all();

    const result: Array<{ lorebook: Lorebook; entries: LoreEntry[] }> = [];

    for (const bookRow of bookRows) {
      const entryRows = await this.db
        .select()
        .from(loreEntries)
        .where(
          and(
            eq(loreEntries.lorebookId, bookRow.id),
            eq(loreEntries.enabled, 1),
          ),
        )
        .all();

      result.push({
        lorebook: this.mapLorebookRow(bookRow),
        entries: entryRows.map((r) => this.mapEntryRow(r)),
      });
    }

    return result;
  }

  // ─── Row mappers ───────────────────────────────────────────────────────────

  private mapLorebookRow(row: typeof lorebooks.$inferSelect): Lorebook {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      scopeType: row.scopeType,
      scanDepth: row.scanDepth,
      tokenBudget: row.tokenBudget,
      recursiveScanning: row.recursiveScanning === 1,
      sortOrder: row.sortOrder,
      characterId: row.characterId,
      personaId: row.personaId,
      chatId: row.chatId,
      extensions: JSON.parse(row.extensionsJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapEntryRow(row: typeof loreEntries.$inferSelect): LoreEntry {
    return {
      id: row.id,
      lorebookId: row.lorebookId,
      title: row.title,
      content: row.content,
      keys: JSON.parse(row.keysJson),
      secondaryKeys: JSON.parse(row.secondaryKeysJson),
      logic: row.logic,
      position: row.position,
      depth: row.depth,
      priority: row.priority,
      stickyWindow: row.stickyWindow,
      cooldownWindow: row.cooldownWindow,
      delayWindow: row.delayWindow,
      constant: row.constant === 1,
      probability: row.probability,
      role: row.role,
      group: row.groupName,
      groupWeight: row.groupWeight,
      prioritizeInclusion: row.prioritizeInclusion === 1,
      excludeRecursion: row.excludeRecursion === 1,
      preventRecursion: row.preventRecursion === 1,
      delayUntilRecursion: row.delayUntilRecursion === 1,
      recursionLevel: row.recursionLevel,
      scanDepthOverride: row.scanDepthOverride,
      caseSensitive: row.caseSensitive === 1,
      matchWholeWords: row.matchWholeWords === 1,
      characterFilter: JSON.parse(row.characterFilterJson),
      characterFilterExclude: row.characterFilterExclude === 1,
      triggers: JSON.parse(row.triggersJson),
      matchSources: JSON.parse(row.matchSourcesJson),
      enabled: row.enabled === 1,
      sortOrder: row.sortOrder,
      metadata: JSON.parse(row.metadataJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
