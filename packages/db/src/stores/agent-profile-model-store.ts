import { and, eq } from 'drizzle-orm';
import { agentProfileModels } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock } from '../persistence.js';

// ─── Row shape ────────────────────────────────────────────────────────────────

/**
 * One stored own-model row (DIRECTOR_MODE_PLAN DR-2 / M1): the model a
 * profile's turns run on when set; an absent row is same as sidechat (the
 * existing kind chain). Structurally a superset of the
 * server-side binding the stream consumes (`AgentOwnModelBinding`), which is
 * why the adapter's wiring returns it as-is. `modelName === null` means "the
 * provider's default model" — resolved at turn time, never stored.
 */
export interface AgentProfileModel {
  agentKind: string;
  profileId: string;
  providerProfileId: string;
  modelName: string | null;
  updatedAt: string;
}

// ─── Input type ───────────────────────────────────────────────────────────────

/**
 * Set/replace one profile's own model. `providerProfileId` is required (an
 * own model without a provider is meaningless); `modelName` absent or `null`
 * pins the provider's default model. A whole-row replace, not a merge — the
 * API surface is PUT-shaped (set) and DELETE-shaped (clear), never PATCH.
 */
export interface AgentProfileModelSetInput {
  providerProfileId: string;
  modelName?: string | null;
}

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Per-(agent kind, profile) own-model persistence (DR-2/M1). The kind rides
 * the key because built-in seed ids are kind-scoped code seeds with no rows —
 * a user profile's id also only ever appears under its OWN kind (the adapter
 * validates the (kind, id) pair resolves before writing). Neither column is
 * FK-enforced: provider ids dangle by policy (the stream falls through to the
 * request's pair), and profile rows are deleted through the adapter's cascade
 * (`deleteForProfile`), not the database's.
 */
export class AgentProfileModelStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;

  constructor(db: AppDb, options?: { clock?: StoreClock }) {
    this.db = db;
    this.clock = resolveStoreRuntime(options).clock;
  }

  /** The (kind, profile) row, or null — null IS same-as-sidechat (no own model), not an error. */
  async get(kind: string, profileId: string): Promise<AgentProfileModel | null> {
    const row = await this.db
      .select()
      .from(agentProfileModels)
      .where(and(eq(agentProfileModels.agentKind, kind), eq(agentProfileModels.profileId, profileId)))
      .get();
    return row ? this.mapRow(row) : null;
  }

  /** Insert or replace the (kind, profile) row — the whole binding, not a merge. */
  async set(kind: string, profileId: string, input: AgentProfileModelSetInput): Promise<AgentProfileModel> {
    const values = {
      providerProfileId: input.providerProfileId,
      modelName: input.modelName ?? null,
      updatedAt: this.clock.now(),
    };
    const [row] = await this.db
      .insert(agentProfileModels)
      .values({ agentKind: kind, profileId, ...values })
      .onConflictDoUpdate({
        target: [agentProfileModels.agentKind, agentProfileModels.profileId],
        set: values,
      })
      .returning();
    return this.mapRow(row!);
  }

  /** Remove the (kind, profile) row (back to same as sidechat). Idempotent. */
  async clear(kind: string, profileId: string): Promise<void> {
    await this.db
      .delete(agentProfileModels)
      .where(and(eq(agentProfileModels.agentKind, kind), eq(agentProfileModels.profileId, profileId)))
      .run();
  }

  /**
   * Remove every row keyed by a profile id regardless of kind — the
   * user-profile DELETE cascade (a user id exists under exactly one kind, so
   * this deletes at most one row; scanning by id alone keeps the cascade
   * total even if a row was somehow written under a foreign kind). Idempotent;
   * never called for built-in ids (their deletes are rejected upstream).
   */
  async deleteForProfile(profileId: string): Promise<void> {
    await this.db.delete(agentProfileModels)
      .where(eq(agentProfileModels.profileId, profileId))
      .run();
  }

  private mapRow(row: typeof agentProfileModels.$inferSelect): AgentProfileModel {
    return {
      agentKind: row.agentKind,
      profileId: row.profileId,
      providerProfileId: row.providerProfileId,
      modelName: row.modelName ?? null,
      updatedAt: row.updatedAt,
    };
  }
}
