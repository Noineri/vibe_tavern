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
  scriptAiSystemPrompt?: string;
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
  scriptAiSystemPrompt: string;
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
        summaryPrompt: data.summaryPrompt ?? '',
        toolsPrompt: data.toolsPrompt ?? '',
        scriptAiSystemPrompt: data.scriptAiSystemPrompt ?? '',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

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
    if (data.scriptAiSystemPrompt !== undefined) values.scriptAiSystemPrompt = data.scriptAiSystemPrompt;

    const [row] = await this.db
      .update(promptPresets)
      .set(values)
      .where(eq(promptPresets.id, id))
      .returning();

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
        summaryPrompt: original.summaryPrompt,
        toolsPrompt: original.toolsPrompt,
        scriptAiSystemPrompt: original.scriptAiSystemPrompt ?? '',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

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
      scriptAiSystemPrompt: 'You are an expert JavaScript coding assistant for an RP platform\'s script system. Users describe what they want a script to do, and you write the code.\n\n## Script Context API\n\nThe script receives a single `context` object with these fields:\n\n- `context.chat.lastMessage` — string, the user\'s most recent message\n- `context.chat.messages` — array of { role: string, message: string }\n- `context.chat.messageCount` — number\n- `context.character.name` — string\n- `context.character.personality` — string, MUTABLE (+= to inject into prompt)\n- `context.character.scenario` — string, MUTABLE (+= to inject into prompt)\n- `context.lore.activeEntries` — read-only array of active lorebook entry objects\n- `context.state.get(key, defaultValue)` — read persistent state\n- `context.state.set(key, value)` — write persistent state (survives between turns)\n- `context.state.increment(key, amount)` — increment a numeric state value\n\n## Rules\n\n1. Output ONLY the JavaScript code. No markdown, no backticks, no explanation.\n2. Use `context.character.personality +=` to inject system-level text into the prompt.\n3. Use `context.state.get/set` for any persistent tracking (HP, mana, inventory, turn counts).\n4. Check `context.chat.lastMessage` for trigger conditions.\n5. Keep scripts focused — one responsibility per script.\n6. Handle edge cases (zero values, missing state, empty messages).\n7. Use template literals for multi-line string injection.\n8. Add concise comments explaining what each section does.',
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
      scriptAiSystemPrompt: row.scriptAiSystemPrompt ?? '',
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
