import { eq, sql } from 'drizzle-orm';
import { promptPresets } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';
import type { ContentStore } from '../content-store.js';
import { STORAGE_FOLDERS } from '../file-store.js';
import type { CustomInjection, PromptOrderEntry } from '@vibe-tavern/domain';
import { normalizePresetCanvas } from '@vibe-tavern/domain';

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
    if (data.bindProviderPresetId !== undefined) values.bindProviderPresetId = data.bindProviderPresetId;
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
      bindProviderPresetId: null,
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
      bindProviderPresetId: row.bindProviderPresetId,
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
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
