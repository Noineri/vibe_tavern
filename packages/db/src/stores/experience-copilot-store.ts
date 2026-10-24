import { and, eq, isNull, desc, asc } from 'drizzle-orm';
import { experienceCopilotThreads, experienceCopilotMessages, agentThreadContextEvents } from '../db-schema.js';
import type { AppDb, DbTransaction } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';
import { brandId, type ExperienceCopilotThreadId, type ExperienceCopilotMessageId, type AgentThreadContextEventId } from '@vibe-tavern/domain';
import { parseContextLinks, type CopilotContextMetrics, type CopilotContextLink, type CopilotTodoItem } from './experience-copilot-row-parse.js';
import { mapThread, mapMessage, mapEvent } from './experience-copilot-row-mappers.js';
import { compareTimelineEntries, parseFrontier, type AgentThreadContextEvent, type AgentThreadContextEventKind, type AgentThreadRpFrontier, type AgentThreadTimelineEntry, type RpSyncWritePlan } from './agent-thread-context-events.js';
import { forkChatThreadToBranch, type ForkThreadRemap } from './experience-copilot-fork-copy.js';
import { updateAssistantMessageContent, type CopilotMessageEditResult } from './experience-copilot-message-edit.js';
import { applyFirstMessageAutoTitle } from './experience-copilot-auto-title.js';
import { startNewSession, startNewChatSession } from './experience-copilot-session-start.js';

// ─── Input types ──────────────────────────────────────────────────────────────

export interface AppendMessageInput {
  role: string;
  /** Defaults to '' when omitted, mirroring the column default. */
  content?: string;
  /** Serialized tool-call payload (nullable). */
  toolCallsJson?: string | null;
  /** Correlated tool-call id for tool-result messages (nullable). */
  toolCallId?: string | null;
  /** AP-28: the turn's reasoning — pinned by the stream loop on the FIRST
   *  assistant row of a turn; omitted/null on every other row. */
  reasoning?: string | null;
  /** AP-28: summed per-burst reasoning elapsed ms (rides with `reasoning`). */
  reasoningDurationMs?: number | null;
}

// ─── Return types ─────────────────────────────────────────────────────────────

// CopilotContextMetrics / CopilotContextLink / CopilotTodoItem (the local
// structural twins of the api-contracts JSON-column shapes) live in
// experience-copilot-row-parse.ts beside their defensive parsers — extracted
// when this file hit the arch-gate size cap; re-exported from the stores
// barrel, so consumers see no difference.

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
  /** Chat-owner triple (SC-0a): set together on chat-owned threads, null on
   *  script-owned and draft rows. Plain strings, same as scriptId — the store
   *  projection keeps cross-domain links unbranded (ER-3). */
  chatId: string | null;
  branchId: string | null;
  /** Agent-shell kind slug on chat-owned threads; null on script/draft rows
   *  (their kind is derived from the script). */
  agentKind: string | null;
  title: string;
  /** NULL = the active session for this script_id; non-null ISO = archived. */
  archivedAt: string | null;
  /** Parsed context metrics from the last turn, or null before the first turn
   *  (or when the stored JSON is malformed — logged, never fatal). */
  contextMetrics: CopilotContextMetrics | null;
  /** Pinned-context links (CX-1); `[]` when none pinned or the stored JSON is
   *  malformed (logged, never fatal). */
  contextLinks: CopilotContextLink[];
  /** The model's session-scoped checklist (TAG-2, restored PM-7); `[]` until
   *  the first todo call or when the stored JSON is malformed (logged, never
   *  fatal). */
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

export interface ExperienceCopilotMessage {
  id: ExperienceCopilotMessageId;
  threadId: ExperienceCopilotThreadId;
  role: string;
  content: string;
  toolCallsJson: string | null;
  toolCallId: string | null;
  /** AP-28: the turn's reasoning (first assistant row of the turn only);
   *  null on every other row, on turns without reasoning, and on rows
   *  written before the column existed (additive migration, no backfill). */
  reasoning: string | null;
  /** AP-28: summed per-burst reasoning elapsed ms; null whenever `reasoning`
   *  is null. */
  reasoningDurationMs: number | null;
  /** Frozen-context seq (SC-1): allocated from the thread's next_seq on
   *  chat-owned threads (interleaving with context events); NULL on
   *  script/draft threads and on rows written before SC-1. */
  seq: number | null;
  createdAt: string;
}

// ─── Frozen context (SIDECHAT_PLAN SC-1) ─────────────────────────────
// The SC-1 read-model vocabulary (event kinds, event/frontier/timeline
// types, ordering + frontier-parse helpers) lives in
// agent-thread-context-events.ts; the store methods below are the surface.

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
    return row ? mapThread(row) : null;
  }

  /** The single active chat-owned thread (archived_at IS NULL) for a
   *  (chat, branch, kind) triple, or null — the chat-owner twin of
   *  {@link getActive}. Never matches script/draft rows (chat_id IS NULL on
   *  those). */
  async getActiveForChat(chatId: string, branchId: string, kind: string): Promise<ExperienceCopilotThread | null> {
    const row = await this.db
      .select()
      .from(experienceCopilotThreads)
      .where(
        and(
          eq(experienceCopilotThreads.chatId, chatId),
          eq(experienceCopilotThreads.branchId, branchId),
          eq(experienceCopilotThreads.agentKind, kind),
          isNull(experienceCopilotThreads.archivedAt),
        ),
      )
      .get();
    return row ? mapThread(row) : null;
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
    return rows.map((r) => mapMessage(r));
  }

  /** Fetch one thread by id. */
  async getById(sessionId: string): Promise<ExperienceCopilotThread | null> {
    const row = await this.db
      .select()
      .from(experienceCopilotThreads)
      .where(eq(experienceCopilotThreads.id, sessionId))
      .get();
    return row ? mapThread(row) : null;
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
    return rows.map((r) => mapThread(r));
  }

  /** Active + archived chat-owned threads for a (chat, branch, kind) triple,
   *  newest first — the chat-owner twin of {@link listSessions}. Scoped to the
   *  exact triple: other kinds on the same branch, other branches of the same
   *  chat, and script-owned sessions never appear. */
  async listSessionsForChat(chatId: string, branchId: string, kind: string): Promise<ExperienceCopilotThread[]> {
    const rows = await this.db
      .select()
      .from(experienceCopilotThreads)
      .where(
        and(
          eq(experienceCopilotThreads.chatId, chatId),
          eq(experienceCopilotThreads.branchId, branchId),
          eq(experienceCopilotThreads.agentKind, kind),
        ),
      )
      .orderBy(desc(experienceCopilotThreads.updatedAt), desc(experienceCopilotThreads.createdAt))
      .all();
    return rows.map((r) => mapThread(r));
  }

  /** Every ACTIVE (unarchived) chat-owned thread on one branch, across ALL
   *  agent kinds, oldest first (createdAt, then id as tiebreaker). Kinds are
   *  NEVER enumerated by the caller — whatever kinds have active threads on
   *  the branch are what this returns. Script/draft rows never match. */
  async listActiveChatThreadsForBranch(chatId: string, branchId: string): Promise<ExperienceCopilotThread[]> {
    const rows = await this.db
      .select()
      .from(experienceCopilotThreads)
      .where(
        and(
          eq(experienceCopilotThreads.chatId, chatId),
          eq(experienceCopilotThreads.branchId, branchId),
          isNull(experienceCopilotThreads.archivedAt),
        ),
      )
      .orderBy(asc(experienceCopilotThreads.createdAt), asc(experienceCopilotThreads.id))
      .all();
    return rows.map((r) => mapThread(r));
  }

  /**
   * "New session": archive the current active thread for this script (if any)
   * and create+return a fresh active one — thin seam over
   * `experience-copilot-session-start.ts` (extracted at the arch-gate size
   * cap); the creation contract is documented there. AP-20: `autoCompact`
   * seeds the new row's toggle from the script's agent-kind default (the
   * adapter resolves the kind and reads it); undefined keeps the column
   * default (on).
   */
  async startNewSession(scriptId: string, title?: string, autoCompact?: boolean): Promise<ExperienceCopilotThread> {
    return startNewSession({ db: this.db, clock: this.clock, idGen: this.idGen }, scriptId, title, autoCompact);
  }

  /**
   * "New session" for a chat owner (SC-0a): archive the current active sibling
   * thread of the SAME (chat, branch, kind) triple (if any) and create+return
   * a fresh active one — the chat-owner twin of {@link startNewSession};
   * thin seam over `experience-copilot-session-start.ts`, where the creation
   * contract is documented. AP-20: `autoCompact` seeds the new row's toggle
   * from this kind's default (the adapter reads it before calling).
   */
  async startNewChatSession(
    chatId: string,
    branchId: string,
    kind: string,
    title?: string,
    autoCompact?: boolean,
  ): Promise<ExperienceCopilotThread> {
    return startNewChatSession({ db: this.db, clock: this.clock, idGen: this.idGen }, chatId, branchId, kind, title, autoCompact);
  }

  /**
   * Resume an archived session: archive all siblings sharing its owner, then
   * mark this thread active (clear archived_at). No-op (returns the thread
   * unchanged) if it is already the active session. Siblings are scoped to the
   * owner — a chat-owned thread archives only threads of the same
   * (chat_id, branch_id, agent_kind) triple (its script siblings — other kinds,
   * other branches, script-owned threads — are never touched), a script-owned
   * thread archives its same-script_id siblings. Enforces at-most-one-active
   * inside a synchronous transaction when an owner is present. A draft thread
   * (script_id NULL, chat_id NULL, exempt from both partial unique indexes)
   * only clears its own archived_at.
   */
  async activate(sessionId: string): Promise<ExperienceCopilotThread | null> {
    const target = await this.getById(sessionId);
    if (!target) return null;
    if (target.archivedAt === null) return target; // already the active session

    const now = this.clock.now();
    if (target.chatId !== null && target.branchId !== null && target.agentKind !== null) {
      // Chat owner (SC-0a): archive same-(chat, branch, kind) siblings only.
      const { chatId, branchId, agentKind } = target;
      this.db.transaction((tx) => {
        tx
          .update(experienceCopilotThreads)
          .set({ archivedAt: now, updatedAt: now })
          .where(
            and(
              eq(experienceCopilotThreads.chatId, chatId),
              eq(experienceCopilotThreads.branchId, branchId),
              eq(experienceCopilotThreads.agentKind, agentKind),
              isNull(experienceCopilotThreads.archivedAt),
            ),
          )
          .run();
        tx
          .update(experienceCopilotThreads)
          .set({ archivedAt: null, updatedAt: now })
          .where(eq(experienceCopilotThreads.id, sessionId))
          .run();
      });
    } else if (target.scriptId !== null) {
      const scriptId = target.scriptId;
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
    } else {
      await this.db
        .update(experienceCopilotThreads)
        .set({ archivedAt: null, updatedAt: now })
        .where(eq(experienceCopilotThreads.id, sessionId))
        .run();
    }
    const row = await this.db
      .select()
      .from(experienceCopilotThreads)
      .where(eq(experienceCopilotThreads.id, sessionId))
      .get();
    return row ? mapThread(row) : null;
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
    return row ? mapThread(row) : null;
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
    return row ? mapThread(row) : null;
  }

  /**
   * Append a message to a thread and bump the thread's updated_at so it surfaces
   * as the most recently touched session. Returns the inserted message (a
   * user row on an UNTITLED thread also auto-titles it — AP-19). Both
   * writes run in a synchronous transaction so updated_at always reflects the
   * last appended message (a failure on either rolls both back). SC-1: on a
   * CHAT-OWNED thread the same transaction also allocates the next gapless
   * seq (read-and-increment of next_seq) and stamps it on the row, so messages
   * interleave with frozen-context events on the merged timeline; script/draft
   * threads append with seq NULL and keep their created_at-based ordering.
   */
  async appendMessage(threadId: string, input: AppendMessageInput): Promise<ExperienceCopilotMessage> {
    const now = this.clock.now();
    const id = this.idGen.next('expcop_msg');
    this.db.transaction((tx) => {
      if (input.role === 'user') applyFirstMessageAutoTitle(tx, threadId, input.content ?? '');
      const seq = this.allocateSeqAndTouchThread(tx, threadId, now);
      tx
        .insert(experienceCopilotMessages)
        .values({
          id,
          threadId,
          role: input.role,
          content: input.content ?? '',
          toolCallsJson: input.toolCallsJson ?? null,
          toolCallId: input.toolCallId ?? null,
          reasoning: input.reasoning ?? null,
          reasoningDurationMs: input.reasoningDurationMs ?? null,
          seq,
          createdAt: now,
        })
        .run();
    });
    const row = await this.db
      .select()
      .from(experienceCopilotMessages)
      .where(eq(experienceCopilotMessages.id, id))
      .get();
    return mapMessage(row!);
  }

  // ─── Frozen context events / timeline / frontier (SIDECHAT_PLAN SC-1/SC-2c) ──

  /**
   * Append a frozen-context event to a thread's timeline (SC-1): chat-state
   * milestones (rp sync, variant attach, selection change, branch fork).
   * seq is allocated exactly like appendMessage (the same next_seq counter,
   * the same synchronous transaction), so events interleave with messages;
   * the thread's updated_at is bumped. The payload's shape is the event
   * writer's contract (SC-2c+) — the store only serializes it. Returns the
   * inserted event.
   */
  async appendContextEvent(
    threadId: string,
    kind: AgentThreadContextEventKind,
    payload: unknown,
  ): Promise<AgentThreadContextEvent> {
    const now = this.clock.now();
    const id = this.idGen.next('expcop_evt');
    let seq: number | null = null;
    this.db.transaction((tx) => {
      seq = this.allocateSeqAndTouchThread(tx, threadId, now);
      tx
        .insert(agentThreadContextEvents)
        .values({
          id,
          threadId,
          seq,
          kind,
          payloadJson: JSON.stringify(payload),
          createdAt: now,
        })
        .run();
    });
    // The row was just written from these exact values (payloadJson is a
    // fresh JSON.stringify — it cannot be malformed), so the projection is
    // built directly instead of re-reading + mapEvent (which reserves null
    // for corrupted rows).
    return {
      id: brandId<AgentThreadContextEventId>(id),
      threadId: brandId<ExperienceCopilotThreadId>(threadId),
      seq,
      kind,
      payload,
      createdAt: now,
    };
  }

  /**
   * The merged timeline of ONE thread (SC-1): messages + frozen-context events
   * in frozen order. Chat-owned threads interleave by seq ascending (rows
   * written before SC-1 carry NULL seq and sort first); a thread whose rows
   * are all-NULL seq (script/draft) orders by createdAt + id — byte-identical
   * to listMessages today. Events with malformed payload_json are skipped
   * (logged, never fatal); listMessages itself is unchanged for existing
   * consumers.
   */
  async listTimeline(threadId: string): Promise<AgentThreadTimelineEntry[]> {
    const messageRows = await this.db
      .select()
      .from(experienceCopilotMessages)
      .where(eq(experienceCopilotMessages.threadId, threadId))
      .all();
    const eventRows = await this.db
      .select()
      .from(agentThreadContextEvents)
      .where(eq(agentThreadContextEvents.threadId, threadId))
      .all();
    const entries: AgentThreadTimelineEntry[] = [];
    for (const row of messageRows) {
      entries.push({ rowType: 'message', ...mapMessage(row) });
    }
    for (const row of eventRows) {
      const event = mapEvent(row);
      if (event) entries.push({ rowType: 'event', ...event });
    }
    entries.sort(compareTimelineEntries);
    return entries;
  }

  /**
   * Read the thread's frozen RP-chat frontier (SC-1): null until the first rp
   * sync, when the thread does not exist, or when the stored JSON is malformed
   * or of the wrong shape (logged, never fatal — the store's defensive-parse
   * contract).
   */
  async getFrontier(threadId: string): Promise<AgentThreadRpFrontier | null> {
    const row = await this.db
      .select({ rpFrontierJson: experienceCopilotThreads.rpFrontierJson })
      .from(experienceCopilotThreads)
      .where(eq(experienceCopilotThreads.id, threadId))
      .get();
    if (!row || row.rpFrontierJson === null) return null;
    return parseFrontier(row.rpFrontierJson, threadId);
  }

  /**
   * Wholesale-replace the thread's frozen RP-chat frontier (SC-1): the sync
   * writer (SC-2c) computes the full snapshot — there is no partial merge.
   * Bumps updated_at so the thread surfaces as touched.
   */
  async setFrontier(threadId: string, frontier: AgentThreadRpFrontier): Promise<void> {
    const now = this.clock.now();
    await this.db
      .update(experienceCopilotThreads)
      .set({ rpFrontierJson: JSON.stringify(frontier), updatedAt: now })
      .where(eq(experienceCopilotThreads.id, threadId))
      .run();
  }

  /**
   * Apply one RP sync ATOMICALLY (SC-2c): inside ONE synchronous transaction
   * — read the thread's stored frontier, hand it to `compute` (the caller's
   * pure diff: services/api's computeRpSync over a branch view read before
   * this call), append every planned event (seq allocated exactly like
   * appendContextEvent, so the events interleave with messages on the merged
   * timeline), then wholesale-replace the frontier. The frontier READ and the
   * WRITES share the transaction on purpose: two back-to-back syncs then
   * cannot both see the pre-sync frontier — the second computes its diff
   * against the first's COMMITTED frontier, so a delta is never duplicated
   * (bun:sqlite transactions are synchronous; no await can interleave between
   * the read and the writes). A `compute` throw — the frozen-history
   * corruption SC-2c names — propagates out of the synchronous callback, so
   * the whole transaction rolls back: no events, no frontier move. The store
   * stays payload-agnostic, exactly like appendContextEvent: nothing inside
   * `plan` is validated here. The callback form keeps the pure diff out of
   * this package's imports (dependency direction) while its input frontier is
   * still read inside the same transaction that writes the plan.
   */
  async applyRpSync(
    threadId: string,
    compute: (frontier: AgentThreadRpFrontier | null) => RpSyncWritePlan,
  ): Promise<void> {
    const now = this.clock.now();
    this.db.transaction((tx) => {
      const row = tx
        .select({ rpFrontierJson: experienceCopilotThreads.rpFrontierJson })
        .from(experienceCopilotThreads)
        .where(eq(experienceCopilotThreads.id, threadId))
        .get();
      const frontier =
        row === undefined || row.rpFrontierJson === null
          ? null
          : parseFrontier(row.rpFrontierJson, threadId);
      const plan = compute(frontier);
      for (const event of plan.events) {
        const id = this.idGen.next('expcop_evt');
        const seq = this.allocateSeqAndTouchThread(tx, threadId, now);
        tx
          .insert(agentThreadContextEvents)
          .values({
            id,
            threadId,
            seq,
            kind: event.kind,
            payloadJson: JSON.stringify(event.payload),
            createdAt: now,
          })
          .run();
      }
      tx
        .update(experienceCopilotThreads)
        .set({ rpFrontierJson: JSON.stringify(plan.frontier), updatedAt: now })
        .where(eq(experienceCopilotThreads.id, threadId))
        .run();
    });
  }

  // ─── Branch-sidechat fork copy (SIDECHAT_PLAN SC-20) ───────────────────

  /**
   * Copy ONE chat-owned thread onto another branch of the same chat (SC-20) —
   * the thin seam over `experience-copilot-fork-copy.ts` (extracted at the
   * arch-gate cap); the copy's full contract is documented there.
   */
  async forkChatThreadToBranch(
    sourceThreadId: string,
    targetBranchId: string,
    remap: ForkThreadRemap,
  ): Promise<ExperienceCopilotThread | null> {
    return forkChatThreadToBranch(
      { db: this.db, clock: this.clock, idGen: this.idGen, allocateSeq: (tx, threadId, now) => this.allocateSeqAndTouchThread(tx, threadId, now) },
      sourceThreadId,
      targetBranchId,
      remap,
    );
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

  // ─── Session-scoped checklist todo (TAG-2, restored PM-7) ──────────────

  /** Full-replace the thread's checklist (the model computes the whole list
   *  on every `todo` tool call — Cline-style rewrite semantics; the panel
   *  renders whatever this holds). Bumps updated_at. The caller (services/api
   *  tool layer) validates the list shape + cap against the api-contracts
   *  schema; the store trusts its typed input, mirroring setContextLinks. */
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
    return mapMessage(row);
  }

  /**
   * AP-30: replace ONE assistant text row's `content` in place — thin seam
   * over `experience-copilot-message-edit.ts` (the turn-delete sibling
   * pattern: the eligibility checks, the digest-anchor fold boundary, and
   * the single-row update live there; the store family owns the columns).
   * Returns the updated row, or the typed refusal (not an assistant text
   * row / a tool-call carrier / an empty replacement or row / folded into
   * the last digest / missing thread or message).
   */
  updateAssistantContent(
    threadId: string,
    messageId: string,
    content: string,
  ): Promise<CopilotMessageEditResult> {
    return updateAssistantMessageContent({ db: this.db, clock: this.clock }, threadId, messageId, content);
  }

  // ─── Seq allocation (SC-1, internal) ────────────────────────────────

  /**
   * SC-1: bump the thread's updated_at and, on a CHAT-OWNED thread, allocate
   * the next gapless seq (read-and-increment of next_seq) inside the caller's
   * append transaction. Returns the allocated seq, or null for script/draft
   * rows — they never allocate and keep created_at-based ordering. The
   * read-modify-write is race-free because bun:sqlite transactions here are
   * synchronous (no await can interleave between the read and the write). The
   * chat-owned predicate is the store-seam twin of isChatOwnedAgentThread
   * (services/api/agent-thread-owner.ts — the db package cannot import it,
   * dependency direction): ownership columns are set together by the store,
   * so chatId + agentKind non-null identifies the chat-owned rows.
   */
  private allocateSeqAndTouchThread(tx: DbTransaction, threadId: string, now: string): number | null {
    const thread = tx
      .select({ chatId: experienceCopilotThreads.chatId, agentKind: experienceCopilotThreads.agentKind, nextSeq: experienceCopilotThreads.nextSeq })
      .from(experienceCopilotThreads)
      .where(eq(experienceCopilotThreads.id, threadId))
      .get();
    let seq: number | null = null;
    if (thread?.chatId != null && thread.agentKind != null) {
      seq = thread.nextSeq ?? 0;
    }
    const nextSeqUpdate = seq === null ? {} : { nextSeq: seq + 1 };
    tx
      .update(experienceCopilotThreads)
      .set({ updatedAt: now, ...nextSeqUpdate })
      .where(eq(experienceCopilotThreads.id, threadId))
      .run();
    return seq;
  }
}
