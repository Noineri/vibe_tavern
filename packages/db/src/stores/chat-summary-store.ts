import { and, asc, eq } from 'drizzle-orm';
import { chatSummaries } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';
import type { ContentStore } from '../content-store.js';
import { STORAGE_FOLDERS } from '../file-store.js';

export interface ChatSummary {
  id: string;
  chatId: string;
  branchId: string;
  label: string;
  content: string;
  summarizedFrom: number;
  summarizedTo: number;
  includeInContext: boolean;
  excludeSummarized: boolean;
  source: 'manual' | 'auto';
  sortOrder: number;
  contentHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateChatSummaryData {
  chatId: string;
  branchId: string;
  label?: string;
  content?: string;
  summarizedFrom: number;
  summarizedTo: number;
  includeInContext?: boolean;
  excludeSummarized?: boolean;
  source?: 'manual' | 'auto';
  sortOrder?: number;
}

export interface UpdateChatSummaryData {
  label?: string;
  content?: string;
  summarizedFrom?: number;
  summarizedTo?: number;
  includeInContext?: boolean;
  excludeSummarized?: boolean;
  sortOrder?: number;
}

type ChatSummaryRow = typeof chatSummaries.$inferSelect;
type ChatSummaryInsert = typeof chatSummaries.$inferInsert;

export class ChatSummaryStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;
  private readonly content: ContentStore;

  constructor(db: AppDb, options: { clock?: StoreClock; idGenerator?: StoreIdGenerator; content: ContentStore }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
    this.content = options.content;
  }

  async listByChatBranch(chatId: string, branchId: string): Promise<ChatSummary[]> {
    const rows = await this.db
      .select()
      .from(chatSummaries)
      .where(and(eq(chatSummaries.chatId, chatId), eq(chatSummaries.branchId, branchId)))
      .orderBy(asc(chatSummaries.sortOrder), asc(chatSummaries.summarizedFrom), asc(chatSummaries.createdAt))
      .all();
    return Promise.all(rows.map((row) => this.mapRowWithContent(row)));
  }

  async getById(id: string): Promise<ChatSummary | null> {
    const row = await this.db.select().from(chatSummaries).where(eq(chatSummaries.id, id)).get();
    if (!row) return null;
    return this.mapRowWithContent(row);
  }

  async getContent(id: string): Promise<string> {
    return (await this.content.readText(STORAGE_FOLDERS.summaries, id)) ?? '';
  }

  async create(data: CreateChatSummaryData): Promise<ChatSummary> {
    const id = this.idGen.next('chat_summary');
    const now = this.clock.now();
    const content = data.content ?? '';
    const contentHash = await this.content.writeText(STORAGE_FOLDERS.summaries, id, content);

    const values: ChatSummaryInsert = {
      id,
      chatId: data.chatId,
      branchId: data.branchId,
      label: data.label ?? '',
      summarizedFrom: normalizeFrom(data.summarizedFrom),
      summarizedTo: normalizeTo(data.summarizedTo),
      includeInContext: (data.includeInContext ?? true) ? 1 : 0,
      excludeSummarized: (data.excludeSummarized ?? true) ? 1 : 0,
      source: data.source ?? 'manual',
      sortOrder: data.sortOrder ?? 0,
      contentHash,
      createdAt: now,
      updatedAt: now,
    };

    const [row] = await this.db.insert(chatSummaries).values(values).returning();
    return this.mapRowWithContent(row!);
  }

  async update(id: string, data: UpdateChatSummaryData): Promise<ChatSummary> {
    const values: Partial<ChatSummaryInsert> = { updatedAt: this.clock.now() };
    if (data.label !== undefined) values.label = data.label;
    if (data.summarizedFrom !== undefined) values.summarizedFrom = normalizeFrom(data.summarizedFrom);
    if (data.summarizedTo !== undefined) values.summarizedTo = normalizeTo(data.summarizedTo);
    if (data.includeInContext !== undefined) values.includeInContext = data.includeInContext ? 1 : 0;
    if (data.excludeSummarized !== undefined) values.excludeSummarized = data.excludeSummarized ? 1 : 0;
    if (data.sortOrder !== undefined) values.sortOrder = data.sortOrder;
    if (data.content !== undefined) {
      values.contentHash = await this.content.writeText(STORAGE_FOLDERS.summaries, id, data.content);
    }

    const [row] = await this.db.update(chatSummaries).set(values).where(eq(chatSummaries.id, id)).returning();
    if (!row) throw new Error(`Chat summary '${id}' not found after update`);
    return this.mapRowWithContent(row);
  }

  async updateContent(id: string, text: string): Promise<void> {
    const hash = await this.content.writeText(STORAGE_FOLDERS.summaries, id, text);
    await this.db
      .update(chatSummaries)
      .set({ contentHash: hash, updatedAt: this.clock.now() })
      .where(eq(chatSummaries.id, id))
      .run();
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(chatSummaries).where(eq(chatSummaries.id, id)).run();
    await this.content.deleteText(STORAGE_FOLDERS.summaries, id);
  }

  async reorder(chatId: string, branchId: string, orderedIds: string[]): Promise<void> {
    const now = this.clock.now();
    await this.db.transaction(async (tx) => {
      for (const [index, id] of orderedIds.entries()) {
        await tx
          .update(chatSummaries)
          .set({ sortOrder: index, updatedAt: now })
          .where(and(eq(chatSummaries.id, id), eq(chatSummaries.chatId, chatId), eq(chatSummaries.branchId, branchId)))
          .run();
      }
    });
  }

  private async mapRowWithContent(row: ChatSummaryRow): Promise<ChatSummary> {
    return {
      ...this.mapRow(row),
      content: await this.getContent(row.id),
    };
  }

  private mapRow(row: ChatSummaryRow): Omit<ChatSummary, 'content'> {
    return {
      id: row.id,
      chatId: row.chatId,
      branchId: row.branchId,
      label: row.label,
      summarizedFrom: row.summarizedFrom,
      summarizedTo: row.summarizedTo,
      includeInContext: row.includeInContext === 1,
      excludeSummarized: row.excludeSummarized === 1,
      source: row.source === 'auto' ? 'auto' : 'manual',
      sortOrder: row.sortOrder,
      contentHash: row.contentHash,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

function normalizeFrom(value: number): number {
  return Math.max(1, Math.floor(value));
}

function normalizeTo(value: number): number {
  return Math.max(0, Math.floor(value));
}
