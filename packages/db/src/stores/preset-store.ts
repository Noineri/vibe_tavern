import { eq, sql } from 'drizzle-orm';
import { promptPresets } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

// ─── Input types ──────────────────────────────────────────────────────────────

export interface CreatePresetData {
  name: string;
  bindProviderPresetId?: string | null;
  systemPrompt?: string;
  postHistoryInstructions?: string;
  assistantPrefix?: string;
  authorsNote?: string;
  authorsNoteDepth?: number;
  summaryPrompt?: string;
  toolsPrompt?: string;
}

export type UpdatePresetData = Partial<CreatePresetData>;

// ─── Return type ──────────────────────────────────────────────────────────────

export interface PromptPreset {
  id: string;
  name: string;
  bindProviderPresetId: string | null;
  systemPrompt: string;
  postHistoryInstructions: string;
  assistantPrefix: string;
  authorsNote: string;
  authorsNoteDepth: number;
  summaryPrompt: string;
  toolsPrompt: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class PresetStore {
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

  async getById(id: string): Promise<PromptPreset | null> {
    const row = await this.db.select().from(promptPresets).where(eq(promptPresets.id, id)).get();
    return row ? this.mapRow(row) : null;
  }

  async listAll(): Promise<PromptPreset[]> {
    const rows = await this.db.select().from(promptPresets).all();
    return rows.map((row) => this.mapRow(row));
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  async create(data: CreatePresetData): Promise<PromptPreset> {
    const id = this.idGen.next('preset');
    const now = this.clock.now();

    await this.db
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
        summaryPrompt: data.summaryPrompt ?? '',
        toolsPrompt: data.toolsPrompt ?? '',
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const row = await this.db.select().from(promptPresets).where(eq(promptPresets.id, id)).get();
    return this.mapRow(row!);
  }

  async update(id: string, data: UpdatePresetData): Promise<PromptPreset> {
    const now = this.clock.now();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const values: Record<string, any> = { updatedAt: now };

    if (data.name !== undefined) values.name = data.name;
    if (data.bindProviderPresetId !== undefined) values.bindProviderPresetId = data.bindProviderPresetId;
    if (data.systemPrompt !== undefined) values.systemPrompt = data.systemPrompt;
    if (data.postHistoryInstructions !== undefined) values.postHistoryInstructions = data.postHistoryInstructions;
    if (data.assistantPrefix !== undefined) values.assistantPrefix = data.assistantPrefix;
    if (data.authorsNote !== undefined) values.authorsNote = data.authorsNote;
    if (data.authorsNoteDepth !== undefined) values.authorsNoteDepth = data.authorsNoteDepth;
    if (data.summaryPrompt !== undefined) values.summaryPrompt = data.summaryPrompt;
    if (data.toolsPrompt !== undefined) values.toolsPrompt = data.toolsPrompt;

    await this.db
      .update(promptPresets)
      .set(values)
      .where(eq(promptPresets.id, id))
      .run();

    const row = await this.db.select().from(promptPresets).where(eq(promptPresets.id, id)).get();
    if (!row) {
      throw new Error(`Preset '${id}' not found after update`);
    }
    return this.mapRow(row);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(promptPresets).where(eq(promptPresets.id, id)).run();
  }

  async duplicate(id: string): Promise<PromptPreset> {
    const original = await this.db.select().from(promptPresets).where(eq(promptPresets.id, id)).get();
    if (!original) {
      throw new Error(`Preset '${id}' not found`);
    }

    const newId = this.idGen.next('preset');
    const now = this.clock.now();

    await this.db
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
        summaryPrompt: original.summaryPrompt,
        toolsPrompt: original.toolsPrompt,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const row = await this.db.select().from(promptPresets).where(eq(promptPresets.id, newId)).get();
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
      summaryPrompt: '',
      toolsPrompt: '',
      bindProviderPresetId: null,
    });
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
      summaryPrompt: row.summaryPrompt,
      toolsPrompt: row.toolsPrompt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
