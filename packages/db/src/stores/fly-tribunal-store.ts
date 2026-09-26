import { asc, eq, isNull } from 'drizzle-orm';
import { flyTribunalMemory } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

/**
 * Current encoding version for the gzipped sparse KC→MBON delta blob.
 *
 * `weights` is null before the fly has learned any precedent (or after
 * amnesty). The worker owns the binary encoding; this store only preserves its
 * opaque bytes and exposes base64 at the API boundary.
 */
export const FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION = 1;

export type FlyTribunalMemoryScope = 'chat' | 'global';

type FlyTribunalMemoryKey =
  | { scope: 'global' }
  | { scope: 'chat'; chatId: string };

/** One persisted fly memory as it crosses the DB/API boundary. */
export interface FlyTribunalMemory {
  scope: FlyTribunalMemoryScope;
  /** Present exactly for a per-chat row; absent for the one global row. */
  chatId?: string;
  schemaVersion: number;
  precedentCount: number;
  /** Base64 of gzipped sparse deltas; null = fresh fly. */
  weights: string | null;
  updatedAt: string;
}

interface FlyTribunalMemoryWrite {
  schemaVersion: number;
  precedentCount: number;
  weights: string | null;
}

/**
 * Full replacement payload for one memory scope. The public shape intentionally
 * matches `FlyMemoryPut` in api-contracts without importing upward from db into
 * that sibling package (the dependency graph forbids db → api-contracts).
 */
export type FlyTribunalMemoryPutData =
  | ({ scope: 'global'; chatId?: never } & FlyTribunalMemoryWrite)
  | ({ scope: 'chat'; chatId: string } & FlyTribunalMemoryWrite);

/**
 * Persistence for Fly Tribunal's slow associative memory (FT-3).
 *
 * Correspondence with the closest small-resource store pattern:
 * - `ImagePromptVariantStore.upsert` supplies full-row replace semantics and
 *   store-owned clock/id injection.
 * - `UiSettingsStore.get` supplies an absent-row default rather than a 404.
 *
 * Named deviations: this table's nullable `chat_id` represents global scope;
 * SQLite unique indexes allow multiple NULLs, so global writes SELECT the
 * existing row before choosing update versus insert. The column itself is a
 * BLOB, while callers use the API contract's base64 string.
 */
export class FlyTribunalStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  /** Return a memory row, or the fresh-fly response shape when none exists. */
  async get(scope: 'global'): Promise<FlyTribunalMemory>;
  async get(scope: 'chat', chatId: string): Promise<FlyTribunalMemory>;
  async get(scope: FlyTribunalMemoryScope, chatId?: string): Promise<FlyTribunalMemory> {
    const key = this.resolveKey(scope, chatId);
    const row = await this.findRow(key);
    return row ? this.mapRow(row) : this.freshMemory(key);
  }

  /**
   * Full-row insert or replacement. The global path is deliberately
   * select-first because SQLite's unique `chat_id` index permits many NULLs.
   */
  async put(data: FlyTribunalMemoryPutData): Promise<FlyTribunalMemory> {
    const key = this.resolveKey(data.scope, data.chatId);
    const existing = await this.findRow(key);
    const now = this.clock.now();
    const weights = this.decodeWeights(data.weights);

    if (existing) {
      const [row] = await this.db
        .update(flyTribunalMemory)
        .set({
          weights,
          precedentCount: data.precedentCount,
          schemaVersion: data.schemaVersion,
          updatedAt: now,
        })
        .where(eq(flyTribunalMemory.id, existing.id))
        .returning();
      if (!row) throw new Error(`Fly Tribunal memory ${existing.id} disappeared during update`);
      return this.mapRow(row);
    }

    const [row] = await this.db
      .insert(flyTribunalMemory)
      .values({
        id: this.idGen.next('flymem'),
        chatId: key.scope === 'chat' ? key.chatId : null,
        weights,
        precedentCount: data.precedentCount,
        schemaVersion: data.schemaVersion,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error('Fly Tribunal memory insert returned no row');
    return this.mapRow(row);
  }

  /** Delete a memory row. Idempotent; the next get returns fresh-fly state. */
  async delete(scope: 'global'): Promise<void>;
  async delete(scope: 'chat', chatId: string): Promise<void>;
  async delete(scope: FlyTribunalMemoryScope, chatId?: string): Promise<void> {
    const key = this.resolveKey(scope, chatId);
    if (key.scope === 'global') {
      await this.db.delete(flyTribunalMemory).where(isNull(flyTribunalMemory.chatId)).run();
      return;
    }
    await this.db.delete(flyTribunalMemory).where(eq(flyTribunalMemory.chatId, key.chatId)).run();
  }

  private async findRow(key: FlyTribunalMemoryKey) {
    if (key.scope === 'global') {
      return this.db
        .select()
        .from(flyTribunalMemory)
        .where(isNull(flyTribunalMemory.chatId))
        .orderBy(asc(flyTribunalMemory.id))
        .get();
    }
    return this.db
      .select()
      .from(flyTribunalMemory)
      .where(eq(flyTribunalMemory.chatId, key.chatId))
      .get();
  }

  private resolveKey(scope: FlyTribunalMemoryScope, chatId?: string): FlyTribunalMemoryKey {
    if (scope === 'chat') {
      if (!chatId) throw new Error('Fly Tribunal chat memory requires chatId');
      return { scope: 'chat', chatId };
    }
    if (chatId !== undefined) throw new Error('Fly Tribunal global memory must not carry chatId');
    return { scope: 'global' };
  }

  private freshMemory(key: FlyTribunalMemoryKey): FlyTribunalMemory {
    return {
      ...key,
      schemaVersion: FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION,
      precedentCount: 0,
      weights: null,
      updatedAt: '',
    };
  }

  private decodeWeights(weights: string | null): Buffer | null {
    return weights === null ? null : Buffer.from(weights, 'base64');
  }

  private mapRow(row: typeof flyTribunalMemory.$inferSelect): FlyTribunalMemory {
    return {
      scope: row.chatId === null ? 'global' : 'chat',
      ...(row.chatId === null ? {} : { chatId: row.chatId }),
      schemaVersion: row.schemaVersion,
      precedentCount: row.precedentCount,
      weights: row.weights === null ? null : Buffer.from(row.weights).toString('base64'),
      updatedAt: row.updatedAt,
    };
  }
}
