import { and, eq, isNull, desc } from 'drizzle-orm';
import { experienceCopilotThreads, experienceCopilotMessages } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';
import { brandId, type ExperienceCopilotThreadId, type ExperienceCopilotMessageId } from '@vibe-tavern/domain';

// ─── Input types ──────────────────────────────────────────────────────────────

export interface AppendMessageInput {
  role: string;
  /** Defaults to '' when omitted, mirroring the column default. */
  content?: string;
  /** Serialized tool-call payload (nullable). */
  toolCallsJson?: string | null;
  /** Correlated tool-call id for tool-result messages (nullable). */
  toolCallId?: string | null;
}

// ─── Return types ─────────────────────────────────────────────────────────────

/**
 * Parsed segmented context-usage metrics for a copilot thread (CM-2). Mirrors
 * the `experienceCopilotContextMetricsSchema` wire shape (api-contracts)
 * field-for-field — the db package cannot import api-contracts (dependency
 * direction), so this local structural type is the store's read projection. The
 * stream finish path (services/api) builds the object; this store only
 * serializes it into `context_metrics_json` and parses it back out.
 */
export interface CopilotContextMetrics {
  systemTokens: number;
  /** Tokens of the pinned-context attached block + recency anchor (CX-1,
   *  additive). Rows written before this plan lack the field — the parse guard
   *  defaults a missing value to 0. */
  attachedTokens: number;
  digestTokens: number;
  historyTokens: number;
  totalTokens: number;
  budgetTokens: number;
  reserveTokens: number;
  source: "estimate" | "provider";
  measuredAt: string;
}

/**
 * Store-level copilot thread — domain projection of an
 * `experience_copilot_threads` row. `scriptId` is a plain string (a cross-domain
 * soft link, kept unbranded to stay local/minimal per ER-3); the thread's own
 * id and the message's threadId reference ARE branded at the DB edge.
 */
export interface ExperienceCopilotThread {
  id: ExperienceCopilotThreadId;
  scriptId: string | null;
  draftSessionId: string | null;
  title: string;
  /** NULL = the active session for this script_id; non-null ISO = archived. */
  archivedAt: string | null;
  /** Parsed context metrics from the last turn, or null before the first turn
   *  (or when the stored JSON is malformed — logged, never fatal). */
  contextMetrics: CopilotContextMetrics | null;
  /** Pinned-context links (CX-1); `[]` when none pinned or the stored JSON is
   *  malformed (logged, never fatal). */
  contextLinks: CopilotContextLink[];
  /** The model's step-plan (TAG-2); `[]` until the first todo call or when the
   *  stored JSON is malformed (logged, never fatal). */
  todo: CopilotTodoItem[];
  /** The provider/model the thread last used (persisted from the stream finish
   *  path); null before the first turn. */
  lastProviderProfileId: string | null;
  lastModel: string | null;
  /** Auto-compact toggle (default on). */
  autoCompact: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Pinned-context link on a copilot thread (CX-1). Local structural twin of
 *  the api-contracts `experienceCopilotContextLinkSchema` — the db package
 *  cannot import api-contracts (dependency direction), same as
 *  {@link CopilotContextMetrics} above. Links resolve by id at assembly time
 *  (never a content copy). */
export interface CopilotContextLink {
  targetType: 'character' | 'persona' | 'lorebook' | 'script' | 'skill';
  targetId: string;
}

/** A step-plan item on a copilot thread (copilot todo/ask plan, TAG-2). Local
 *  structural twin of the api-contracts `copilotTodoItemSchema` — the db
 *  package cannot import api-contracts (dependency direction), same as
 *  {@link CopilotContextMetrics} above. Statuses mirror the RP objective
 *  tracker so the frontend panel reuses its visual language. */
export interface CopilotTodoItem {
  title: string;
  status: 'pending' | 'active' | 'completed' | 'abandoned';
}

export interface ExperienceCopilotMessage {
  id: ExperienceCopilotMessageId;
  threadId: ExperienceCopilotThreadId;
  role: string;
  content: string;
  toolCallsJson: string | null;
  toolCallId: string | null;
  createdAt: string;
}

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Experience copilot thread + message persistence (EXPERIENCE_EDITOR_REFACTOR_PLAN,
 * ER-3). Owns the at-most-one-active invariant: at most ONE thread with
 * `archived_at IS NULL` per `script_id`. Enforced two ways — a partial unique
 * index in the schema, and the app-level guards here that archive same-`script_id`
 * siblings inside a synchronous transaction (mirroring VersionStore.activateOnly /
 * experience_sessions activeSlot). A synchronous callback is required because
 * drizzle-orm 0.38.4 + bun:sqlite commits at the end of the callback's
 * synchronous prefix; an await inside would let a post-await throw slip past the
 * commit, so the archive-then-insert/clear must stay synchronous.
 */
export class ExperienceCopilotStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  /** The single active thread (archived_at IS NULL) for a script, or null. */
  async getActive(scriptId: string): Promise<ExperienceCopilotThread | null> {
    const row = await this.db
      .select()
      .from(experienceCopilotThreads)
      .where(and(eq(experienceCopilotThreads.scriptId, scriptId), isNull(experienceCopilotThreads.archivedAt)))
      .get();
    return row ? this.mapThread(row) : null;
  }

  /** All messages for a thread, oldest → newest (createdAt asc, then id as a
   *  stable tiebreaker for same-timestamp collisions). The history the copilot
   *  stream (ER-6) reloads each turn. */
  async listMessages(threadId: string): Promise<ExperienceCopilotMessage[]> {
    const rows = await this.db
      .select()
      .from(experienceCopilotMessages)
      .where(eq(experienceCopilotMessages.threadId, threadId))
      .orderBy(experienceCopilotMessages.createdAt, experienceCopilotMessages.id)
      .all();
    return rows.map((r) => this.mapMessage(r));
  }

  /** Fetch one thread by id. */
  async getById(sessionId: string): Promise<ExperienceCopilotThread | null> {
    const row = await this.db
      .select()
      .from(experienceCopilotThreads)
      .where(eq(experienceCopilotThreads.id, sessionId))
      .get();
    return row ? this.mapThread(row) : null;
  }

  /** Active + archived threads for a script, newest first (updatedAt desc, then
   *  createdAt desc as a stable tiebreaker for same-timestamp collisions). */
  async listSessions(scriptId: string): Promise<ExperienceCopilotThread[]> {
    const rows = await this.db
      .select()
      .from(experienceCopilotThreads)
      .where(eq(experienceCopilotThreads.scriptId, scriptId))
      .orderBy(desc(experienceCopilotThreads.updatedAt), desc(experienceCopilotThreads.createdAt))
      .all();
    return rows.map((r) => this.mapThread(r));
  }

  /**
   * "New session": archive the current active thread for this script (if any)
   * and create+return a fresh active one. The archive-then-insert runs inside a
   * single synchronous transaction so two actives can never coexist (the app-
   * level half of the at-most-one-active invariant; the partial unique index is
   * the DB half).
   */
  async startNewSession(scriptId: string, title?: string): Promise<ExperienceCopilotThread> {
    const now = this.clock.now();
    const id = this.idGen.next('expcop_thread');
    this.db.transaction((tx) => {
      tx
        .update(experienceCopilotThreads)
        .set({ archivedAt: now, updatedAt: now })
        .where(and(eq(experienceCopilotThreads.scriptId, scriptId), isNull(experienceCopilotThreads.archivedAt)))
        .run();
      tx
        .insert(experienceCopilotThreads)
        .values({
          id,
          scriptId,
          draftSessionId: null,
          title: title ?? '',
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    });
    const row = await this.db
      .select()
      .from(experienceCopilotThreads)
      .where(eq(experienceCopilotThreads.id, id))
      .get();
    return this.mapThread(row!);
  }

  /**
   * Resume an archived session: archive all siblings sharing its script_id, then
   * mark this thread active (clear archived_at). No-op (returns the thread
   * unchanged) if it is already the active session. Enforces at-most-one-active
   * inside a synchronous transaction when a script_id is present. A draft thread
   * (script_id NULL, exempt from the partial unique index) only clears its own
   * archived_at.
   */
  async activate(sessionId: string): Promise<ExperienceCopilotThread | null> {
    const target = await this.getById(sessionId);
    if (!target) return null;
    if (target.archivedAt === null) return target; // already the active session

    const now = this.clock.now();
    const scriptId = target.scriptId;
    if (scriptId === null) {
      await this.db
        .update(experienceCopilotThreads)
        .set({ archivedAt: null, updatedAt: now })
        .where(eq(experienceCopilotThreads.id, sessionId))
        .run();
    } else {
      this.db.transaction((tx) => {
        tx
          .update(experienceCopilotThreads)
          .set({ archivedAt: now, updatedAt: now })
          .where(and(eq(experienceCopilotThreads.scriptId, scriptId), isNull(experienceCopilotThreads.archivedAt)))
          .run();
        tx
          .update(experienceCopilotThreads)
          .set({ archivedAt: null, updatedAt: now })
          .where(eq(experienceCopilotThreads.id, sessionId))
          .run();
      });
    }
    const row = await this.db
      .select()
      .from(experienceCopilotThreads)
      .where(eq(experienceCopilotThreads.id, sessionId))
      .get();
    return row ? this.mapThread(row) : null;
  }

  /** Archive a single thread (set archived_at). Idempotent — returns the thread
   *  unchanged if it is already archived. Returns null if it does not exist. */
  async archive(sessionId: string): Promise<ExperienceCopilotThread | null> {
    const target = await this.getById(sessionId);
    if (!target) return null;
    if (target.archivedAt !== null) return target; // already archived

    const now = this.clock.now();
    const [row] = await this.db
      .update(experienceCopilotThreads)
      .set({ archivedAt: now, updatedAt: now })
      .where(eq(experienceCopilotThreads.id, sessionId))
      .returning();
    return row ? this.mapThread(row) : null;
  }

  /** Rename a session: set its title (empty = back to the auto-numbered
   *  fallback label) and bump updated_at. Returns null when the thread does
   *  not exist. Renaming does NOT touch archived_at — an archived session can
   *  be renamed in place. */
  async renameSession(sessionId: string, title: string): Promise<ExperienceCopilotThread | null> {
    const now = this.clock.now();
    const [row] = await this.db
      .update(experienceCopilotThreads)
      .set({ title, updatedAt: now })
      .where(eq(experienceCopilotThreads.id, sessionId))
      .returning();
    return row ? this.mapThread(row) : null;
  }

  /**
   * Append a message to a thread and bump the thread's updated_at so it surfaces
   * as the most recently touched session. Returns the inserted message. Both
   * writes run in a synchronous transaction so updated_at always reflects the
   * last appended message (a failure on either rolls both back).
   */
  async appendMessage(threadId: string, input: AppendMessageInput): Promise<ExperienceCopilotMessage> {
    const now = this.clock.now();
    const id = this.idGen.next('expcop_msg');
    this.db.transaction((tx) => {
      tx
        .insert(experienceCopilotMessages)
        .values({
          id,
          threadId,
          role: input.role,
          content: input.content ?? '',
          toolCallsJson: input.toolCallsJson ?? null,
          toolCallId: input.toolCallId ?? null,
          createdAt: now,
        })
        .run();
      tx
        .update(experienceCopilotThreads)
        .set({ updatedAt: now })
        .where(eq(experienceCopilotThreads.id, threadId))
        .run();
    });
    const row = await this.db
      .select()
      .from(experienceCopilotMessages)
      .where(eq(experienceCopilotMessages.id, id))
      .get();
    return this.mapMessage(row!);
  }

  // ─── Context metrics / auto-compact (CM-2) ─────────────────────────────────

  /**
   * Persist the segmented context metrics from the just-finished turn, plus the
   * provider/model that produced them (the compaction service reuses this pair
   * when the manual compact endpoint omits one — CM-5). Bumps updated_at so the
   * thread surfaces as touched.
   */
  async updateContextMetrics(
    threadId: string,
    metrics: CopilotContextMetrics,
    providerProfileId: string,
    model: string,
  ): Promise<void> {
    const now = this.clock.now();
    await this.db
      .update(experienceCopilotThreads)
      .set({
        contextMetricsJson: JSON.stringify(metrics),
        lastProviderProfileId: providerProfileId,
        lastModel: model,
        updatedAt: now,
      })
      .where(eq(experienceCopilotThreads.id, threadId))
      .run();
  }

  /** Read the auto-compact toggle (default on when the row is missing — the
   *  auto-compaction gate, CM-6, treats a missing row as a fresh thread). */
  async getAutoCompact(threadId: string): Promise<boolean> {
    const row = await this.db
      .select({ autoCompact: experienceCopilotThreads.autoCompact })
      .from(experienceCopilotThreads)
      .where(eq(experienceCopilotThreads.id, threadId))
      .get();
    return row ? row.autoCompact === 1 : true;
  }

  /** Set the auto-compact toggle (0/1). Bumps updated_at. */
  async setAutoCompact(threadId: string, enabled: boolean): Promise<void> {
    const now = this.clock.now();
    await this.db
      .update(experienceCopilotThreads)
      .set({ autoCompact: enabled ? 1 : 0, updatedAt: now })
      .where(eq(experienceCopilotThreads.id, threadId))
      .run();
  }

  // ─── Pinned-context links (CX-1) ────────────────────────────────────────────

  /** Read the thread's pinned-context links (defensive parse: malformed → []). */
  async getContextLinks(threadId: string): Promise<CopilotContextLink[]> {
    const row = await this.db
      .select({ linksJson: experienceCopilotThreads.contextLinksJson })
      .from(experienceCopilotThreads)
      .where(eq(experienceCopilotThreads.id, threadId))
      .get();
    return row ? parseContextLinks(row.linksJson, threadId) : [];
  }

  /** Full-replace the thread's pinned-context links (the client computes
   *  add/remove; this is the PATCH semantics). Bumps updated_at. */
  async setContextLinks(threadId: string, links: readonly CopilotContextLink[]): Promise<void> {
    const now = this.clock.now();
    await this.db
      .update(experienceCopilotThreads)
      .set({ contextLinksJson: JSON.stringify(links), updatedAt: now })
      .where(eq(experienceCopilotThreads.id, threadId))
      .run();
  }

  // ─── Step-plan todo (TAG-2) ────────────────────────────────────────────────

  /** Full-replace the thread's step-plan (the model computes the whole list
   *  on every `todo` tool call — Cline-style rewrite semantics; the panel and
   *  the prompt section render whatever this holds). Bumps updated_at. The
   *  caller (services/api tool layer) validates the list shape + cap against
   *  the api-contracts schema; the store trusts its typed input, mirroring
   *  setContextLinks. */
  async updateTodo(threadId: string, items: readonly CopilotTodoItem[]): Promise<void> {
    const now = this.clock.now();
    await this.db
      .update(experienceCopilotThreads)
      .set({ todoJson: JSON.stringify(items), updatedAt: now })
      .where(eq(experienceCopilotThreads.id, threadId))
      .run();
  }

  /** Rewrite the persisted output payload of ONE tool-result message row
   *  (TAG-5 split-turn): the user answered a pending `ask_user` question, and
   *  the answer REPLACES the awaiting marker in that row — there is no
   *  separate user message row for an answer turn. Scoped to role "tool" rows
   * of THIS thread (the toolCallId is unique per tool row; the role guard
   *  keeps an assistant toolCallId-carrying row from ever matching). Bumps
   *  updated_at so the thread surfaces as touched. Returns null when no row
   *  matches (stale/foreign toolCallId — the caller decides whether that is an
   *  error). */
  async setToolResultOutput(
    threadId: string,
    toolCallId: string,
    payload: { toolName: string; output: unknown },
  ): Promise<ExperienceCopilotMessage | null> {
    const now = this.clock.now();
    const [row] = await this.db
      .update(experienceCopilotMessages)
      .set({ content: JSON.stringify(payload) })
      .where(
        and(
          eq(experienceCopilotMessages.threadId, threadId),
          eq(experienceCopilotMessages.toolCallId, toolCallId),
          eq(experienceCopilotMessages.role, "tool"),
        ),
      )
      .returning();
    if (!row) return null;
    await this.db
      .update(experienceCopilotThreads)
      .set({ updatedAt: now })
      .where(eq(experienceCopilotThreads.id, threadId))
      .run();
    return this.mapMessage(row);
  }

  // ─── Row mappers (brandId at the DB edge only) ─────────────────────────────

  private mapThread(row: typeof experienceCopilotThreads.$inferSelect): ExperienceCopilotThread {
    return {
      id: brandId<ExperienceCopilotThreadId>(row.id),
      scriptId: row.scriptId,
      draftSessionId: row.draftSessionId,
      title: row.title,
      archivedAt: row.archivedAt,
      contextMetrics: parseContextMetrics(row.contextMetricsJson, row.id),
      contextLinks: parseContextLinks(row.contextLinksJson, row.id),
      todo: parseTodo(row.todoJson, row.id),
      lastProviderProfileId: row.lastProviderProfileId,
      lastModel: row.lastModel,
      autoCompact: row.autoCompact === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapMessage(row: typeof experienceCopilotMessages.$inferSelect): ExperienceCopilotMessage {
    return {
      id: brandId<ExperienceCopilotMessageId>(row.id),
      threadId: brandId<ExperienceCopilotThreadId>(row.threadId),
      role: row.role,
      content: row.content,
      toolCallsJson: row.toolCallsJson,
      toolCallId: row.toolCallId,
      createdAt: row.createdAt,
    };
  }
}

// ─── Row-parse helpers (defensive, never fatal) ───────────────────────────

/** Type guard for the parsed metrics JSON shape. `attachedTokens` is additive
 *  (CX-1): rows written before the plan lack it — the guard accepts those and
 *  the caller defaults the value to 0. */
function isCopilotContextMetrics(value: unknown): value is Omit<CopilotContextMetrics, "attachedTokens"> & { attachedTokens?: unknown } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.systemTokens === "number" &&
    typeof v.digestTokens === "number" &&
    typeof v.historyTokens === "number" &&
    typeof v.totalTokens === "number" &&
    typeof v.budgetTokens === "number" &&
    typeof v.reserveTokens === "number" &&
    (v.source === "estimate" || v.source === "provider") &&
    typeof v.measuredAt === "string"
  );
}

/** Parse `context_metrics_json` into a validated {@link CopilotContextMetrics},
 *  or null when absent/malformed/wrong-shape. The column is always written via
 *  JSON.stringify of a valid object, so a failure indicates corruption — fall
 *  back to null (treated identically to "no metrics yet") and log it. */
function parseContextMetrics(text: string | null, threadId: string): CopilotContextMetrics | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    // Legacy rows (pre-CX-1) carry no attachedTokens — default to 0 rather than
    // rejecting: "no attached context recorded" and "attached not yet metered"
    // mean the same thing to the meter.
    if (isCopilotContextMetrics(parsed)) {
      return { ...parsed, attachedTokens: typeof parsed.attachedTokens === "number" ? parsed.attachedTokens : 0 };
    }
  } catch (err) {
    console.error(
      `[experience-copilot-store] malformed context_metrics_json for thread '${threadId}':`,
      err,
    );
    return null;
  }
  console.error(
    `[experience-copilot-store] invalid context_metrics_json shape for thread '${threadId}'`,
  );
  return null;
}

const COPILOT_TODO_STATUSES = new Set(["pending", "active", "completed", "abandoned"]);

/** Parse `todo_json` into validated {@link CopilotTodoItem}s. Absent/malformed
 *  JSON or a non-array → `[]` (logged where corrupt, never fatal): the todo
 *  list is the model's working plan — a corrupted column must never take the
 *  thread down, and the next `updateTodo` write heals it. Invalid entries are
 *  dropped individually (a mixed array keeps its valid items), mirroring
 *  parseContextLinks. */
function parseTodo(text: string | null, threadId: string): CopilotTodoItem[] {
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      console.error(`[experience-copilot-store] invalid todo_json for thread '${threadId}': not an array`);
      return [];
    }
    const items: CopilotTodoItem[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.title !== "string" || rec.title.length === 0 || rec.title.length > 200) continue;
      if (typeof rec.status !== "string" || !COPILOT_TODO_STATUSES.has(rec.status)) continue;
      items.push({ title: rec.title, status: rec.status as CopilotTodoItem["status"] });
    }
    return items;
  } catch (err) {
    console.error(`[experience-copilot-store] malformed todo_json for thread '${threadId}':`, err);
    return [];
  }
}

const COPILOT_LINK_TARGET_TYPES = new Set(["character", "persona", "lorebook", "script", "skill"]);

/** Parse `context_links_json` into validated {@link CopilotContextLink}s.
 *  Malformed JSON or a wrong shape → `[]` (logged, never fatal): links are
 *  advisory grounding — a corrupted column must never take the thread down,
 *  and the next `setContextLinks` write heals it. */
function parseContextLinks(text: string, threadId: string): CopilotContextLink[] {
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      console.error(`[experience-copilot-store] invalid context_links_json for thread '${threadId}': not an array`);
      return [];
    }
    const links: CopilotContextLink[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.targetType !== "string" || !COPILOT_LINK_TARGET_TYPES.has(rec.targetType)) continue;
      if (typeof rec.targetId !== "string" || rec.targetId.length === 0) continue;
      links.push({ targetType: rec.targetType as CopilotContextLink["targetType"], targetId: rec.targetId });
    }
    return links;
  } catch (err) {
    console.error(`[experience-copilot-store] malformed context_links_json for thread '${threadId}':`, err);
    return [];
  }
}
