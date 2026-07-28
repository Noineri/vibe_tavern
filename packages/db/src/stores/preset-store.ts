import { asc, eq, sql } from 'drizzle-orm';
import { Database } from 'bun:sqlite';
import { promptPresets } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';
import type { ContentStore } from '../content-store.js';
import { STORAGE_FOLDERS } from '../file-store.js';
import { type CustomInjection, type PromptOrderEntry, normalizePresetCanvas, log } from '@vibe-tavern/domain';

const logger = log.tag('preset-db');

// ─── FK-delete diagnostics (PRESET_COPY_DELETE_CORRUPTION bug 2) ───────────────

/** Reach the raw `bun:sqlite` handle off the drizzle wrapper. `AppDb` is
 *  `ReturnType<typeof drizzle>`; the `$client` intersection isn't surfaced in
 *  every overload resolution (see db-connection-fk-rebuild.test using the same
 *  cast), so reach it this way for pragmas. */
function rawClient(db: AppDb): Database {
  return (db as unknown as { $client: Database }).$client;
}

/** Narrow an unknown thrown value to a SQLite foreign-key constraint failure.
 *  bun:sqlite throws `SQLiteError` with `code:"SQLITE_CONSTRAINT_FOREIGNKEY"`
 *  and message "FOREIGN KEY constraint failed"; accept either signal. */
function isSqliteForeignKeyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if ((err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return true;
  return /FOREIGN KEY/i.test(err.message);
}

// ─── Input types ──────────────────────────────────────────────────────────────

export interface CreatePresetData {
  name: string;
  /** Designated-default flag. Only one preset should have this true (enforced
   *  by the seeding path; regular creates pass false/omit). */
  isDefault?: boolean;
  systemPrompt?: string;
  postHistoryInstructions?: string;
  assistantPrefix?: string;
  authorsNote?: string;
  authorsNoteDepth?: number;
  authorsNotePosition?: string;
  authorsNoteRole?: string;
  summaryPrompt?: string;
  toolsPrompt?: string;
  nsfwPrompt?: string;
  enhanceDefinitionsPrompt?: string;
  scriptAiSystemPrompt?: string;
  aiAssistantPrompts?: string;
  customInjections?: CustomInjection[];
  promptOrder?: PromptOrderEntry[];
  advancedMode?: boolean;
  mergeConsecutiveRoles?: boolean;
}

export type UpdatePresetData = Partial<CreatePresetData>;

// ─── Return type ──────────────────────────────────────────────────────────────

/**
 * Store-level PromptPreset — domain PromptPreset projected from a DB row.
 */
export interface PromptPreset {
  id: string;
  name: string;
  isDefault: boolean;
  systemPrompt: string;
  postHistoryInstructions: string;
  assistantPrefix: string;
  authorsNote: string;
  authorsNoteDepth: number;
  authorsNotePosition: string;
  authorsNoteRole: string;
  summaryPrompt: string;
  toolsPrompt: string;
  nsfwPrompt: string;
  enhanceDefinitionsPrompt: string;
  scriptAiSystemPrompt: string;
  aiAssistantPrompts: string;
  customInjections: CustomInjection[];
  promptOrder: PromptOrderEntry[];
  advancedMode: boolean;
  mergeConsecutiveRoles: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class PresetStore {
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

  async getById(id: string): Promise<PromptPreset | null> {
    const row = await this.db.select().from(promptPresets).where(eq(promptPresets.id, id)).get();
    if (!row) return null;

    // Lazy migration: generate file if it doesn't exist on disk
    if (this.content && !row.hasFileOnDisk) {
      const preset = this.mapRow(row);
      const fileData = this.toFilePayload(preset);
      const hash = await this.content.writeEntity(STORAGE_FOLDERS.promptPresets, id, fileData);
      await this.db.update(promptPresets)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(promptPresets.id, id))
        .run();
      return preset;
    }

    return this.mapRow(row);
  }

  async listAll(): Promise<PromptPreset[]> {
    const rows = await this.db.select().from(promptPresets).orderBy(asc(promptPresets.sortOrder), asc(promptPresets.createdAt)).all();
    return rows.map((row) => this.mapRow(row));
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  async create(data: CreatePresetData): Promise<PromptPreset> {
    const id = this.idGen.next('preset');
    const now = this.clock.now();

    // Append at the end of the list: sort_order = current max + 1, so a freshly
    // created preset never jumps above existing ones (the column default is 0).
    const maxRow = await this.db
      .select({ maxSort: sql<number>`COALESCE(MAX(${promptPresets.sortOrder}), -1)` })
      .from(promptPresets)
      .get();
    const nextSortOrder = (maxRow?.maxSort ?? -1) + 1;

    const [row] = await this.db
      .insert(promptPresets)
      .values({
        id,
        name: data.name,
        sortOrder: nextSortOrder,
        isDefault: data.isDefault ? 1 : 0,
        systemPrompt: data.systemPrompt ?? '',
        postHistoryInstructions: data.postHistoryInstructions ?? '',
        assistantPrefix: data.assistantPrefix ?? '',
        authorsNote: data.authorsNote ?? '',
        authorsNoteDepth: data.authorsNoteDepth ?? 4,
        authorsNotePosition: data.authorsNotePosition ?? 'in_chat',
        authorsNoteRole: data.authorsNoteRole ?? 'system',
        summaryPrompt: data.summaryPrompt ?? '',
        toolsPrompt: data.toolsPrompt ?? '',
        nsfwPrompt: data.nsfwPrompt ?? '',
        enhanceDefinitionsPrompt: data.enhanceDefinitionsPrompt ?? '',
        scriptAiSystemPrompt: data.scriptAiSystemPrompt ?? '',
        aiAssistantPrompts: data.aiAssistantPrompts ?? '{}',
        customInjectionsJson: JSON.stringify(data.customInjections ?? []),
        promptOrderJson: JSON.stringify(data.promptOrder ?? []),
        advancedMode: data.advancedMode ? 1 : 0,
        mergeConsecutiveRoles: data.mergeConsecutiveRoles ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const preset = this.mapRow(row!);

    // Dual-write: write canonical JSON file
    if (this.content) {
      const fileData = this.toFilePayload(preset);
      const hash = await this.content.writeEntity(STORAGE_FOLDERS.promptPresets, id, fileData);
      await this.db.update(promptPresets)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(promptPresets.id, id))
        .run();
    }

    return preset;
  }

  async update(id: string, data: UpdatePresetData): Promise<PromptPreset> {
    const now = this.clock.now();

    const values: Partial<typeof promptPresets.$inferInsert> = { updatedAt: now };

    if (data.name !== undefined) values.name = data.name;
    if (data.isDefault !== undefined) values.isDefault = data.isDefault ? 1 : 0;
    if (data.systemPrompt !== undefined) values.systemPrompt = data.systemPrompt;
    if (data.postHistoryInstructions !== undefined) values.postHistoryInstructions = data.postHistoryInstructions;
    if (data.assistantPrefix !== undefined) values.assistantPrefix = data.assistantPrefix;
    if (data.authorsNote !== undefined) values.authorsNote = data.authorsNote;
    if (data.authorsNoteDepth !== undefined) values.authorsNoteDepth = data.authorsNoteDepth;
    if (data.authorsNotePosition !== undefined) values.authorsNotePosition = data.authorsNotePosition;
    if (data.authorsNoteRole !== undefined) values.authorsNoteRole = data.authorsNoteRole;
    if (data.summaryPrompt !== undefined) values.summaryPrompt = data.summaryPrompt;
    if (data.toolsPrompt !== undefined) values.toolsPrompt = data.toolsPrompt;
    if (data.nsfwPrompt !== undefined) values.nsfwPrompt = data.nsfwPrompt;
    if (data.enhanceDefinitionsPrompt !== undefined) values.enhanceDefinitionsPrompt = data.enhanceDefinitionsPrompt;
    if (data.scriptAiSystemPrompt !== undefined) values.scriptAiSystemPrompt = data.scriptAiSystemPrompt;
    if (data.aiAssistantPrompts !== undefined) values.aiAssistantPrompts = data.aiAssistantPrompts;
    if (data.customInjections !== undefined) values.customInjectionsJson = JSON.stringify(data.customInjections);
    if (data.promptOrder !== undefined) values.promptOrderJson = JSON.stringify(data.promptOrder);
    if (data.advancedMode !== undefined) values.advancedMode = data.advancedMode ? 1 : 0;
    if (data.mergeConsecutiveRoles !== undefined) values.mergeConsecutiveRoles = data.mergeConsecutiveRoles ? 1 : 0;

    const [row] = await this.db
      .update(promptPresets)
      .set(values)
      .where(eq(promptPresets.id, id))
      .returning();

    if (!row) {
      throw new Error(`Preset '${id}' not found after update`);
    }

    const preset = this.mapRow(row);

    // Dual-write: update canonical JSON file
    if (this.content) {
      const fileData = this.toFilePayload(preset);
      const hash = await this.content.writeEntity(STORAGE_FOLDERS.promptPresets, id, fileData);
      await this.db.update(promptPresets)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(promptPresets.id, id))
        .run();
    }

    return preset;
  }

  async delete(id: string): Promise<void> {
    // Delete file from disk
    if (this.content) {
      await this.content.deleteEntity(STORAGE_FOLDERS.promptPresets, id);
    }

    try {
      await this.db.delete(promptPresets).where(eq(promptPresets.id, id)).run();
    } catch (err) {
      // A bare `SQLITE_CONSTRAINT_FOREIGNKEY` names neither the offending child
      // table nor the row. Attach a diagnostic so the next occurrence is
      // triageable instead of opaque: which child rows still reference this
      // preset (the usual blocker — an FK that is NO ACTION in this DB, or a SET
      // NULL blocked by a NOT NULL column), plus any pre-existing orphan
      // corruption. The delete STILL fails — the diagnostic only adds context.
      if (isSqliteForeignKeyError(err)) {
        const diag = this.diagnoseForeignKeyDeleteFailure(id);
        logger.warn('delete(%s) FK constraint failed — %s', id, diag);
        if (err instanceof Error) err.message = `${err.message} — ${diag}`;
      }
      throw err;
    }
  }

  /** Gather what a bare FK-constraint error hides. Two complementary sweeps:
   *  (1) a dynamic enumeration of every table whose FK references
   *  `prompt_presets`, counting rows pointing at the preset being deleted
   *  (this is what actually blocks a NO ACTION / NOT-NULL-blocked SET NULL
   *  delete — `PRAGMA foreign_key_check` returns nothing for it because the
   *  parent row still exists when the delete aborts); (2) `PRAGMA
   *  foreign_key_check` for any pre-existing orphan corruption. The diagnostic
   *  never masks the original failure — if the sweeps themselves throw, that is
   *  recorded and the original error still propagates from `delete()`. */
  private diagnoseForeignKeyDeleteFailure(presetId: string): string {
    const client = rawClient(this.db);
    const parts: string[] = [];
    try {
      // (1) Which child tables/rows still reference this preset?
      const tables = client
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
        )
        .all() as { name: string }[];
      const refs: string[] = [];
      for (const { name } of tables) {
        const fks = client.prepare(`PRAGMA foreign_key_list("${name}")`).all() as Array<{
          table: string;
          from: string;
          on_delete: string;
        }>;
        for (const fk of fks) {
          if (fk.table !== 'prompt_presets') continue;
          const row = client
            .prepare(`SELECT COUNT(*) AS c FROM "${name}" WHERE "${fk.from}" = ?`)
            .get(presetId) as { c: number };
          if (row.c > 0) refs.push(`${name}.${fk.from}=${row.c}(on_delete:${fk.on_delete})`);
        }
      }
      parts.push(refs.length ? `referencing_children=[${refs.join(', ')}]` : 'referencing_children=(none)');

      // (2) Pre-existing orphan corruption (unrelated dangling refs).
      const fkCheck = client.prepare('PRAGMA foreign_key_check').all() as Array<{
        table: string;
        rowid: number;
        parent: string;
      }>;
      const orphans = fkCheck.map((v) => `${v.table}:${v.rowid}->${v.parent}`).join(', ');
      parts.push(orphans ? `foreign_key_check=[${orphans}]` : 'foreign_key_check=(none)');
    } catch (diagErr) {
      parts.push(`diagnostic_failed=${diagErr instanceof Error ? diagErr.message : String(diagErr)}`);
    }
    return parts.join(' ');
  }

  async duplicate(id: string): Promise<PromptPreset> {
    const original = await this.db.select().from(promptPresets).where(eq(promptPresets.id, id)).get();
    if (!original) {
      throw new Error(`Preset '${id}' not found`);
    }

    const newId = this.idGen.next('preset');
    const now = this.clock.now();

    // Append at the end of the list (see create()).
    const maxRow = await this.db
      .select({ maxSort: sql<number>`COALESCE(MAX(${promptPresets.sortOrder}), -1)` })
      .from(promptPresets)
      .get();
    const nextSortOrder = (maxRow?.maxSort ?? -1) + 1;

    const [row] = await this.db
      .insert(promptPresets)
      .values({
        id: newId,
        name: `${original.name} (copy)`,
        sortOrder: nextSortOrder,
        isDefault: 0,
        systemPrompt: original.systemPrompt,
        postHistoryInstructions: original.postHistoryInstructions,
        assistantPrefix: original.assistantPrefix,
        authorsNote: original.authorsNote,
        authorsNoteDepth: original.authorsNoteDepth,
        authorsNotePosition: original.authorsNotePosition,
        authorsNoteRole: original.authorsNoteRole,
        summaryPrompt: original.summaryPrompt,
        toolsPrompt: original.toolsPrompt,
        nsfwPrompt: original.nsfwPrompt,
        enhanceDefinitionsPrompt: original.enhanceDefinitionsPrompt,
        scriptAiSystemPrompt: original.scriptAiSystemPrompt ?? '',
        aiAssistantPrompts: original.aiAssistantPrompts ?? '{}',
        customInjectionsJson: original.customInjectionsJson,
        promptOrderJson: original.promptOrderJson,
        advancedMode: original.advancedMode,
        mergeConsecutiveRoles: original.mergeConsecutiveRoles,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const preset = this.mapRow(row!);

    // Dual-write: write canonical JSON file for duplicate
    if (this.content) {
      const fileData = this.toFilePayload(preset);
      const hash = await this.content.writeEntity(STORAGE_FOLDERS.promptPresets, newId, fileData);
      await this.db.update(promptPresets)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(promptPresets.id, newId))
        .run();
    }

    return preset;
  }

  async reorder(updates: Array<{ id: string; sortOrder: number }>): Promise<PromptPreset[]> {
    const now = this.clock.now();
    // Synchronous callback (ASYNC_TRANSACTION_AUDIT step 6): see chat-summary
    // reorder. A mid-reorder failure rolls the earlier updates back — the
    // prior complete order survives.
    this.db.transaction((tx) => {
      for (const u of updates) {
        tx
          .update(promptPresets)
          .set({ sortOrder: u.sortOrder, updatedAt: now })
          .where(eq(promptPresets.id, u.id))
          .run();
      }
    });
    return this.listAll();
  }

  async ensureDefault(): Promise<PromptPreset> {
    const countRow = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(promptPresets)
      .get();

    if (countRow && countRow.count > 0) {
      // Prefer the row flagged is_default; fall back to the first by rowid for
      // legacy rows that somehow lack the flag (preserves the old select().get()
      // rowid-first behavior as a defensive default).
      const rows = await this.db.select().from(promptPresets).all();
      const target = rows.find((r) => r.isDefault) ?? rows[0];
      return this.mapRow(target!);
    }

    return this.create({
      name: 'Default',
      systemPrompt: "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.",
      postHistoryInstructions: '',
      assistantPrefix: '',
      authorsNote: '',
      authorsNoteDepth: 4,
      authorsNotePosition: 'in_chat',
      authorsNoteRole: 'system',
      summaryPrompt: '',
      toolsPrompt: '',
      nsfwPrompt: '',
      enhanceDefinitionsPrompt: '',
      scriptAiSystemPrompt: '',
      aiAssistantPrompts: '{}',
      customInjections: [],
      promptOrder: [],
      advancedMode: false,
      mergeConsecutiveRoles: false,
      isDefault: true,
    });
  }

  // ─── File payload ──────────────────────────────────────────────────────────

  private toFilePayload(preset: PromptPreset): Record<string, unknown> {
    return {
      name: preset.name,
      systemPrompt: preset.systemPrompt,
      postHistoryInstructions: preset.postHistoryInstructions,
      assistantPrefix: preset.assistantPrefix,
      authorsNote: preset.authorsNote,
      authorsNoteDepth: preset.authorsNoteDepth,
      authorsNotePosition: preset.authorsNotePosition,
      authorsNoteRole: preset.authorsNoteRole,
      summaryPrompt: preset.summaryPrompt,
      toolsPrompt: preset.toolsPrompt,
      nsfwPrompt: preset.nsfwPrompt,
      enhanceDefinitionsPrompt: preset.enhanceDefinitionsPrompt,
      scriptAiSystemPrompt: preset.scriptAiSystemPrompt,
      aiAssistantPrompts: preset.aiAssistantPrompts,
      customInjections: preset.customInjections,
      promptOrder: preset.promptOrder,
      advancedMode: preset.advancedMode,
      mergeConsecutiveRoles: preset.mergeConsecutiveRoles,
    };
  }

  // ─── Row mapper ────────────────────────────────────────────────────────────

  private mapRow(row: typeof promptPresets.$inferSelect): PromptPreset {
    // Single materialization + normalization site (CANVAS_SINGLE_SOURCE_PLAN D2):
    // parse the two JSON columns once, normalize the canvas, assign typed arrays.
    const rawInjections = JSON.parse(row.customInjectionsJson || '[]');
    const rawOrder = JSON.parse(row.promptOrderJson || '[]');
    const { customInjections, promptOrder } = normalizePresetCanvas(rawInjections, rawOrder);
    return {
      id: row.id,
      name: row.name,
      isDefault: Boolean(row.isDefault),
      systemPrompt: row.systemPrompt,
      postHistoryInstructions: row.postHistoryInstructions,
      assistantPrefix: row.assistantPrefix,
      authorsNote: row.authorsNote,
      authorsNoteDepth: row.authorsNoteDepth,
      authorsNotePosition: row.authorsNotePosition,
      authorsNoteRole: row.authorsNoteRole,
      summaryPrompt: row.summaryPrompt,
      toolsPrompt: row.toolsPrompt,
      nsfwPrompt: row.nsfwPrompt,
      enhanceDefinitionsPrompt: row.enhanceDefinitionsPrompt,
      scriptAiSystemPrompt: row.scriptAiSystemPrompt ?? '',
      aiAssistantPrompts: row.aiAssistantPrompts ?? '{}',
      customInjections,
      promptOrder,
      advancedMode: Boolean(row.advancedMode),
      mergeConsecutiveRoles: Boolean(row.mergeConsecutiveRoles),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
