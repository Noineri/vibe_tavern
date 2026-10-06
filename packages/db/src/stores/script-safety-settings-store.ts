import { eq } from 'drizzle-orm';
import { scriptSafetySettings } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock } from '../persistence.js';

// ─── Return type ──────────────────────────────────────────────────────────────

/**
 * Store-level script-safety settings — the server-side singleton
 * (SCRIPT_SAFETY_PLAN decision 3): one "don't show again" flag for all
 * devices, shared with the imported-script warning flow.
 */
export interface ScriptSafetySettings {
  suppressImportWarnings: boolean;
  updatedAt: string;
}

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Singleton-settings store for imported-script warnings. Mirrors the
 * proxy-store singleton pattern (fixed id `'default'`, read + upsert);
 * `get()` returns the defaults when no row exists yet, like UiSettingsStore.
 */
export class ScriptSafetySettingsStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;

  constructor(db: AppDb, options?: { clock?: StoreClock }) {
    this.db = db;
    this.clock = resolveStoreRuntime(options).clock;
  }

  /** Current settings; the default (not suppressed) when the row is absent. */
  async get(): Promise<ScriptSafetySettings> {
    const row = await this.db
      .select()
      .from(scriptSafetySettings)
      .where(eq(scriptSafetySettings.id, 'default'))
      .get();
    if (!row) {
      return { suppressImportWarnings: false, updatedAt: '' };
    }
    return this.mapRow(row);
  }

  /** Insert or replace the singleton row. Idempotent on the fixed id. */
  async upsert(data: { suppressImportWarnings: boolean }): Promise<ScriptSafetySettings> {
    const now = this.clock.now();
    const existing = await this.db
      .select({ id: scriptSafetySettings.id })
      .from(scriptSafetySettings)
      .where(eq(scriptSafetySettings.id, 'default'))
      .get();
    if (existing) {
      await this.db
        .update(scriptSafetySettings)
        .set({ suppressImportWarnings: data.suppressImportWarnings ? 1 : 0, updatedAt: now })
        .where(eq(scriptSafetySettings.id, 'default'))
        .run();
    } else {
      await this.db
        .insert(scriptSafetySettings)
        .values({ id: 'default', suppressImportWarnings: data.suppressImportWarnings ? 1 : 0, updatedAt: now })
        .run();
    }
    return this.get();
  }

  // ─── Row mapper ────────────────────────────────────────────────────────────

  private mapRow(row: typeof scriptSafetySettings.$inferSelect): ScriptSafetySettings {
    return {
      suppressImportWarnings: row.suppressImportWarnings === 1,
      updatedAt: row.updatedAt,
    };
  }
}
