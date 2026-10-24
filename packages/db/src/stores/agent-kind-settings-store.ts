import { eq } from 'drizzle-orm';
import { agentKindSettings } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock } from '../persistence.js';
import { UiSettingsStore } from './ui-settings-store.js';

// ─── Return type ──────────────────────────────────────────────────────────────

/**
 * One agent kind's EFFECTIVE settings (SIDECHAT_PLAN SC-0d): the kind's own
 * row when it has one, otherwise — for a kind that inherits the legacy pair
 * (see {@link ReadOptions.inheritLegacyPair}) — the legacy `ui_settings`
 * copilot pair projected through the same shape (see
 * {@link AgentKindSettingsStore.get}). Structurally identical to the
 * api-contracts wire shape; the adapter maps field-for-field (db does not
 * depend on api-contracts).
 */
export interface AgentKindSettings {
  agentKind: string;
  providerProfileId: string | null;
  modelName: string | null;
  defaultProfileId: string | null;
  /** The kind's default for the auto-compact toggle on NEW sessions (AP-20):
   *  the stored 0/1 column with NULL resolved to ON — auto-compact was the
   *  pre-AP-20 effective behavior, so an absent setting must not change it.
   *  NOT part of the legacy ui_settings pair (that fallback is provider/model
   *  only), so every no-row read is ON alike. */
  autoCompactDefault: boolean;
  /** The row's `updated_at`, or the legacy ui_settings row's when the legacy
   *  fallback applied — `null` when there is neither a row nor a fallback
   *  (a kind that does not inherit and has nothing stored; the SC-0f
   *  chat-settings twin's no-row shape). */
  updatedAt: string | null;
}

// ─── Input type ───────────────────────────────────────────────────────────────

/**
 * Partial patch for one kind: only the fields present are written (absent
 * keeps the stored value, `null` clears it). On the FIRST insert for a kind
 * that inherits the legacy pair ({@link ReadOptions.inheritLegacyPair}) the
 * provider/model columns seed from the legacy `ui_settings` copilot pair
 * (owner decision 2: nobody loses their choice) unless the patch itself
 * carries them; every other kind's first insert seeds nothing.
 */
export interface AgentKindSettingsUpdate {
  providerProfileId?: string | null;
  modelName?: string | null;
  defaultProfileId?: string | null;
  /** Present → writes 0/1; absent keeps the stored value. No `null` form —
   *  "clear to unset" is indistinguishable from ON (NULL = on), so the
   *  boolean is the whole patch vocabulary (AP-20). */
  autoCompactDefault?: boolean;
}

/**
 * Per-call read/seed options. `inheritLegacyPair` says whether THIS kind
 * falls back to the legacy `ui_settings` copilot pair when it has no row
 * (read-time) and seeds its first insert from it (SC-7, owner decision 2
 * corrected 2026-10-19): only the two pre-split kinds (`experience`,
 * `script`) do. The FACT lives on the backend `AgentKind` descriptor
 * (`inheritsLegacyCopilotPair` — services/api); `packages/db` cannot import
 * it across the dependency graph, so the services/api callers populate this
 * option from the descriptor per call. Defaults to `false` — the semantics
 * of every kind registered after the split.
 */
export interface ReadOptions {
  inheritLegacyPair?: boolean;
}

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Per-agent-kind settings (SC-0d) — one row per kind id.
 *
 * The legacy fallback is READ-TIME, never a seed SQL on upgrade, and applies
 * ONLY to kinds that inherit it ({@link ReadOptions.inheritLegacyPair} —
 * `experience` and `script`, the two pre-split kinds; SC-7): `get` on such a
 * kind with no row returns the current `ui_settings.copilot_provider_id` /
 * `copilot_model_name` pair (owner decision 2 — a user who chose a model
 * before kinds existed keeps seeing it), and `patch`'s first insert seeds
 * the pair columns from it. Every other kind with no row reads nulls and
 * seeds nothing, so its host's `defaultModelBinding` is actually consulted.
 * The ui_settings row is read through the {@link UiSettingsStore} so the
 * "missing row → defaults" projection lives in exactly one store per table.
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

  /** The kind's row; when the kind has no row yet: the legacy
   *  `ui_settings` copilot pair (`default_profile_id: null` — the legacy pair
   *  never carried one) with the ui_settings row's `updated_at` for a kind
   *  that inherits it, all-null fields (`updatedAt: null` alike) for one that
   *  does not. */
  async get(kind: string, options?: ReadOptions): Promise<AgentKindSettings> {
    const row = await this.db
      .select()
      .from(agentKindSettings)
      .where(eq(agentKindSettings.agentKind, kind))
      .get();
    if (row) return this.mapRow(row);
    if (options?.inheritLegacyPair !== true) {
      return {
        agentKind: kind,
        providerProfileId: null,
        modelName: null,
        defaultProfileId: null,
        autoCompactDefault: true,
        updatedAt: null,
      };
    }
    const legacy = await this.uiSettings.get();
    return {
      agentKind: kind,
      providerProfileId: legacy.copilotProviderId,
      modelName: legacy.copilotModelName,
      defaultProfileId: null,
      // The legacy pair never carried an auto-compact default either — a
      // kind without a row reads ON regardless of inheritance (AP-20).
      autoCompactDefault: true,
      updatedAt: legacy.updatedAt,
    };
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  /** Upsert ONE kind's row (SC-0d): fields present in `update` are written,
   *  absent fields keep their stored value. For a kind that inherits the
   *  legacy pair, the first insert seeds the provider/model columns from it
   * so a partial first PATCH (e.g. a future `default_profile_id` write)
   * never silently drops the user's pre-kinds model choice; every other
   *  kind's first insert seeds nothing (absent pair columns insert NULL). */
  async patch(kind: string, update: AgentKindSettingsUpdate, options?: ReadOptions): Promise<AgentKindSettings> {
    const inheritLegacyPair = options?.inheritLegacyPair === true;
    const legacy = inheritLegacyPair ? await this.uiSettings.get() : null;
    const now = this.clock.now();
    // Two distinct column sets: the INSERT seeds absent pair columns from the
    // legacy choice (first-touch row — only for an inheriting kind), while the
    // conflict UPDATE writes ONLY the fields the patch carries — seeding there
    // would clobber the row's stored values on every partial patch.
    const insert: Omit<typeof agentKindSettings.$inferInsert, 'agentKind'> = {
      updatedAt: now,
    };
    const conflictSet: Partial<typeof agentKindSettings.$inferInsert> = {
      updatedAt: now,
    };
    if (update.providerProfileId !== undefined) {
      insert.providerProfileId = update.providerProfileId;
      conflictSet.providerProfileId = update.providerProfileId;
    } else if (legacy !== null) {
      insert.providerProfileId = legacy.copilotProviderId;
    }
    if (update.modelName !== undefined) {
      insert.modelName = update.modelName;
      conflictSet.modelName = update.modelName;
    } else if (legacy !== null) {
      insert.modelName = legacy.copilotModelName;
    }
    if (update.defaultProfileId !== undefined) {
      insert.defaultProfileId = update.defaultProfileId;
      conflictSet.defaultProfileId = update.defaultProfileId;
    }
    // AP-20: the auto-compact default is NOT part of the legacy pair — an
    // absent field inserts NULL (reads back ON), never a legacy seed.
    if (update.autoCompactDefault !== undefined) {
      insert.autoCompactDefault = update.autoCompactDefault ? 1 : 0;
      conflictSet.autoCompactDefault = update.autoCompactDefault ? 1 : 0;
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
      // NULL = on (AP-20): a row written before the column existed — or a
      // partial patch that never named it — reads ON, the pre-AP-20 behavior.
      autoCompactDefault: (row.autoCompactDefault ?? 1) === 1,
      updatedAt: row.updatedAt,
    };
  }
}
