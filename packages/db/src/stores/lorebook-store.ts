import { eq, and, or } from 'drizzle-orm';
import { lorebooks, loreEntries } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';
import type { ContentStore } from '../content-store.js';
import { STORAGE_FOLDERS } from '../file-store.js';

// ─── Input types ──────────────────────────────────────────────────────────────

export interface CreateLorebookData {
  name: string;
  description?: string;
  scopeType: string;
  scanDepth?: number;
  tokenBudget?: number;
  recursiveScanning?: boolean;
  maxRecursionSteps?: number;
  includeNames?: boolean;
  minActivations?: number;
  minActivationsDepthMax?: number;
  overflowAlert?: boolean;
  characterStrategy?: number;
  sortOrder?: number;
  enabled?: boolean;
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
  ignoreBudget?: boolean;
  role?: string;
  group?: string;
  /** Alias accepted from API (Zod schema uses groupName) */
  groupName?: string;
  groupWeight?: number;
  prioritizeInclusion?: boolean;
  useGroupScoring?: boolean;
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
  automationId?: string;
  metadata?: Record<string, unknown>;
}

export type UpdateLoreEntryData = Partial<CreateLoreEntryData>;

// ─── Return types ─────────────────────────────────────────────────────────────

/**
 * Store-level Lorebook — domain Lorebook projected from a DB row.
 * Uses plain `string` IDs (brands are applied at the API boundary).
 */
export interface Lorebook {
  id: string;
  name: string;
  description: string;
  scopeType: string;
  scanDepth: number;
  tokenBudget: number;
  recursiveScanning: boolean;
  maxRecursionSteps: number;
  includeNames: boolean;
  minActivations: number;
  minActivationsDepthMax: number;
  overflowAlert: boolean;
  characterStrategy: number;
  sortOrder: number;
  enabled: boolean;
  characterId: string | null;
  personaId: string | null;
  chatId: string | null;
  extensions: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Store-level LoreEntry — domain LoreEntry projected from a DB row.
 */
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
  ignoreBudget: boolean;
  role: string;
  group: string;
  groupWeight: number;
  prioritizeInclusion: boolean;
  useGroupScoring: boolean;
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
  automationId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class LorebookStore {
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

  // ─── Lorebook CRUD ─────────────────────────────────────────────────────────

  async getLorebook(id: string): Promise<Lorebook | null> {
    const row = await this.db.select().from(lorebooks).where(eq(lorebooks.id, id)).get();
    if (!row) return null;

    // Lazy migration: generate file if it doesn't exist on disk
    if (this.content && !row.hasFileOnDisk) {
      await this.syncFile(id);
    }

    return this.mapLorebookRow(row);
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
        maxRecursionSteps: data.maxRecursionSteps ?? 5,
        includeNames: data.includeNames ? 1 : 0,
        minActivations: data.minActivations ?? 0,
        minActivationsDepthMax: data.minActivationsDepthMax ?? 0,
        overflowAlert: data.overflowAlert ? 1 : 0,
        characterStrategy: data.characterStrategy ?? 0,
        sortOrder: data.sortOrder ?? 0,
        enabled: (data.enabled ?? true) ? 1 : 0,
        characterId: data.characterId ?? null,
        personaId: data.personaId ?? null,
        chatId: data.chatId ?? null,
        extensionsJson: JSON.stringify(data.extensions ?? {}),
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // Dual-write: write canonical JSON file (entries will be empty at this point)
    if (this.content) {
      await this.syncFile(id);
    }

    return this.mapLorebookRow(row!);
  }

  async updateLorebook(id: string, data: UpdateLorebookData): Promise<Lorebook> {
    const now = this.clock.now();
    const values: Partial<typeof lorebooks.$inferInsert> = { updatedAt: now };
    if (data.scopeType !== undefined) values.scopeType = data.scopeType;
    if (data.scanDepth !== undefined) values.scanDepth = data.scanDepth;
    if (data.tokenBudget !== undefined) values.tokenBudget = data.tokenBudget;
    if (data.recursiveScanning !== undefined) values.recursiveScanning = data.recursiveScanning ? 1 : 0;
    if (data.maxRecursionSteps !== undefined) values.maxRecursionSteps = data.maxRecursionSteps;
    if (data.includeNames !== undefined) values.includeNames = data.includeNames ? 1 : 0;
    if (data.minActivations !== undefined) values.minActivations = data.minActivations;
    if (data.minActivationsDepthMax !== undefined) values.minActivationsDepthMax = data.minActivationsDepthMax;
    if (data.overflowAlert !== undefined) values.overflowAlert = data.overflowAlert ? 1 : 0;
    if (data.characterStrategy !== undefined) values.characterStrategy = data.characterStrategy;
    if (data.sortOrder !== undefined) values.sortOrder = data.sortOrder;
    if (data.enabled !== undefined) values.enabled = data.enabled ? 1 : 0;
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

    // Dual-write: update canonical JSON file
    if (this.content) {
      await this.syncFile(id);
    }

    return this.mapLorebookRow(row);
  }

  async deleteLorebook(id: string): Promise<void> {
    // Delete file from disk
    if (this.content) {
      await this.content.deleteEntity(STORAGE_FOLDERS.lorebooks, id);
    }
    await this.db.delete(lorebooks).where(eq(lorebooks.id, id)).run();
  }

  async deleteAllEntries(lorebookId: string): Promise<void> {
    await this.db.delete(loreEntries).where(eq(loreEntries.lorebookId, lorebookId)).run();

    // Sync file: all entries removed
    if (this.content) {
      await this.syncFile(lorebookId);
    }
  }

  async bulkCreateEntries(lorebookId: string, entries: CreateLoreEntryData[]): Promise<number> {
    let count = 0;
    for (const data of entries) {
      await this.createEntry(lorebookId, data);
      count++;
    }
    return count;
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
        ignoreBudget: data.ignoreBudget ? 1 : 0,
        role: data.role ?? 'system',
        groupName: data.group ?? '',
        groupWeight: data.groupWeight ?? 100,
        prioritizeInclusion: (data.prioritizeInclusion ?? false) ? 1 : 0,
        useGroupScoring: (data.useGroupScoring ?? false) ? 1 : 0,
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
        automationId: data.automationId ?? "",
        metadataJson: JSON.stringify(data.metadata ?? {}),
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // Sync file: entry added
    if (this.content) {
      await this.syncFile(lorebookId);
    }

    return this.mapEntryRow(row!);
  }

  async updateEntry(id: string, data: UpdateLoreEntryData): Promise<LoreEntry> {
    const now = this.clock.now();
    const values: Partial<typeof loreEntries.$inferInsert> = { updatedAt: now };
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
    if (data.ignoreBudget !== undefined) values.ignoreBudget = data.ignoreBudget ? 1 : 0;
    if (data.role !== undefined) values.role = data.role;
    if (data.group !== undefined) values.groupName = data.group;
    if (data.groupName !== undefined) values.groupName = data.groupName;
    if (data.groupWeight !== undefined) values.groupWeight = data.groupWeight;
    if (data.prioritizeInclusion !== undefined) values.prioritizeInclusion = data.prioritizeInclusion ? 1 : 0;
    if (data.useGroupScoring !== undefined) values.useGroupScoring = data.useGroupScoring ? 1 : 0;
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
    if (data.automationId !== undefined) values.automationId = data.automationId;
    if (data.metadata !== undefined) values.metadataJson = JSON.stringify(data.metadata);

    const [row] = await this.db
      .update(loreEntries)
      .set(values)
      .where(eq(loreEntries.id, id))
      .returning();
    if (!row) throw new Error(`LoreEntry '${id}' not found after update`);

    // Sync file: entry updated
    if (this.content) {
      await this.syncFile(row.lorebookId);
    }

    return this.mapEntryRow(row);
  }

  async deleteEntry(id: string): Promise<void> {
    // Fetch entry first to get lorebookId for file sync
    const entry = await this.db.select({ lorebookId: loreEntries.lorebookId })
      .from(loreEntries)
      .where(eq(loreEntries.id, id))
      .get();
    const lorebookId = entry?.lorebookId;

    await this.db.delete(loreEntries).where(eq(loreEntries.id, id)).run();

    // Sync file: entry removed
    if (this.content && lorebookId) {
      await this.syncFile(lorebookId);
    }
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
      // Skip disabled lorebooks
      if (bookRow.enabled === 0) continue;

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

  // ─── Dual-write helpers ────────────────────────────────────────────────────

  /**
   * Regenerate the canonical lorebook JSON file (lorebook metadata + all entries).
   * Reads latest state from SQLite, builds payload, writes to ContentStore,
   * and updates contentHash + hasFileOnDisk on the lorebook row.
   */
  private async syncFile(lorebookId: string): Promise<void> {
    if (!this.content) return;

    const row = await this.db.select().from(lorebooks).where(eq(lorebooks.id, lorebookId)).get();
    if (!row) return;

    const entryRows = await this.db.select().from(loreEntries).where(eq(loreEntries.lorebookId, lorebookId)).all();
    const fileData = this.toFilePayload(row, entryRows);
    const hash = await this.content.writeEntity(STORAGE_FOLDERS.lorebooks, lorebookId, fileData);

    await this.db.update(lorebooks)
      .set({ contentHash: hash, hasFileOnDisk: 1 })
      .where(eq(lorebooks.id, lorebookId))
      .run();
  }

  private toFilePayload(
    row: typeof lorebooks.$inferSelect,
    entryRows: Array<typeof loreEntries.$inferSelect>,
  ): Record<string, unknown> {
    return {
      name: row.name,
      description: row.description,
      scopeType: row.scopeType,
      scanDepth: row.scanDepth,
      tokenBudget: row.tokenBudget,
      recursiveScanning: row.recursiveScanning === 1,
      maxRecursionSteps: row.maxRecursionSteps,
      includeNames: row.includeNames === 1,
      minActivations: row.minActivations,
      minActivationsDepthMax: row.minActivationsDepthMax,
      overflowAlert: row.overflowAlert === 1,
      characterStrategy: row.characterStrategy,
      sortOrder: row.sortOrder,
      enabled: row.enabled === 1,
      characterId: row.characterId,
      personaId: row.personaId,
      chatId: row.chatId,
      extensions: JSON.parse(row.extensionsJson),
      entries: entryRows.map((e) => ({
        id: e.id,
        title: e.title,
        content: e.content,
        keys: JSON.parse(e.keysJson),
        secondaryKeys: JSON.parse(e.secondaryKeysJson),
        logic: e.logic,
        position: e.position,
        depth: e.depth,
        priority: e.priority,
        stickyWindow: e.stickyWindow,
        cooldownWindow: e.cooldownWindow,
        delayWindow: e.delayWindow,
        constant: e.constant === 1,
        probability: e.probability,
        ignoreBudget: e.ignoreBudget ?? false,
        role: e.role,
        group: e.groupName,
        groupWeight: e.groupWeight,
        prioritizeInclusion: e.prioritizeInclusion === 1,
        excludeRecursion: e.excludeRecursion === 1,
        preventRecursion: e.preventRecursion === 1,
        delayUntilRecursion: e.delayUntilRecursion === 1,
        recursionLevel: e.recursionLevel,
        scanDepthOverride: e.scanDepthOverride,
        caseSensitive: e.caseSensitive === 1,
        matchWholeWords: e.matchWholeWords === 1,
        characterFilter: JSON.parse(e.characterFilterJson),
        characterFilterExclude: e.characterFilterExclude === 1,
        triggers: JSON.parse(e.triggersJson),
        matchSources: JSON.parse(e.matchSourcesJson),
        enabled: e.enabled === 1,
        sortOrder: e.sortOrder,
        metadata: JSON.parse(e.metadataJson),
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      })),
    };
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
      maxRecursionSteps: row.maxRecursionSteps,
      includeNames: row.includeNames === 1,
      minActivations: row.minActivations,
      minActivationsDepthMax: row.minActivationsDepthMax,
      overflowAlert: row.overflowAlert === 1,
      characterStrategy: row.characterStrategy,
      sortOrder: row.sortOrder,
      enabled: row.enabled === 1,
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
      ignoreBudget: row.ignoreBudget === 1,
      role: row.role,
      group: row.groupName,
      groupWeight: row.groupWeight,
      prioritizeInclusion: row.prioritizeInclusion === 1,
      useGroupScoring: row.useGroupScoring === 1,
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
      automationId: row.automationId,
      metadata: JSON.parse(row.metadataJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ─── Migration ────────────────────────────────────────────────────────────

  /**
   * Migrate a character's characterBookJson blob into a normalized lorebook + entries.
   * Returns the created lorebook ID, or null if no migration needed.
   */
  async migrateCharacterBookJson(characterId: string, characterBookJson: string): Promise<string | null> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(characterBookJson);
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== 'object') return null;

    // Extract lorebook metadata
    const name = typeof parsed.name === 'string' ? parsed.name : 'Character Lorebook';
    const description = typeof parsed.description === 'string' ? parsed.description : '';
    const scanDepth = typeof parsed.scan_depth === 'number' ? parsed.scan_depth :
                      typeof parsed.ext_scan_depth === 'number' ? parsed.ext_scan_depth : 50;
    const tokenBudget = typeof parsed.token_budget === 'number' ? parsed.token_budget : 2048;
    const recursiveScanning = typeof parsed.recursive_scanning === 'boolean' ? parsed.recursive_scanning : false;
    const maxRecursionSteps = typeof parsed.ext_max_recursion_steps === 'number' ? parsed.ext_max_recursion_steps : 5;

    // Check if this character already has a character-scoped lorebook
    const existing = await this.listLorebooksByScope('character', characterId);
    if (existing.length > 0) return null;

    // Create lorebook
    const lorebook = await this.createLorebook({
      name,
      description,
      scopeType: 'character',
      characterId,
      scanDepth,
      tokenBudget,
      recursiveScanning,
      maxRecursionSteps,
      includeNames: false,
    });

    // Parse entries from the blob
    const rawEntries = parsed.entries;
    if (!Array.isArray(rawEntries)) return lorebook.id;

    for (const raw of rawEntries) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;

      const rawKeys = entry.keys;
      const keys = Array.isArray(rawKeys) ? rawKeys.filter((k): k is string => typeof k === 'string') : [];
      const rawSecondary = (entry.secondary_keys ?? entry.secondaryKeys);
      const secondaryKeys = Array.isArray(rawSecondary) ? rawSecondary.filter((k): k is string => typeof k === 'string') : [];
      const content = typeof entry.content === 'string' ? entry.content : '';
      if (!content && keys.length === 0) continue;

      await this.createEntry(lorebook.id, {
        title: typeof entry.name === 'string' ? entry.name : (entry.comment ?? '') as string,
        content,
        keys,
        secondaryKeys,
        logic: typeof entry.logic === 'string' ? entry.logic : 'and_any',
        position: typeof entry.position === 'string' ? entry.position : 'before_char',
        depth: typeof entry.depth === 'number' ? entry.depth : 4,
        priority: typeof entry.priority === 'number' ? entry.priority : 10,
        sortOrder: typeof entry.order === 'number' ? entry.order : 0,
        constant: typeof entry.constant === 'boolean' ? entry.constant : false,
        probability: typeof entry.probability === 'number' ? entry.probability : 100,
        ignoreBudget: typeof entry.ignore_budget === 'boolean' ? entry.ignore_budget : false,
        role: typeof entry.role === 'number' ? this.mapRoleNumber(entry.role) : (typeof entry.role === 'string' ? entry.role : 'system'),
        group: typeof entry.group === 'string' ? entry.group : (typeof entry.groupName === 'string' ? entry.groupName as string : ''),
        groupWeight: typeof entry.group_weight === 'number' ? entry.group_weight : (typeof entry.groupWeight === 'number' ? entry.groupWeight : 1),
        prioritizeInclusion: typeof (entry.prioritize_inclusion ?? entry.prioritizeInclusion) === 'boolean' ? !!(entry.prioritize_inclusion ?? entry.prioritizeInclusion) : false,
        excludeRecursion: typeof (entry.exclude_recursion ?? entry.excludeRecursion) === 'boolean' ? !!(entry.exclude_recursion ?? entry.excludeRecursion) : false,
        preventRecursion: typeof (entry.prevent_recursion ?? entry.preventRecursion) === 'boolean' ? !!(entry.prevent_recursion ?? entry.preventRecursion) : false,
        delayUntilRecursion: typeof (entry.delay_until_recursion ?? entry.delayUntilRecursion) === 'boolean' ? !!(entry.delay_until_recursion ?? entry.delayUntilRecursion) : false,
        recursionLevel: typeof (entry.recursion_level ?? entry.recursionLevel) === 'number' ? (entry.recursion_level ?? entry.recursionLevel) as number : 0,
        scanDepthOverride: typeof (entry.scan_depth_override ?? entry.scanDepthOverride) === 'number' ? (entry.scan_depth_override ?? entry.scanDepthOverride) as number : null,
        caseSensitive: typeof (entry.case_sensitive ?? entry.caseSensitive) === 'boolean' ? !!(entry.case_sensitive ?? entry.caseSensitive) : false,
        matchWholeWords: typeof (entry.match_whole_words ?? entry.matchWholeWords) === 'boolean' ? !!(entry.match_whole_words ?? entry.matchWholeWords) : false,
        characterFilter: (() => { const v = entry.character_filter ?? entry.characterFilter; return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : []; })(),
        characterFilterExclude: typeof (entry.character_filter_exclude ?? entry.characterFilterExclude) === 'boolean' ? !!(entry.character_filter_exclude ?? entry.characterFilterExclude) : false,
        triggers: Array.isArray(entry.triggers) ? entry.triggers.filter((k): k is string => typeof k === 'string') : [],
        matchSources: (() => { const v = entry.match_sources ?? entry.matchSources; return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : []; })(),
        enabled: typeof (entry.enabled ?? entry.disable) === 'boolean' ? (entry.enabled ?? !entry.disable) as boolean : true,
        stickyWindow: typeof (entry.sticky_window ?? entry.stickyWindow) === 'number' ? (entry.sticky_window ?? entry.stickyWindow) as number : 0,
        cooldownWindow: typeof (entry.cooldown_window ?? entry.cooldownWindow) === 'number' ? (entry.cooldown_window ?? entry.cooldownWindow) as number : 0,
        delayWindow: typeof (entry.delay_window ?? entry.delayWindow) === 'number' ? (entry.delay_window ?? entry.delayWindow) as number : 0,
      });
    }

    return lorebook.id;
  }

  private mapRoleNumber(role: number): string {
    switch (role) {
      case 0: return 'system';
      case 1: return 'user';
      case 2: return 'assistant';
      default: return 'system';
    }
  }
}
