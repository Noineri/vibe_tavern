import { eq, and } from 'drizzle-orm';
import { chatAgentSettings } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock } from '../persistence.js';

// ─── Return type ──────────────────────────────────────────────────────────────

/**
 * One (chat, agent-kind) pair's settings (SIDECHAT_PLAN SC-0f): the chat's OWN
 * copilot-profile choice for that kind's threads in that chat. Structurally
 * identical to the api-contracts wire shape; the adapter maps field-for-field
 * (db does not depend on api-contracts). `updatedAt` is `null` when the pair
 * has no row yet — unlike the kind-level twin (agent-kind-settings-store.ts,
 * whose no-row read falls back to the legacy `ui_settings` row and its
 * timestamp), a chat row has NO legacy source, so "never written" stays null.
 */
export interface ChatAgentSettings {
  chatId: string;
  agentKind: string;
  profileId: string | null;
  updatedAt: string | null;
}

// ─── Input type ───────────────────────────────────────────────────────────────

/**
 * Partial patch for one (chat, kind) pair: only the fields present are written
 * (absent keeps the stored value, `null` clears it). `profileId` follows the
 * house dangling-id policy — it is stored verbatim with no FK and no
 * existence check; a deleted profile row makes the id dangle and the RESOLVER
 * falls through at read time (never a blocked delete, never a write error).
 */
export interface ChatAgentSettingsUpdate {
  profileId?: string | null;
}

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Per-(chat, agent-kind) settings (SC-0f) — one row per (chat_id, agent_kind)
 * pair, PK on the pair. The chat-scoped twin of `AgentKindSettingsStore`: no
 * legacy fallback exists for chat rows (the pre-kinds legacy pair lived on
 * `ui_settings`, a global — never per chat), so a missing row reads as
 * `profileId: null` and the stream's profile chain falls to the kind default.
 */
export class ChatAgentSettingsStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;

  constructor(db: AppDb, options?: { clock?: StoreClock }) {
    this.db = db;
    this.clock = resolveStoreRuntime(options).clock;
  }

  // ─── Read operations ───────────────────────────────────────────────────────

  /** The pair's row, or `profileId: null` / `updatedAt: null` when the pair
   *  has never been written. */
  async get(chatId: string, agentKind: string): Promise<ChatAgentSettings> {
    const row = await this.db
      .select()
      .from(chatAgentSettings)
      .where(and(eq(chatAgentSettings.chatId, chatId), eq(chatAgentSettings.agentKind, agentKind)))
      .get();
    return row ? this.mapRow(row) : { chatId, agentKind, profileId: null, updatedAt: null };
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  /** Upsert ONE (chat, kind) pair's row: fields present in `update` are
   *  written, absent fields keep their stored value. There is no first-insert
   *  seeding (the kind-level twin seeds its pair columns from the legacy
   *  `ui_settings` choice; a chat row has no legacy source to seed from). */
  async patch(chatId: string, agentKind: string, update: ChatAgentSettingsUpdate): Promise<ChatAgentSettings> {
    const now = this.clock.now();
    const insert: Omit<typeof chatAgentSettings.$inferInsert, 'chatId' | 'agentKind'> = {
      updatedAt: now,
    };
    const conflictSet: Partial<typeof chatAgentSettings.$inferInsert> = {
      updatedAt: now,
    };
    if (update.profileId !== undefined) {
      insert.profileId = update.profileId;
      conflictSet.profileId = update.profileId;
    }
    const [row] = await this.db
      .insert(chatAgentSettings)
      .values({ chatId, agentKind, ...insert })
      .onConflictDoUpdate({
        target: [chatAgentSettings.chatId, chatAgentSettings.agentKind],
        set: conflictSet,
      })
      .returning();
    return this.mapRow(row!);
  }

  // ─── Row mapper ────────────────────────────────────────────────────────────

  private mapRow(row: typeof chatAgentSettings.$inferSelect): ChatAgentSettings {
    return {
      chatId: row.chatId,
      agentKind: row.agentKind,
      profileId: row.profileId ?? null,
      updatedAt: row.updatedAt,
    };
  }
}
