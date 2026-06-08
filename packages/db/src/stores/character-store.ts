import { eq, and, sql } from 'drizzle-orm';
import { characters } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';
import type { ContentStore } from '../content-store.js';
import { STORAGE_FOLDERS } from '../file-store.js';
import { hashCanonicalJson } from '../file-store.js';

// ─── Input types ──────────────────────────────────────────────────────────────

export interface CreateCharacterData {
  name: string;
  description?: string;
  personalitySummary?: string | null;
  defaultScenario?: string | null;
  firstMessage?: string | null;
  mesExample?: string | null;
  mesExampleMode?: string;
  mesExampleDepth?: number;
  alternateGreetings?: string[];
  postHistoryInstructions?: string | null;
  creatorNotes?: string | null;
  characterBook?: Record<string, unknown> | null;
  depthPrompt?: string | null;
  depthPromptDepth?: number | null;
  depthPromptRole?: string | null;
  extensions?: Record<string, unknown>;
  systemPrompt?: string | null;
  tags?: string[];
  avatarAssetId?: string | null;
  avatarFullAssetId?: string | null;
  avatarCropJson?: string | null;
}

export type UpdateCharacterData = Partial<CreateCharacterData>;

/**
 * Store-level Character — domain Character projected from a DB row.
 * Uses plain `string` IDs (brands are applied at the API boundary).
 * Includes DB-specific fields like `slug` and `status`.
 */
export interface Character {
  id: string;
  slug: string;
  name: string;
  isSystem: boolean;
  description: string;
  personalitySummary: string | null;
  defaultScenario: string | null;
  firstMessage: string | null;
  mesExample: string | null;
  mesExampleMode: string;
  mesExampleDepth: number;
  alternateGreetings: string[];
  postHistoryInstructions: string | null;
  creatorNotes: string | null;
  characterBook: Record<string, unknown> | null;
  depthPrompt: string | null;
  depthPromptDepth: number | null;
  depthPromptRole: string | null;
  extensions: Record<string, unknown>;
  systemPrompt: string | null;
  tags: string[];
  avatarAssetId: string | null;
  avatarFullAssetId: string | null;
  avatarCropJson: string | null;
  status: 'active' | 'draft' | 'archived';
  createdAt: string;
  updatedAt: string;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class CharacterStore {
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

  async getById(id: string): Promise<Character | null> {
    const row = await this.db.select().from(characters).where(eq(characters.id, id)).get();
    if (!row) return null;
    const char = this.mapRow(row);

    // Lazy migration: if not yet on disk, write now
    if (this.content && !row.hasFileOnDisk) {
      const fileData = this.toFileData(char);
      const displayName = char.name || char.slug;
      const hash = await this.content.writeEntity(STORAGE_FOLDERS.characters, id, fileData, { displayName });
      await this.db
        .update(characters)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(characters.id, id))
        .run();
    }

    return char;
  }

  async listAll(): Promise<Character[]> {
    const rows = await this.db
      .select()
      .from(characters)
      .where(and(eq(characters.isSystem, 0), eq(characters.status, 'active')))
      .all();
    return rows.map((row) => this.mapRow(row));
  }

  async listIncludingSystem(): Promise<Character[]> {
    const rows = await this.db
      .select()
      .from(characters)
      .where(eq(characters.status, 'active'))
      .all();
    return rows.map((row) => this.mapRow(row));
  }

  async search(query: string): Promise<Character[]> {
    const rows = await this.db
      .select()
      .from(characters)
      .where(
        and(
          eq(characters.isSystem, 0),
          sql`lower(${characters.name}) LIKE lower(${'%' + query + '%'})`,
        ),
      )
      .all();
    return rows.map((row) => this.mapRow(row));
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  async create(data: CreateCharacterData): Promise<Character> {
    const id = this.idGen.next('char');
    const now = this.clock.now();

    const [row] = await this.db
      .insert(characters)
      .values({
        id,
        name: data.name,
        description: data.description ?? '',
        personalitySummary: data.personalitySummary ?? null,
        defaultScenario: data.defaultScenario ?? null,
        firstMessage: data.firstMessage ?? null,
        mesExample: data.mesExample ?? null,
        mesExampleMode: data.mesExampleMode ?? 'always',
        mesExampleDepth: data.mesExampleDepth ?? 4,
        alternateGreetingsJson: JSON.stringify(data.alternateGreetings ?? []),
        postHistoryInstructions: data.postHistoryInstructions ?? null,
        creatorNotes: data.creatorNotes ?? null,
        characterBookJson: data.characterBook ? JSON.stringify(data.characterBook) : null,
        depthPrompt: data.depthPrompt ?? null,
        depthPromptDepth: data.depthPromptDepth ?? null,
        depthPromptRole: data.depthPromptRole ?? null,
        extensionsJson: JSON.stringify(data.extensions ?? {}),
        systemPrompt: data.systemPrompt ?? null,
        tagsJson: JSON.stringify(data.tags ?? []),
        avatarAssetId: data.avatarAssetId ?? null,
        avatarFullAssetId: data.avatarFullAssetId ?? null,
        avatarCropJson: data.avatarCropJson ?? null,
        status: 'active',
        isSystem: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const char = this.mapRow(row!);

    // Dual write: persist content to file store
    if (this.content) {
      const fileData = this.toFileData(char);
      const displayName = char.name || char.slug;
      const hash = await this.content.writeEntity(STORAGE_FOLDERS.characters, id, fileData, { displayName });
      await this.db
        .update(characters)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(characters.id, id))
        .run();
    }

    return char;
  }

  async update(id: string, data: UpdateCharacterData): Promise<Character> {
    const now = this.clock.now();

    const values: Partial<typeof characters.$inferInsert> = { updatedAt: now };

    if (data.name !== undefined) values.name = data.name;
    if (data.description !== undefined) values.description = data.description;
    if (data.personalitySummary !== undefined) values.personalitySummary = data.personalitySummary;
    if (data.defaultScenario !== undefined) values.defaultScenario = data.defaultScenario;
    if (data.firstMessage !== undefined) values.firstMessage = data.firstMessage;
    if (data.mesExample !== undefined) values.mesExample = data.mesExample;
    if (data.mesExampleMode !== undefined) values.mesExampleMode = data.mesExampleMode;
    if (data.mesExampleDepth !== undefined) values.mesExampleDepth = data.mesExampleDepth;
    if (data.alternateGreetings !== undefined) values.alternateGreetingsJson = JSON.stringify(data.alternateGreetings);
    if (data.postHistoryInstructions !== undefined) values.postHistoryInstructions = data.postHistoryInstructions;
    if (data.creatorNotes !== undefined) values.creatorNotes = data.creatorNotes;
    if (data.characterBook !== undefined) values.characterBookJson = data.characterBook ? JSON.stringify(data.characterBook) : null;
    if (data.depthPrompt !== undefined) values.depthPrompt = data.depthPrompt;
    if (data.depthPromptDepth !== undefined) values.depthPromptDepth = data.depthPromptDepth;
    if (data.depthPromptRole !== undefined) values.depthPromptRole = data.depthPromptRole;
    if (data.extensions !== undefined) values.extensionsJson = JSON.stringify(data.extensions);
    if (data.systemPrompt !== undefined) values.systemPrompt = data.systemPrompt;
    if (data.tags !== undefined) values.tagsJson = JSON.stringify(data.tags);
    if (data.avatarAssetId !== undefined) values.avatarAssetId = data.avatarAssetId;
    if (data.avatarFullAssetId !== undefined) values.avatarFullAssetId = data.avatarFullAssetId;
    if (data.avatarCropJson !== undefined) values.avatarCropJson = data.avatarCropJson;

    const [row] = await this.db
      .update(characters)
      .set(values)
      .where(eq(characters.id, id))
      .returning();

    if (!row) {
      throw new Error(`Character '${id}' not found after update`);
    }
    const updated = this.mapRow(row);

    // Dual write: update content file
    if (this.content) {
      const fileData = this.toFileData(updated);
      const displayName = updated.name || updated.slug;
      const hash = await this.content.writeEntity(STORAGE_FOLDERS.characters, id, fileData, { displayName });
      await this.db
        .update(characters)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(characters.id, id))
        .run();
    }

    return updated;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(characters).where(eq(characters.id, id)).run();
    if (this.content) {
      await this.content.deleteEntity(STORAGE_FOLDERS.characters, id);
    }
  }

  async updateIsSystem(id: string, isSystem: boolean): Promise<void> {
    await this.db
      .update(characters)
      .set({ isSystem: isSystem ? 1 : 0 })
      .where(eq(characters.id, id))
      .run();
  }

  async duplicate(id: string): Promise<Character> {
    const original = await this.db.select().from(characters).where(eq(characters.id, id)).get();
    if (!original) {
      throw new Error(`Character '${id}' not found`);
    }

    const newId = this.idGen.next('char');
    const now = this.clock.now();

    const [row] = await this.db
      .insert(characters)
      .values({
        id: newId,
        name: `${original.name} (copy)`,
        isSystem: 0,
        description: original.description,
        personalitySummary: original.personalitySummary,
        defaultScenario: original.defaultScenario,
        firstMessage: original.firstMessage,
        mesExample: original.mesExample,
        mesExampleMode: original.mesExampleMode,
        mesExampleDepth: original.mesExampleDepth,
        alternateGreetingsJson: original.alternateGreetingsJson,
        postHistoryInstructions: original.postHistoryInstructions,
        creatorNotes: original.creatorNotes,
        characterBookJson: original.characterBookJson,
        depthPrompt: original.depthPrompt,
        depthPromptDepth: original.depthPromptDepth,
        depthPromptRole: original.depthPromptRole,
        extensionsJson: original.extensionsJson,
        systemPrompt: original.systemPrompt,
        tagsJson: original.tagsJson,
        avatarAssetId: original.avatarAssetId,
        avatarFullAssetId: original.avatarFullAssetId,
        avatarCropJson: original.avatarCropJson,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const copy = this.mapRow(row!);

    // Dual write: persist copy to file store
    if (this.content) {
      const fileData = this.toFileData(copy);
      const displayName = copy.name || copy.slug;
      const hash = await this.content.writeEntity(STORAGE_FOLDERS.characters, newId, fileData, { displayName });
      await this.db
        .update(characters)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(characters.id, newId))
        .run();
    }

    return copy;
  }

  // ─── Status operations ─────────────────────────────────────────────────────

  async archive(id: string): Promise<Character> {
    const now = this.clock.now();
    const [row] = await this.db
      .update(characters)
      .set({ status: 'archived', updatedAt: now })
      .where(eq(characters.id, id))
      .returning();

    if (!row) {
      throw new Error(`Character '${id}' not found after archive`);
    }
    return this.mapRow(row);
  }

  async unarchive(id: string): Promise<Character> {
    const now = this.clock.now();
    const [row] = await this.db
      .update(characters)
      .set({ status: 'active', updatedAt: now })
      .where(eq(characters.id, id))
      .returning();

    if (!row) {
      throw new Error(`Character '${id}' not found after unarchive`);
    }
    return this.mapRow(row);
  }

  // ─── System character ──────────────────────────────────────────────────────

  async getSystemCharacter(): Promise<Character> {
    const existing = await this.db
      .select()
      .from(characters)
      .where(eq(characters.id, 'char_system'))
      .get();

    if (existing) return this.mapRow(existing);

    await this.db
      .insert(characters)
      .values({
        id: 'char_system',
        name: 'Char',
        isSystem: 1,
        description: '',
        status: 'active',
        alternateGreetingsJson: '[]',
        tagsJson: '[]',
        extensionsJson: '{}',
        createdAt: this.clock.now(),
        updatedAt: this.clock.now(),
      })
      .run();

    const created = await this.db
      .select()
      .from(characters)
      .where(eq(characters.id, 'char_system'))
      .get();

    return this.mapRow(created!);
  }

  // ─── File data helpers ────────────────────────────────────────────────────

  private toFileData(char: Character): Record<string, unknown> {
    return {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: char.name,
        description: char.description,
        personality: char.personalitySummary ?? '',
        scenario: char.defaultScenario ?? '',
        first_mes: char.firstMessage ?? '',
        mes_example: char.mesExample ?? '',
        system_prompt: char.systemPrompt ?? '',
        creator_notes: char.creatorNotes ?? '',
        post_history_instructions: char.postHistoryInstructions ?? '',
        alternate_greetings: char.alternateGreetings,
        tags: char.tags,
        character_book: char.characterBook ?? undefined,
        extensions: char.extensions,
        depth_prompt: {
          prompt: char.depthPrompt ?? '',
          depth: char.depthPromptDepth ?? 4,
          role: char.depthPromptRole ?? 'system',
        },
      },
    };
  }

  // ─── Row mapper ────────────────────────────────────────────────────────────

  private mapRow(row: typeof characters.$inferSelect): Character {
    return {
      id: row.id,
      slug: deriveSlug(row.name),
      name: row.name,
      isSystem: row.isSystem === 1,
      description: row.description,
      personalitySummary: row.personalitySummary,
      defaultScenario: row.defaultScenario,
      firstMessage: row.firstMessage,
      mesExample: row.mesExample,
      mesExampleMode: row.mesExampleMode,
      mesExampleDepth: row.mesExampleDepth,
      alternateGreetings: JSON.parse(row.alternateGreetingsJson),
      postHistoryInstructions: row.postHistoryInstructions,
      creatorNotes: row.creatorNotes,
      characterBook: row.characterBookJson ? JSON.parse(row.characterBookJson) : null,
      depthPrompt: row.depthPrompt,
      depthPromptDepth: row.depthPromptDepth,
      depthPromptRole: row.depthPromptRole,
      extensions: JSON.parse(row.extensionsJson),
      systemPrompt: row.systemPrompt,
      tags: JSON.parse(row.tagsJson),
      avatarAssetId: row.avatarAssetId,
      avatarFullAssetId: row.avatarFullAssetId,
      avatarCropJson: row.avatarCropJson ?? null,
      status: row.status as Character['status'],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
