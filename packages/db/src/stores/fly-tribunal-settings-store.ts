import { asc, eq } from 'drizzle-orm';
import { flyTribunalSettings } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

/**
 * Store-owned version of the Fly Tribunal settings wire shape.
 *
 * It mirrors `flyTribunalSettingsSchema` at the API boundary without importing
 * upward from `@vibe-tavern/db` to sibling package `@vibe-tavern/api-contracts`.
 * The route adapter validates every read and write with that canonical Zod
 * schema; these defaults are the required database-layer twin for a fresh row.
 */
export interface FlyTribunalSettings {
  enabled: boolean;
  reactionTier: 'indication' | 'hint' | 'auto';
  /** Integer in the contract's 1..3 range (validated at the API boundary). */
  regenCap: number;
  sensitivity: 'soft' | 'normal' | 'strict';
  autoSwipeConfidence: 'normal' | 'high' | 'very-high';
  trainingEnabled: boolean;
  trainingSpeed: 'slow' | 'normal' | 'fast';
  /** Null = infinity (no decay). */
  precedentLifetimeDays: 7 | 14 | 30 | null;
  hints: string[];
  memoryScope: 'chat' | 'global';
  updatedAt: string;
}

export type FlyTribunalSettingsPutData = Omit<FlyTribunalSettings, 'updatedAt'>;

/**
 * Fresh-install defaults. They deliberately match the lower-layer contract's
 * `.default()` values; db cannot import the sibling api-contracts package.
 */
export const DEFAULT_FLY_TRIBUNAL_SETTINGS: FlyTribunalSettingsPutData = {
  enabled: false,
  reactionTier: 'indication',
  regenCap: 2,
  sensitivity: 'normal',
  autoSwipeConfidence: 'high',
  trainingEnabled: true,
  trainingSpeed: 'normal',
  precedentLifetimeDays: 14,
  hints: [],
  memoryScope: 'chat',
};

/**
 * Typed singleton persistence for Fly Tribunal's feature settings (FT-4).
 *
 * The table has no user-controlled identity: a select-first read decides
 * update versus insert, so normal store use never grows a second row. The
 * route adapter supplies an already-valid full replacement payload.
 */
export class FlyTribunalSettingsStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  /** Return persisted settings or the fresh-install contract defaults. */
  async get(): Promise<FlyTribunalSettings> {
    const row = await this.findRow();
    return row ? this.mapRow(row) : { ...DEFAULT_FLY_TRIBUNAL_SETTINGS, updatedAt: '' };
  }

  /** Full replacement. A second write updates the singleton rather than inserts. */
  async put(data: FlyTribunalSettingsPutData): Promise<FlyTribunalSettings> {
    const existing = await this.findRow();
    const now = this.clock.now();
    const values = {
      enabled: data.enabled,
      reactionTier: data.reactionTier,
      regenCap: data.regenCap,
      sensitivity: data.sensitivity,
      autoSwipeConfidence: data.autoSwipeConfidence,
      trainingEnabled: data.trainingEnabled,
      trainingSpeed: data.trainingSpeed,
      precedentLifetimeDays: data.precedentLifetimeDays,
      hintsJson: JSON.stringify(data.hints),
      memoryScope: data.memoryScope,
      updatedAt: now,
    };

    if (existing) {
      const [row] = await this.db
        .update(flyTribunalSettings)
        .set(values)
        .where(eq(flyTribunalSettings.id, existing.id))
        .returning();
      if (!row) throw new Error(`Fly Tribunal settings ${existing.id} disappeared during update`);
      return this.mapRow(row);
    }

    const [row] = await this.db
      .insert(flyTribunalSettings)
      .values({ id: this.idGen.next('flyset'), ...values })
      .returning();
    if (!row) throw new Error('Fly Tribunal settings insert returned no row');
    return this.mapRow(row);
  }

  private async findRow() {
    return this.db
      .select()
      .from(flyTribunalSettings)
      .orderBy(asc(flyTribunalSettings.id))
      .get();
  }

  private mapRow(row: typeof flyTribunalSettings.$inferSelect): FlyTribunalSettings {
    return {
      enabled: row.enabled,
      reactionTier: row.reactionTier as FlyTribunalSettings['reactionTier'],
      regenCap: row.regenCap,
      sensitivity: row.sensitivity as FlyTribunalSettings['sensitivity'],
      autoSwipeConfidence: row.autoSwipeConfidence as FlyTribunalSettings['autoSwipeConfidence'],
      trainingEnabled: row.trainingEnabled,
      trainingSpeed: row.trainingSpeed as FlyTribunalSettings['trainingSpeed'],
      precedentLifetimeDays: row.precedentLifetimeDays as FlyTribunalSettings['precedentLifetimeDays'],
      hints: parseHints(row.hintsJson),
      memoryScope: row.memoryScope as FlyTribunalSettings['memoryScope'],
      updatedAt: row.updatedAt,
    };
  }
}

function parseHints(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
}
