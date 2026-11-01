import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { ChatGenerationJobStatus } from '@vibe-tavern/domain';
import { chatGenerationJobs, messages } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator, type StoreRuntimeOptions } from '../persistence.js';

type JobRow = typeof chatGenerationJobs.$inferSelect;
export type ChatGenerationJobRecord = Omit<JobRow, 'variantIndex' | 'error'> & { variantIndex?: number; error?: string };
export type EnqueueChatGenerationJob = Pick<JobRow, 'chatId' | 'messageId' | 'model' | 'promptPresetId'>;
export type ChatGenerationJobUpdate = Pick<JobRow, 'status'> & Partial<Pick<JobRow, 'variantIndex' | 'error'>>;

function mapJob(row: JobRow): ChatGenerationJobRecord {
  const { variantIndex, error, ...job } = row;
  return { ...job, ...(variantIndex === null ? {} : { variantIndex }), ...(error === null ? {} : { error }) };
}

/** Durable queue facts only; no runner, notifications or generation side effects.
 * Enqueue timestamps retain the web's milliseconds. SQLite insertion order is
 * the tie-breaker when several jobs arrive within the same millisecond. */
export class ChatGenerationJobStore {
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(private readonly db: AppDb, options?: StoreRuntimeOptions) {
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  async enqueue(input: EnqueueChatGenerationJob): Promise<ChatGenerationJobRecord> {
    // Independent hard FKs enforce existence/cascade. This synchronous check
    // additionally forbids a user/tool message or a different chat's target.
    const target = this.db.select({ chatId: messages.chatId, role: messages.role }).from(messages)
      .where(eq(messages.id, input.messageId)).get();
    if (!target || target.chatId !== input.chatId || target.role !== 'assistant')
      throw new Error('A queue job requires an existing assistant message in its chat.');
    const row = this.db.insert(chatGenerationJobs).values({
      ...input, id: this.idGen.next('qjob'), status: 'pending', enqueuedAt: Date.parse(this.clock.now()),
    }).returning().get();
    return mapJob(row);
  }

  async get(chatId: string, jobId: string): Promise<ChatGenerationJobRecord | null> {
    const row = this.db.select().from(chatGenerationJobs)
      .where(and(eq(chatGenerationJobs.chatId, chatId), eq(chatGenerationJobs.id, jobId))).get();
    return row ? mapJob(row) : null;
  }

  async listByChat(chatId: string): Promise<ChatGenerationJobRecord[]> {
    return this.db.select().from(chatGenerationJobs).where(eq(chatGenerationJobs.chatId, chatId))
      .orderBy(asc(chatGenerationJobs.enqueuedAt), sql`${chatGenerationJobs}.rowid`).all().map(mapJob);
  }

  async nextPending(chatId: string): Promise<ChatGenerationJobRecord | null> {
    const row = this.db.select().from(chatGenerationJobs)
      .where(and(eq(chatGenerationJobs.chatId, chatId), eq(chatGenerationJobs.status, 'pending')))
      .orderBy(asc(chatGenerationJobs.enqueuedAt), sql`${chatGenerationJobs}.rowid`).limit(1).get();
    return row ? mapJob(row) : null;
  }

  /** Startup discovery only; mutations still require explicit chat ownership. */
  async unfinishedChatIds(): Promise<string[]> {
    return this.db.selectDistinct({ chatId: chatGenerationJobs.chatId }).from(chatGenerationJobs)
      .where(inArray(chatGenerationJobs.status, ['pending', 'running'])).all().map((row) => row.chatId);
  }

  /** The runner can guard a pending->running claim or terminal settlement with
   * expectedStatus. This store deliberately does not invent runner policy. */
  async setStatus(chatId: string, jobId: string, update: ChatGenerationJobUpdate, expectedStatus?: ChatGenerationJobStatus): Promise<ChatGenerationJobRecord | null> {
    const row = this.db.update(chatGenerationJobs).set({
      status: update.status, variantIndex: update.variantIndex ?? null, error: update.error ?? null,
    }).where(and(eq(chatGenerationJobs.chatId, chatId), eq(chatGenerationJobs.id, jobId),
      expectedStatus === undefined ? undefined : eq(chatGenerationJobs.status, expectedStatus),
    )).returning().get();
    return row ? mapJob(row) : null;
  }

  async cancelPending(chatId: string, jobId: string): Promise<ChatGenerationJobRecord | null> {
    return this.setStatus(chatId, jobId, { status: 'cancelled' }, 'pending');
  }

  /** Remove waiting work only; running jobs and settled evidence survive. */
  async clearPending(chatId: string): Promise<number> {
    return this.db.delete(chatGenerationJobs)
      .where(and(eq(chatGenerationJobs.chatId, chatId), eq(chatGenerationJobs.status, 'pending')))
      .returning({ id: chatGenerationJobs.id }).all().length;
  }
}
