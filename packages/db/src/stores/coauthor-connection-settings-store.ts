import type { ModelSettingsOverlay } from '@vibe-tavern/domain';
import { eq } from 'drizzle-orm';
import type { AppDb } from '../db-connection.js';
import { coauthorConnectionSettings } from '../db-schema.js';
import { resolveStoreRuntime, type StoreClock, type StoreRuntimeOptions } from '../persistence.js';

/**
 * Store-level Co-Author connection settings — one row per provider profile
 * (COAUTHOR_OWN_GENERATION_SETTINGS_PLAN CG-1). `settings` is the parsed
 * `ModelSettingsOverlay` field set as stored: complete when written through the
 * API; the CG-1 seed row may carry only the legacy global overrides —
 * `resolveCoauthorGenerationSettings` (@vibe-tavern/domain) is the ONE place
 * that completes a partial set with the Co-Author defaults.
 */
export interface CoauthorConnectionSettingsRow {
  providerProfileId: string;
  modelName: string | null;
  settings: ModelSettingsOverlay;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertCoauthorConnectionSettingsData {
  modelName: string | null;
  settings: ModelSettingsOverlay;
}

/**
 * Persistence for the per-connection Co-Author generation set. Mirrors the
 * QuotaStore shape (PK = provider_profile_id, upsert via onConflictDoUpdate);
 * the provider-model-settings overlay store is the partial-inherit sibling —
 * this table never inherits, so there is no delete-to-revert verb here (the
 * row is replaced wholesale or dropped with the profile).
 */
export class CoauthorConnectionSettingsStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;

  constructor(db: AppDb, options: StoreRuntimeOptions = {}) {
    this.db = db;
    this.clock = resolveStoreRuntime(options).clock;
  }

  /** The connection's saved set, or `null` when it has none yet (defaults apply). */
  async getByProviderId(providerProfileId: string): Promise<CoauthorConnectionSettingsRow | null> {
    const row = await this.db
      .select()
      .from(coauthorConnectionSettings)
      .where(eq(coauthorConnectionSettings.providerProfileId, providerProfileId))
      .get();
    return row ? this.mapRow(row) : null;
  }

  /** Every saved set (join fodder for future consumers; order is PK-stable). */
  async list(): Promise<CoauthorConnectionSettingsRow[]> {
    const rows = await this.db.select().from(coauthorConnectionSettings).all();
    return rows.map((row) => this.mapRow(row));
  }

  /** Insert or replace the connection's set. Idempotent on the provider id. */
  async upsert(
    providerProfileId: string,
    data: UpsertCoauthorConnectionSettingsData,
  ): Promise<CoauthorConnectionSettingsRow> {
    const now = this.clock.now();
    const [row] = await this.db
      .insert(coauthorConnectionSettings)
      .values({
        providerProfileId,
        modelName: data.modelName,
        settingsJson: JSON.stringify(data.settings),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: coauthorConnectionSettings.providerProfileId,
        set: {
          modelName: data.modelName,
          settingsJson: JSON.stringify(data.settings),
          updatedAt: now,
        },
      })
      .returning();
    return this.mapRow(row!);
  }

  private mapRow(row: typeof coauthorConnectionSettings.$inferSelect): CoauthorConnectionSettingsRow {
    return {
      providerProfileId: row.providerProfileId,
      modelName: row.modelName,
      settings: parseSettingsJson(row.settingsJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

/** Parse a stored settingsJson row. Returns `{}` (empty set — the domain
 *  resolver fills every default) on missing/invalid JSON, mirroring the
 *  provider-model-settings parse boundary. */
function parseSettingsJson(value: string): ModelSettingsOverlay {
  try {
    const parsed: unknown = JSON.parse(value);
    return (parsed && typeof parsed === 'object' ? parsed : {}) as ModelSettingsOverlay;
  } catch {
    return {};
  }
}
