import { eq } from 'drizzle-orm';
import { agentKindSettings } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock } from '../persistence.js';
import { UiSettingsStore } from './ui-settings-store.js';

// ─── Return type ──────────────────────────────────────────────────────────────

/**
 * One agent kind's EFFECTIVE settings (SIDECHAT_PLAN SC-0d): the kind's own
 * row when it has one, otherwise the legacy `ui_settings` copilot pair
 * projected through the same shape (see {@link AgentKindSettingsStore.get}).
 * Structurally identical to the api-contracts wire shape; the adapter maps
 * field-for-field (db does not depend on api-contracts).
 */
export interface AgentKindSettings {
  agentKind: string;
  providerProfileId: string | null;
  modelName: string | null;
  defaultProfileId: string | null;
  updatedAt: string;
}

// ─── Input type ───────────────────────────────────────────────────────────────

/**
 * Partial patch for one kind: only the fields present are written (absent
 * keeps the stored value, `null` clears it). On the FIRST insert for a kind
 * the provider/model columns seed from the legacy `ui_settings` copilot pair
 * (owner decision 2: nobody loses their choice) unless the patch itself
 * carries them.
 */
export interface AgentKindSettingsUpdate {
  providerProfileId?: string | null;
  modelName?: string | null;
  defaultProfileId?: string | null;
}

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Per-agent-kind settings (SC-0d) — one row per kind id.
 *
 * The legacy fallback is READ-TIME, never a seed: `get` on a kind with no row
 * returns the current `ui_settings.copilot_provider_id` / `copilot_model_name`
 * pair (owner decision 2 — a user who chose a model before kinds existed keeps
 * seeing it; no seed SQL writes rows on upgrade). The ui_settings row is read
 * through the {@link UiSettingsStore} so the "missing row → defaults"
 * projection lives in exactly one store per table.
 */
export class AgentKindSettingsStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly uiSettings: UiSettingsStore;

  constructor(db: AppDb, options?: { clock?: StoreClock; uiSettings?: UiSettingsStore }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.uiSettings = options?.uiSettings ?? new UiSettingsStore(db);
  }

  // ─── Read operations ───────────────────────────────────────────────────────

  /** The kind's row; when the kind has no row yet, the legacy
   *  `ui_settings` copilot pair (`default_profile_id: null` — the legacy pair
   *  never carried one) with the ui_settings row's `updated_at`. */
  async get(kind: string): Promise<AgentKindSettings> {
    const row = await this.db
      .select()
      .from(agentKindSettings)
      .where(eq(agentKindSettings.agentKind, kind))
      .get();
    if (row) return this.mapRow(row);
    const legacy = await this.uiSettings.get();
    return {
      agentKind: kind,
      providerProfileId: legacy.copilotProviderId,
      modelName: legacy.copilotModelName,
      defaultProfileId: null,
      updatedAt: legacy.updatedAt,
    };
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  /** Upsert ONE kind's row (SC-0d): fields present in `update` are written,
   *  absent fields keep their stored value. The first insert for a kind seeds
   *  the provider/model columns from the legacy pair so a partial first PATCH
   *  (e.g. a future `default_profile_id` write) never silently drops the
   *  user's pre-kinds model choice. */
  async patch(kind: string, update: AgentKindSettingsUpdate): Promise<AgentKindSettings> {
    const legacy = await this.uiSettings.get();
    const now = this.clock.now();
    // Two distinct column sets: the INSERT seeds absent pair columns from the
    // legacy choice (first-touch row), while the conflict UPDATE writes ONLY
    // the fields the patch carries — seeding there would clobber the row's
    // stored values on every partial patch.
    const insert: Omit<typeof agentKindSettings.$inferInsert, 'agentKind'> = {
      updatedAt: now,
    };
    const conflictSet: Partial<typeof agentKindSettings.$inferInsert> = {
      updatedAt: now,
    };
    if (update.providerProfileId !== undefined) {
      insert.providerProfileId = update.providerProfileId;
      conflictSet.providerProfileId = update.providerProfileId;
    } else {
      insert.providerProfileId = legacy.copilotProviderId;
    }
    if (update.modelName !== undefined) {
      insert.modelName = update.modelName;
      conflictSet.modelName = update.modelName;
    } else {
      insert.modelName = legacy.copilotModelName;
    }
    if (update.defaultProfileId !== undefined) {
      insert.defaultProfileId = update.defaultProfileId;
      conflictSet.defaultProfileId = update.defaultProfileId;
    }
    const [row] = await this.db
      .insert(agentKindSettings)
      .values({ agentKind: kind, ...insert })
      .onConflictDoUpdate({ target: agentKindSettings.agentKind, set: conflictSet })
      .returning();
    return this.mapRow(row!);
  }

  // ─── Row mapper ────────────────────────────────────────────────────────────

  private mapRow(row: typeof agentKindSettings.$inferSelect): AgentKindSettings {
    return {
      agentKind: row.agentKind,
      providerProfileId: row.providerProfileId ?? null,
      modelName: row.modelName ?? null,
      defaultProfileId: row.defaultProfileId ?? null,
      updatedAt: row.updatedAt,
    };
  }
}
