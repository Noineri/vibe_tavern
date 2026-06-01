import { eq, sql } from 'drizzle-orm';
import { promptPresets } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';
import type { ContentStore } from '../content-store.js';
import { STORAGE_FOLDERS } from '../file-store.js';

// ─── Input types ──────────────────────────────────────────────────────────────

export interface CreatePresetData {
  name: string;
  bindProviderPresetId?: string | null;
  systemPrompt?: string;
  postHistoryInstructions?: string;
  assistantPrefix?: string;
  authorsNote?: string;
  authorsNoteDepth?: number;
  authorsNotePosition?: string;
  summaryPrompt?: string;
  toolsPrompt?: string;
  scriptAiSystemPrompt?: string;
  customInjectionsJson?: string;
  promptOrderJson?: string;
}

export type UpdatePresetData = Partial<CreatePresetData>;

// ─── Return type ──────────────────────────────────────────────────────────────

/**
 * Store-level PromptPreset — domain PromptPreset projected from a DB row.
 */
export interface PromptPreset {
  id: string;
  name: string;
  bindProviderPresetId: string | null;
  systemPrompt: string;
  postHistoryInstructions: string;
  assistantPrefix: string;
  authorsNote: string;
  authorsNoteDepth: number;
  authorsNotePosition: string;
  summaryPrompt: string;
  toolsPrompt: string;
  scriptAiSystemPrompt: string;
  customInjectionsJson: string;
  promptOrderJson: string;
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
      const fileData = this.toFilePayload(row);
      const hash = await this.content.writeEntity(STORAGE_FOLDERS.promptPresets, id, fileData);
      await this.db.update(promptPresets)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(promptPresets.id, id))
        .run();
    }

    return this.mapRow(row);
  }

  async listAll(): Promise<PromptPreset[]> {
    const rows = await this.db.select().from(promptPresets).all();
    return rows.map((row) => this.mapRow(row));
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  async create(data: CreatePresetData): Promise<PromptPreset> {
    const id = this.idGen.next('preset');
    const now = this.clock.now();

    const [row] = await this.db
      .insert(promptPresets)
      .values({
        id,
        name: data.name,
        bindProviderPresetId: data.bindProviderPresetId ?? null,
        systemPrompt: data.systemPrompt ?? '',
        postHistoryInstructions: data.postHistoryInstructions ?? '',
        assistantPrefix: data.assistantPrefix ?? '',
        authorsNote: data.authorsNote ?? '',
        authorsNoteDepth: data.authorsNoteDepth ?? 4,
        authorsNotePosition: data.authorsNotePosition ?? 'in_chat',
        summaryPrompt: data.summaryPrompt ?? '',
        toolsPrompt: data.toolsPrompt ?? '',
        scriptAiSystemPrompt: data.scriptAiSystemPrompt ?? '',
        customInjectionsJson: data.customInjectionsJson ?? '[]',
        promptOrderJson: data.promptOrderJson ?? '[]',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // Dual-write: write canonical JSON file
    if (this.content) {
      const fileData = this.toFilePayload(row!);
      const hash = await this.content.writeEntity(STORAGE_FOLDERS.promptPresets, id, fileData);
      await this.db.update(promptPresets)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(promptPresets.id, id))
        .run();
    }

    return this.mapRow(row!);
  }

  async update(id: string, data: UpdatePresetData): Promise<PromptPreset> {
    const now = this.clock.now();

    const values: Partial<typeof promptPresets.$inferInsert> = { updatedAt: now };

    if (data.name !== undefined) values.name = data.name;
    if (data.bindProviderPresetId !== undefined) values.bindProviderPresetId = data.bindProviderPresetId;
    if (data.systemPrompt !== undefined) values.systemPrompt = data.systemPrompt;
    if (data.postHistoryInstructions !== undefined) values.postHistoryInstructions = data.postHistoryInstructions;
    if (data.assistantPrefix !== undefined) values.assistantPrefix = data.assistantPrefix;
    if (data.authorsNote !== undefined) values.authorsNote = data.authorsNote;
    if (data.authorsNoteDepth !== undefined) values.authorsNoteDepth = data.authorsNoteDepth;
    if (data.authorsNotePosition !== undefined) values.authorsNotePosition = data.authorsNotePosition;
    if (data.summaryPrompt !== undefined) values.summaryPrompt = data.summaryPrompt;
    if (data.toolsPrompt !== undefined) values.toolsPrompt = data.toolsPrompt;
    if (data.scriptAiSystemPrompt !== undefined) values.scriptAiSystemPrompt = data.scriptAiSystemPrompt;
    if (data.customInjectionsJson !== undefined) values.customInjectionsJson = data.customInjectionsJson;
    if (data.promptOrderJson !== undefined) values.promptOrderJson = data.promptOrderJson;

    const [row] = await this.db
      .update(promptPresets)
      .set(values)
      .where(eq(promptPresets.id, id))
      .returning();

    if (!row) {
      throw new Error(`Preset '${id}' not found after update`);
    }

    // Dual-write: update canonical JSON file
    if (this.content) {
      const fileData = this.toFilePayload(row);
      const hash = await this.content.writeEntity(STORAGE_FOLDERS.promptPresets, id, fileData);
      await this.db.update(promptPresets)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(promptPresets.id, id))
        .run();
    }

    return this.mapRow(row);
  }

  async delete(id: string): Promise<void> {
    // Delete file from disk
    if (this.content) {
      await this.content.deleteEntity(STORAGE_FOLDERS.promptPresets, id);
    }

    await this.db.delete(promptPresets).where(eq(promptPresets.id, id)).run();
  }

  async duplicate(id: string): Promise<PromptPreset> {
    const original = await this.db.select().from(promptPresets).where(eq(promptPresets.id, id)).get();
    if (!original) {
      throw new Error(`Preset '${id}' not found`);
    }

    const newId = this.idGen.next('preset');
    const now = this.clock.now();

    const [row] = await this.db
      .insert(promptPresets)
      .values({
        id: newId,
        name: `${original.name} (copy)`,
        bindProviderPresetId: original.bindProviderPresetId,
        systemPrompt: original.systemPrompt,
        postHistoryInstructions: original.postHistoryInstructions,
        assistantPrefix: original.assistantPrefix,
        authorsNote: original.authorsNote,
        authorsNoteDepth: original.authorsNoteDepth,
        authorsNotePosition: original.authorsNotePosition,
        summaryPrompt: original.summaryPrompt,
        toolsPrompt: original.toolsPrompt,
        scriptAiSystemPrompt: original.scriptAiSystemPrompt ?? '',
        customInjectionsJson: original.customInjectionsJson,
        promptOrderJson: original.promptOrderJson,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // Dual-write: write canonical JSON file for duplicate
    if (this.content) {
      const fileData = this.toFilePayload(row!);
      const hash = await this.content.writeEntity(STORAGE_FOLDERS.promptPresets, newId, fileData);
      await this.db.update(promptPresets)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(promptPresets.id, newId))
        .run();
    }

    return this.mapRow(row!);
  }

  async ensureDefault(): Promise<PromptPreset> {
    const countRow = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(promptPresets)
      .get();

    if (countRow && countRow.count > 0) {
      const first = await this.db.select().from(promptPresets).get();
      return this.mapRow(first!);
    }

    return this.create({
      name: 'Default',
      systemPrompt: "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.",
      postHistoryInstructions: '',
      assistantPrefix: '',
      authorsNote: '',
      authorsNoteDepth: 4,
      authorsNotePosition: 'in_chat',
      summaryPrompt: '',
      toolsPrompt: '',
      scriptAiSystemPrompt: '',
      customInjectionsJson: '[]',
      promptOrderJson: '[]',
      bindProviderPresetId: null,
    });
  }

  // ─── File payload ──────────────────────────────────────────────────────────

  private toFilePayload(row: typeof promptPresets.$inferSelect): Record<string, unknown> {
    return {
      name: row.name,
      systemPrompt: row.systemPrompt,
      postHistoryInstructions: row.postHistoryInstructions,
      assistantPrefix: row.assistantPrefix,
      authorsNote: row.authorsNote,
      authorsNoteDepth: row.authorsNoteDepth,
      authorsNotePosition: row.authorsNotePosition,
      summaryPrompt: row.summaryPrompt,
      toolsPrompt: row.toolsPrompt,
      scriptAiSystemPrompt: row.scriptAiSystemPrompt,
      customInjections: JSON.parse(row.customInjectionsJson || '[]'),
      promptOrder: JSON.parse(row.promptOrderJson || '[]'),
    };
  }

  // ─── Row mapper ────────────────────────────────────────────────────────────

  private mapRow(row: typeof promptPresets.$inferSelect): PromptPreset {
    return {
      id: row.id,
      name: row.name,
      bindProviderPresetId: row.bindProviderPresetId,
      systemPrompt: row.systemPrompt,
      postHistoryInstructions: row.postHistoryInstructions,
      assistantPrefix: row.assistantPrefix,
      authorsNote: row.authorsNote,
      authorsNoteDepth: row.authorsNoteDepth,
      authorsNotePosition: row.authorsNotePosition,
      summaryPrompt: row.summaryPrompt,
      toolsPrompt: row.toolsPrompt,
      scriptAiSystemPrompt: row.scriptAiSystemPrompt ?? '',
      customInjectionsJson: row.customInjectionsJson,
      promptOrderJson: row.promptOrderJson,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
