import { type StoredProxyRecord, type CreateProxyData, type UpdateProxyData } from '@vibe-tavern/domain';
import { asc, eq, sql } from 'drizzle-orm';
import { proxyProfiles, proxySettings, providerProfiles } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

// ─── Return types ─────────────────────────────────────────────────────────────

/**
 * Store-level proxy profile — mirrors StoredProxyRecord from domain.
 * Uses plain `string` IDs (brands are applied at the API boundary).
 */
export type ProxyProfile = StoredProxyRecord;

// ─── Store ────────────────────────────────────────────────────────────────────

export class ProxyStore {
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

  async listAll(): Promise<ProxyProfile[]> {
    const rows = await this.db.select().from(proxyProfiles).orderBy(asc(proxyProfiles.sortOrder), asc(proxyProfiles.createdAt)).all();
    return rows.map((row) => this.mapRow(row));
  }

  async getById(id: string): Promise<ProxyProfile | null> {
    const row = await this.db.select().from(proxyProfiles).where(eq(proxyProfiles.id, id)).get();
    return row ? this.mapRow(row) : null;
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  async create(data: CreateProxyData): Promise<ProxyProfile> {
    const id = this.idGen.next('proxy');
    const now = this.clock.now();

    // Append at end: sort_order = current max + 1 (see ProviderStore.create).
    const maxRow = await this.db
      .select({ maxSort: sql<number>`COALESCE(MAX(${proxyProfiles.sortOrder}), -1)` })
      .from(proxyProfiles)
      .get();
    const nextSortOrder = (maxRow?.maxSort ?? -1) + 1;

    const [row] = await this.db
      .insert(proxyProfiles)
      .values({
        id,
        name: data.name,
        url: data.url,
        username: data.username ?? null,
        password: data.password ?? null,
        sortOrder: nextSortOrder,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return this.mapRow(row!);
  }

  async update(id: string, data: UpdateProxyData): Promise<ProxyProfile> {
    const now = this.clock.now();

    const values: Partial<typeof proxyProfiles.$inferInsert> = { updatedAt: now };
    if (data.name !== undefined) values.name = data.name;
    if (data.url !== undefined) values.url = data.url;
    if (data.username !== undefined) values.username = data.username;
    if (data.password !== undefined) values.password = data.password;

    const [row] = await this.db
      .update(proxyProfiles)
      .set(values)
      .where(eq(proxyProfiles.id, id))
      .returning();

    if (!row) {
      throw new Error(`ProxyProfile '${id}' not found after update`);
    }
    return this.mapRow(row);
  }

  /**
   * Atomically delete a proxy AND clean up all references:
   * 1. Clear it as the global default (proxy_settings.default_proxy_id → null).
   * 2. Move every provider with `proxyMode === 'proxy'` and `proxyId === id`
   *    back to `inherit` + null proxyId.
   * 3. Delete the proxy row itself.
   *
   * All three steps run in one synchronous transaction so no partial state
   * (dangling mode/ID pair) can ever be observed by a concurrent reader.
   * See ASYNC_TRANSACTION_AUDIT: drizzle-orm + bun:sqlite commits at the end
   * of the synchronous callback prefix, so keeping this synchronous means a
   * throw rolls the whole tx back.
   */
  async delete(id: string): Promise<void> {
    this.db.transaction((tx) => {
      // Validate existence BEFORE any write so a stale id throws before the
      // global-default/provider cleanups run (no partial state).
      const target = tx.select({ id: proxyProfiles.id }).from(proxyProfiles)
        .where(eq(proxyProfiles.id, id)).get();
      if (!target) {
        throw new Error(`ProxyProfile '${id}' not found`);
      }

      // 1. Clear global default if it points at this proxy.
      tx.update(proxySettings)
        .set({ defaultProxyId: null, updatedAt: this.clock.now() })
        .where(eq(proxySettings.defaultProxyId, id))
        .run();

      // 2. Re-home affected providers: proxy → inherit, proxyId → null.
      tx.update(providerProfiles)
        .set({ proxyMode: 'inherit', proxyId: null, updatedAt: this.clock.now() })
        .where(eq(providerProfiles.proxyId, id))
        .run();

      // 3. Delete the proxy row.
      tx.delete(proxyProfiles).where(eq(proxyProfiles.id, id)).run();
    });
  }

  async reorder(updates: Array<{ id: string; sortOrder: number }>): Promise<ProxyProfile[]> {
    const now = this.clock.now();
    // Synchronous callback (ASYNC_TRANSACTION_AUDIT step 4): see delete.
    this.db.transaction((tx) => {
      for (const u of updates) {
        tx
          .update(proxyProfiles)
          .set({ sortOrder: u.sortOrder, updatedAt: now })
          .where(eq(proxyProfiles.id, u.id))
          .run();
      }
    });
    return this.listAll();
  }

  // ─── Global default proxy (singleton) ───────────────────────────────────────

  async getDefaultProxyId(): Promise<string | null> {
    const row = await this.db.select().from(proxySettings).where(eq(proxySettings.id, 'default')).get();
    return row?.defaultProxyId ?? null;
  }

  async setDefaultProxyId(proxyId: string | null): Promise<void> {
    const now = this.clock.now();
    // Validate and write in one synchronous transaction so a concurrent delete
    // cannot leave proxy_settings pointing at a proxy that disappeared between
    // a service-level existence check and this write.
    this.db.transaction((tx) => {
      if (proxyId !== null) {
        const target = tx.select({ id: proxyProfiles.id }).from(proxyProfiles)
          .where(eq(proxyProfiles.id, proxyId)).get();
        if (!target) {
          throw new Error(`ProxyProfile '${proxyId}' not found`);
        }
      }

      const existing = tx.select({ id: proxySettings.id }).from(proxySettings)
        .where(eq(proxySettings.id, 'default')).get();
      if (existing) {
        tx.update(proxySettings)
          .set({ defaultProxyId: proxyId, updatedAt: now })
          .where(eq(proxySettings.id, 'default'))
          .run();
      } else {
        tx.insert(proxySettings)
          .values({ id: 'default', defaultProxyId: proxyId, updatedAt: now })
          .run();
      }
    });
  }

  // ─── Row mappers ───────────────────────────────────────────────────────────

  private mapRow(row: typeof proxyProfiles.$inferSelect): ProxyProfile {
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      username: row.username,
      password: row.password,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
