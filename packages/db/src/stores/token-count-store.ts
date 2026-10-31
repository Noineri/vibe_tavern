import { and, eq, or } from 'drizzle-orm';
import { tokenCounts } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock } from '../persistence.js';

/**
 * A token_counts lookup key: one (text hash, tokenizer id) pair.
 */
export interface TokenCountKey {
  textHash: string;
  tokenizer: string;
}

/**
 * A stored token_counts row (shape mirrors the table — see the schema
 * comment for the insert-or-ignore design).
 */
export interface TokenCountRow extends TokenCountKey {
  tokenCount: number;
  createdAt: string;
}

/**
 * Row payload for putMany — created_at is stamped by the store.
 */
export interface TokenCountPut extends TokenCountKey {
  tokenCount: number;
}

/**
 * Composite key for getMany's result map. Callers look hits up through this
 * helper, never a hand-built key string (one derivation of the key format).
 */
export function tokenCountKey(textHash: string, tokenizer: string): string {
  return `${textHash}::${tokenizer}`;
}

/**
 * Persistent per-(exact text, tokenizer) token counts — TOKEN_COUNT_ONCE_PLAN
 * TC-1. Storage ONLY: the hash derivation and the cache layering live in the
 * tokenizer service (TC-2); this store never inspects a hash. Writes are
 * insert-or-ignore (first writer wins) because a token count is
 * deterministic per (text, tokenizer) — a repeated put is always a no-op,
 * never a correction.
 */
export class TokenCountStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;

  constructor(db: AppDb, options?: { clock?: StoreClock }) {
    this.db = db;
    this.clock = resolveStoreRuntime(options).clock;
  }

  async get(textHash: string, tokenizer: string): Promise<TokenCountRow | null> {
    const rows = await this.db
      .select()
      .from(tokenCounts)
      .where(and(eq(tokenCounts.textHash, textHash), eq(tokenCounts.tokenizer, tokenizer)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Batched lookup: only the requested (hash, tokenizer) pairs that exist,
   * keyed by tokenCountKey — misses are simply absent from the map.
   */
  async getMany(entries: ReadonlyArray<TokenCountKey>): Promise<Map<string, TokenCountRow>> {
    const hits = new Map<string, TokenCountRow>();
    if (entries.length === 0) return hits;
    // Each entry binds 2 params (hash + tokenizer), so 300 entries stay
    // under SQLite's 999-variable floor even on builds compiled with the
    // old limit.
    const BATCH = 300;
    for (let i = 0; i < entries.length; i += BATCH) {
      const slice = entries.slice(i, i + BATCH);
      const found = await this.db
        .select()
        .from(tokenCounts)
        .where(
          or(
            ...slice.map((entry) =>
              and(eq(tokenCounts.textHash, entry.textHash), eq(tokenCounts.tokenizer, entry.tokenizer)),
            ),
          ),
        )
        .all();
      for (const row of found) hits.set(tokenCountKey(row.textHash, row.tokenizer), row);
    }
    return hits;
  }

  /**
   * Persist counts in ONE transaction, insert-or-ignore: a (hash, tokenizer)
   * row that already exists keeps its first value (deterministic counts — a
   * second write can never be a correction).
   */
  async putMany(rows: ReadonlyArray<TokenCountPut>): Promise<void> {
    if (rows.length === 0) return;
    const createdAt = this.clock.now();
    // Synchronous transaction callback (ASYNC_TRANSACTION_AUDIT): a throw on
    // any chunk rolls back every earlier one, so a retry starts from the
    // pre-write state instead of a partial batch.
    this.db.transaction((tx) => {
      // 4 bound params per row → 200 rows stay under SQLite's 999-variable
      // floor even on builds compiled with the old limit.
      const BATCH = 200;
      for (let i = 0; i < rows.length; i += BATCH) {
        tx.insert(tokenCounts)
          .values(rows.slice(i, i + BATCH).map((row) => ({ ...row, createdAt })))
          .onConflictDoNothing()
          .run();
      }
    });
  }
}
