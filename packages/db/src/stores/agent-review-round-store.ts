import { eq } from 'drizzle-orm';
import { brandId, type ExperienceCopilotThreadId } from '@vibe-tavern/domain';
import { agentReviewRounds } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock } from '../persistence.js';

export interface AgentReviewRoundRecord {
  threadId: ExperienceCopilotThreadId;
  envelopeJson: string;
  updatedAt: string;
}

/** Thread-owned review persistence. The API boundary validates/serializes the
 * shared envelope; db keeps it opaque (no dependency on api-contracts and no
 * parallel handwritten envelope validator). Full replacement is atomic via
 * the thread primary key, including per-hunk progress and dangling capture. */
export class AgentReviewRoundStore {
  private readonly clock: StoreClock;

  constructor(private readonly db: AppDb, options?: { clock?: StoreClock }) {
    this.clock = resolveStoreRuntime(options).clock;
  }

  async get(threadId: string): Promise<AgentReviewRoundRecord | null> {
    const row = await this.db.select().from(agentReviewRounds)
      .where(eq(agentReviewRounds.threadId, threadId)).get();
    return row ? { ...row, threadId: brandId<ExperienceCopilotThreadId>(row.threadId) } : null;
  }

  async put(threadId: string, envelopeJson: string): Promise<void> {
    const updatedAt = this.clock.now();
    await this.db.insert(agentReviewRounds).values({ threadId, envelopeJson, updatedAt })
      .onConflictDoUpdate({
        target: agentReviewRounds.threadId,
        set: { envelopeJson, updatedAt },
      }).run();
  }

  async delete(threadId: string): Promise<void> {
    await this.db.delete(agentReviewRounds).where(eq(agentReviewRounds.threadId, threadId)).run();
  }
}
