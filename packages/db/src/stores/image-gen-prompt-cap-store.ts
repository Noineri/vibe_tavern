import { and, eq } from 'drizzle-orm';
import { imageGenPromptCaps } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock } from '../persistence.js';

/**
 * Learned provider prompt caps (IF-10). One row per (backend, modelId): the
 * character cap a provider enforced on the image prompt, learned from a
 * `prompt_too_long` rejection. The row is ADVISORY everywhere — it never
 * blocks a send — and self-healing by design (see the schema comment): a
 * later success with a longer composed prompt invalidates it, a new
 * rejection re-teaches the fresh number.
 */
export interface ImageGenPromptCapRow {
  backend: string;
  modelId: string;
  maxPromptChars: number;
  learnedAt: string;
}

export class ImageGenPromptCapStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;

  constructor(db: AppDb, options?: { clock?: StoreClock }) {
    this.db = db;
    this.clock = resolveStoreRuntime(options).clock;
  }

  async list(): Promise<ImageGenPromptCapRow[]> {
    return await this.db.select().from(imageGenPromptCaps);
  }

  async get(backend: string, modelId: string): Promise<ImageGenPromptCapRow | null> {
    const rows = await this.db
      .select()
      .from(imageGenPromptCaps)
      .where(and(eq(imageGenPromptCaps.backend, backend), eq(imageGenPromptCaps.modelId, modelId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Learn (or re-learn) the cap a provider just enforced. */
  async upsert(backend: string, modelId: string, maxPromptChars: number): Promise<void> {
    const learnedAt = this.clock.now();
    await this.db
      .insert(imageGenPromptCaps)
      .values({ backend, modelId, maxPromptChars, learnedAt })
      .onConflictDoUpdate({
        target: [imageGenPromptCaps.backend, imageGenPromptCaps.modelId],
        set: { maxPromptChars, learnedAt },
      });
  }

  /**
   * Self-healing invalidation: a SUCCESSFUL generation whose composed prompt
   * ran LONGER than the stored cap proves the provider raised (or never had)
   * the limit — the row is deleted so the counter and the assist budget
   * disappear until the next rejection re-teaches the current number.
   * Returns whether a row was removed (callers may log; behavior is
   * otherwise identical).
   */
  async invalidateIfExceeded(backend: string, modelId: string, composedPromptChars: number): Promise<boolean> {
    const existing = await this.get(backend, modelId);
    if (existing === null || existing.maxPromptChars >= composedPromptChars) return false;
    await this.db
      .delete(imageGenPromptCaps)
      .where(and(eq(imageGenPromptCaps.backend, backend), eq(imageGenPromptCaps.modelId, modelId)));
    return true;
  }
}
