import {
  DEFAULT_BALANCE_PROVIDER_QUOTA_CONFIG,
  DEFAULT_LOW_QUOTA_REMAINING_PERCENT,
  DEFAULT_NONE_PROVIDER_QUOTA_CONFIG,
  DEFAULT_QUOTA_POLL_INTERVAL_MINUTES,
  DEFAULT_WINDOWED_PROVIDER_QUOTA_CONFIG,
  PROVIDER_QUOTA_KIND,
  type ProviderQuotaConfig,
  type ProviderQuotaErrorKind,
  type ProviderQuotaEvent,
  type ProviderQuotaSnapshot,
  type QuotaTransitionState,
} from '@vibe-tavern/domain';
import { eq } from 'drizzle-orm';
import type { AppDb } from '../db-connection.js';
import { providerQuotaEvents, providerQuotaSettings, providerQuotaSnapshots } from '../db-schema.js';
import { resolveStoreRuntime, type StoreClock, type StoreRuntimeOptions } from '../persistence.js';

/** Persisted quota toggles for one provider profile. */
export interface QuotaSettingsRecord {
  providerProfileId: string;
  config: ProviderQuotaConfig;
  createdAt: string;
  updatedAt: string;
}

/** Latest poll result for one provider profile. */
export interface QuotaSnapshotRecord {
  providerProfileId: string;
  /** Null until the first successful poll. */
  snapshot: ProviderQuotaSnapshot | null;
  /** Null for balance/none profiles and before the first windowed poll. */
  transitionState: QuotaTransitionState | null;
  /** Null when the last poll succeeded. */
  lastError: ProviderQuotaErrorKind | null;
  updatedAt: string;
}

export interface UpsertQuotaSnapshotData {
  snapshot: ProviderQuotaSnapshot | null;
  transitionState: QuotaTransitionState | null;
  lastError: ProviderQuotaErrorKind | null;
}

/**
 * Quota persistence: the user's toggles, the latest normalized snapshot plus the
 * transition state machine's memory, and the ledger of already-notified events.
 *
 * The event ledger is the restart-dedupe: its PK is the deterministic event id,
 * so replaying an unchanged situation conflicts instead of re-notifying. All
 * three tables cascade off `provider_profiles`, so deleting a profile is the
 * only teardown needed.
 *
 * Raw vendor payloads are never written here — only the normalized model.
 */
export class QuotaStore {
  private readonly clock: StoreClock;

  constructor(private readonly db: AppDb, options: StoreRuntimeOptions = {}) {
    this.clock = resolveStoreRuntime(options).clock;
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  private mapSettingsRow(row: typeof providerQuotaSettings.$inferSelect): QuotaSettingsRecord {
    return {
      providerProfileId: row.providerProfileId,
      config: mapConfig(row),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Toggles for one profile, or `null` when the user never touched them (kind defaults apply). */
  async getSettings(providerProfileId: string): Promise<QuotaSettingsRecord | null> {
    const row = await this.db
      .select()
      .from(providerQuotaSettings)
      .where(eq(providerQuotaSettings.providerProfileId, providerProfileId))
      .get();
    return row ? this.mapSettingsRow(row) : null;
  }

  /** Every persisted settings row — the poller's startup scan. */
  async listSettings(): Promise<QuotaSettingsRecord[]> {
    const rows = await this.db.select().from(providerQuotaSettings).all();
    return rows.map((row) => this.mapSettingsRow(row));
  }

  /**
   * Write the toggles. Columns that do not exist for the config's kind are reset
   * to NULL, so a windowed→balance switch cannot leave a stale threshold behind.
   */
  async upsertSettings(providerProfileId: string, config: ProviderQuotaConfig): Promise<QuotaSettingsRecord> {
    const now = this.clock.now();
    const columns = configToColumns(config);
    const [row] = await this.db
      .insert(providerQuotaSettings)
      .values({ providerProfileId, ...columns, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: providerQuotaSettings.providerProfileId,
        set: { ...columns, updatedAt: now },
      })
      .returning();
    return this.mapSettingsRow(row!);
  }

  async deleteSettings(providerProfileId: string): Promise<void> {
    await this.db
      .delete(providerQuotaSettings)
      .where(eq(providerQuotaSettings.providerProfileId, providerProfileId))
      .run();
  }

  // ─── Snapshot + transition state ──────────────────────────────────────────

  private mapSnapshotRow(row: typeof providerQuotaSnapshots.$inferSelect): QuotaSnapshotRecord {
    return {
      providerProfileId: row.providerProfileId,
      snapshot: row.snapshotJson ?? null,
      transitionState: row.transitionStateJson ?? null,
      lastError: row.lastError ?? null,
      updatedAt: row.updatedAt,
    };
  }

  async getSnapshot(providerProfileId: string): Promise<QuotaSnapshotRecord | null> {
    const row = await this.db
      .select()
      .from(providerQuotaSnapshots)
      .where(eq(providerQuotaSnapshots.providerProfileId, providerProfileId))
      .get();
    return row ? this.mapSnapshotRow(row) : null;
  }

  /** Replace the whole row — snapshot, transition state and error are one atomic poll result. */
  async upsertSnapshot(providerProfileId: string, data: UpsertQuotaSnapshotData): Promise<QuotaSnapshotRecord> {
    const now = this.clock.now();
    const columns = {
      snapshotJson: data.snapshot,
      transitionStateJson: data.transitionState,
      lastError: data.lastError,
    };
    const [row] = await this.db
      .insert(providerQuotaSnapshots)
      .values({ providerProfileId, ...columns, updatedAt: now })
      .onConflictDoUpdate({
        target: providerQuotaSnapshots.providerProfileId,
        set: { ...columns, updatedAt: now },
      })
      .returning();
    return this.mapSnapshotRow(row!);
  }

  /** Drop the snapshot outright (API-key rotation — the old account's numbers are meaningless). */
  async deleteSnapshot(providerProfileId: string): Promise<void> {
    await this.db
      .delete(providerQuotaSnapshots)
      .where(eq(providerQuotaSnapshots.providerProfileId, providerProfileId))
      .run();
  }

  // ─── Event ledger ─────────────────────────────────────────────────────────

  /**
   * Record a notification. Returns `false` when this exact event id was already
   * recorded — the caller must NOT put it on the bus again. That is the entire
   * restart-dedupe contract.
   */
  async recordEvent(event: ProviderQuotaEvent): Promise<boolean> {
    const inserted = await this.db
      .insert(providerQuotaEvents)
      .values({
        eventId: event.eventId,
        providerProfileId: event.providerProfileId,
        kind: event.kind,
        payloadJson: event,
        createdAt: this.clock.now(),
      })
      .onConflictDoNothing({ target: providerQuotaEvents.eventId })
      .returning();
    return inserted.length > 0;
  }

  async listEvents(providerProfileId: string): Promise<ProviderQuotaEvent[]> {
    const rows = await this.db
      .select()
      .from(providerQuotaEvents)
      .where(eq(providerQuotaEvents.providerProfileId, providerProfileId))
      .all();
    return rows.map((row) => row.payloadJson);
  }

  /** Forget a profile's notification history so a rebaseline can re-notify legitimately. */
  async deleteEvents(providerProfileId: string): Promise<void> {
    await this.db
      .delete(providerQuotaEvents)
      .where(eq(providerQuotaEvents.providerProfileId, providerProfileId))
      .run();
  }
}

// ─── Row ↔ config mapping ───────────────────────────────────────────────────

type SettingsColumns = Pick<
  typeof providerQuotaSettings.$inferInsert,
  | 'configKind'
  | 'displayEnabled'
  | 'lowQuotaEnabled'
  | 'lowQuotaRemainingPercent'
  | 'resetNotifyEnabled'
  | 'pollIntervalMinutes'
>;

function configToColumns(config: ProviderQuotaConfig): SettingsColumns {
  if (config.kind === PROVIDER_QUOTA_KIND.windowed) {
    return {
      configKind: config.kind,
      displayEnabled: config.displayEnabled,
      lowQuotaEnabled: config.lowQuotaEnabled,
      lowQuotaRemainingPercent: config.lowQuotaRemainingPercent,
      resetNotifyEnabled: config.resetNotifyEnabled,
      pollIntervalMinutes: config.pollIntervalMinutes,
    };
  }
  if (config.kind === PROVIDER_QUOTA_KIND.balance) {
    return {
      configKind: config.kind,
      displayEnabled: config.displayEnabled,
      lowQuotaEnabled: null,
      lowQuotaRemainingPercent: null,
      resetNotifyEnabled: null,
      pollIntervalMinutes: config.pollIntervalMinutes,
    };
  }
  return {
    configKind: config.kind,
    displayEnabled: false,
    lowQuotaEnabled: null,
    lowQuotaRemainingPercent: null,
    resetNotifyEnabled: null,
    pollIntervalMinutes: null,
  };
}

/**
 * Columns for a kind that does not own them are NULL by construction, but a row
 * written before a schema/capability change can still disagree — fall back to
 * the kind's defaults rather than inventing a half-populated config.
 */
function mapConfig(row: typeof providerQuotaSettings.$inferSelect): ProviderQuotaConfig {
  if (row.configKind === PROVIDER_QUOTA_KIND.windowed) {
    return {
      kind: PROVIDER_QUOTA_KIND.windowed,
      displayEnabled: row.displayEnabled,
      lowQuotaEnabled: row.lowQuotaEnabled ?? DEFAULT_WINDOWED_PROVIDER_QUOTA_CONFIG.lowQuotaEnabled,
      lowQuotaRemainingPercent: row.lowQuotaRemainingPercent ?? DEFAULT_LOW_QUOTA_REMAINING_PERCENT,
      resetNotifyEnabled: row.resetNotifyEnabled ?? DEFAULT_WINDOWED_PROVIDER_QUOTA_CONFIG.resetNotifyEnabled,
      pollIntervalMinutes: row.pollIntervalMinutes ?? DEFAULT_QUOTA_POLL_INTERVAL_MINUTES,
    };
  }
  if (row.configKind === PROVIDER_QUOTA_KIND.balance) {
    return {
      kind: PROVIDER_QUOTA_KIND.balance,
      displayEnabled: row.displayEnabled,
      pollIntervalMinutes: row.pollIntervalMinutes ?? DEFAULT_QUOTA_POLL_INTERVAL_MINUTES,
    };
  }
  return DEFAULT_NONE_PROVIDER_QUOTA_CONFIG;
}

/** Kind-appropriate config for a profile with no persisted row yet. */
export function defaultQuotaConfigForKind(kind: ProviderQuotaConfig['kind']): ProviderQuotaConfig {
  if (kind === PROVIDER_QUOTA_KIND.windowed) return DEFAULT_WINDOWED_PROVIDER_QUOTA_CONFIG;
  if (kind === PROVIDER_QUOTA_KIND.balance) return DEFAULT_BALANCE_PROVIDER_QUOTA_CONFIG;
  return DEFAULT_NONE_PROVIDER_QUOTA_CONFIG;
}
