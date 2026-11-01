import { eq } from 'drizzle-orm';
import { brandId, type ChatId, type ExperienceCopilotThreadId } from '@vibe-tavern/domain';
import { agentReviewRounds } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock } from '../persistence.js';

export interface AgentReviewRoundRecord {
  threadId: ExperienceCopilotThreadId;
  envelopeJson: string;
  updatedAt: string;
}
export interface ChatReviewRoundRecord {
  chatId: ChatId;
  envelopeJson: string;
  updatedAt: string;
}

/** Thread/chat-owned review persistence. The API boundary validates/serializes the
 * shared envelope; db keeps it opaque (no dependency on api-contracts and no
 * parallel handwritten envelope validator). Full replacement is atomic via
 * the owner's unique key, including per-hunk progress and dangling capture. */
export class AgentReviewRoundStore {
  private readonly clock: StoreClock;

  constructor(private readonly db: AppDb, options?: { clock?: StoreClock }) {
    this.clock = resolveStoreRuntime(options).clock;
  }

  async get(threadId: string): Promise<AgentReviewRoundRecord | null> {
    const row = await this.db.select().from(agentReviewRounds)
      .where(eq(agentReviewRounds.threadId, threadId)).get();
    return row?.threadId ? { threadId: brandId<ExperienceCopilotThreadId>(row.threadId), envelopeJson: row.envelopeJson, updatedAt: row.updatedAt } : null;
  }

  async put(threadId: string, envelopeJson: string): Promise<void> {
    await this.putOwner({ threadId }, envelopeJson);
  }

  async delete(threadId: string): Promise<void> {
    await this.db.delete(agentReviewRounds).where(eq(agentReviewRounds.threadId, threadId)).run();
  }

  async getChat(chatId: string): Promise<ChatReviewRoundRecord | null> {
    const row = await this.db.select().from(agentReviewRounds).where(eq(agentReviewRounds.chatId, chatId)).get();
    return row?.chatId ? { chatId: brandId<ChatId>(row.chatId), envelopeJson: row.envelopeJson, updatedAt: row.updatedAt } : null;
  }

  async putChat(chatId: string, envelopeJson: string): Promise<void> {
    await this.putOwner({ chatId }, envelopeJson);
  }

  async deleteChat(chatId: string): Promise<void> {
    await this.db.delete(agentReviewRounds).where(eq(agentReviewRounds.chatId, chatId)).run();
  }

  private async putOwner(owner: { threadId?: string; chatId?: string }, envelopeJson: string): Promise<void> {
    if ((owner.threadId === undefined) === (owner.chatId === undefined)) throw new Error('A review must have exactly one owner.');
    const updatedAt = this.clock.now();
    await this.db.insert(agentReviewRounds).values({ ...owner, envelopeJson, updatedAt })
      .onConflictDoUpdate({ target: owner.threadId === undefined ? agentReviewRounds.chatId : agentReviewRounds.threadId,
        set: { envelopeJson, updatedAt } }).run();
  }
}
