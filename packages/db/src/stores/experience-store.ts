import { eq, and, isNull, isNotNull, asc, inArray } from 'drizzle-orm';
import {
  experienceSessions,
  experienceSteps,
  experienceEffects,
  experienceContextBundles,
  experienceAttachments,
} from '../db-schema.js';
import type { AppDb, DbTransaction } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

// ─── Return types (store-level row shapes) ───────────────────────────────────

export interface ExperienceSessionRow {
  id: string;
  chatId: string;
  branchId: string;
  activeSlot: number | null;
  // Pinned rules source snapshot (NO FK — survives source delete).
  rulesId: string;
  rulesLabel: string;
  rulesRevision: number;
  rulesSource: string;
  rulesSourceHash: string;
  // Pinned visual source snapshot (nullable; NO FK).
  visualId: string | null;
  visualLabel: string | null;
  visualRevision: number | null;
  visualSource: string | null;
  visualSourceHash: string | null;
  apiVersion: number;
  manifestId: string;
  manifestName: string;
  initialSettingsJson: string;
  currentStateJson: string;
  status: string;
  revision: number;
  participantsJson: string;
  capabilityGrantsJson: string;
  contextMode: string;
  reportFrontier: number;
  randomSeed: string;
  randomCursor: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExperienceStepRow {
  id: string;
  sessionId: string;
  sequence: number;
  kind: string;
  requestId: string | null;
  expectedRevision: number | null;
  appliedRevision: number | null;
  actorSnapshotJson: string | null;
  inputJson: string | null;
  emittedEventsJson: string;
  emittedEffectsJson: string;
  stateHash: string | null;
  message: string | null;
  createdAt: string;
}

export interface ExperienceEffectRow {
  id: string;
  sessionId: string;
  kind: string;
  status: string;
  originatingRevision: number;
  requestJson: string;
  resultJson: string | null;
  error: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExperienceContextBundleRow {
  id: string;
  sessionId: string;
  mode: string;
  branchFrontierRevision: number | null;
  messageFrontierPosition: number | null;
  variantsJson: string | null;
  compactSummaryJson: string | null;
  characterSnapshotJson: string | null;
  personaSnapshotJson: string | null;
  sourceHashesJson: string | null;
  providerProfileId: string | null;
  modelId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExperienceAttachmentRow {
  id: string;
  chatId: string;
  branchId: string;
  sessionId: string;
  sessionRevision: number;
  queueRevision: number;
  kind: string;
  publicEventsJson: string;
  hiddenStateCheckpointJson: string;
  rulesSourceHash: string;
  visualSourceHash: string | null;
  boundMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Input types ─────────────────────────────────────────────────────────────

export interface CreateSessionData {
  chatId: string;
  branchId: string;
  rulesId: string;
  rulesLabel: string;
  rulesRevision: number;
  rulesSource: string;
  rulesSourceHash: string;
  visualId?: string | null;
  visualLabel?: string | null;
  visualRevision?: number | null;
  visualSource?: string | null;
  visualSourceHash?: string | null;
  apiVersion: number;
  manifestId: string;
  manifestName: string;
  initialSettingsJson: string;
  currentStateJson: string;
  participantsJson: string;
  capabilityGrantsJson: string;
  contextMode: string;
  randomSeed: string;
}

export interface ApplyTransitionData {
  sessionId: string;
  expectedRevision: number;
  /** Per-session idempotency key (null for system steps). */
  requestId: string | null;
  /** Step kind: 'action' | 'effect_result' | 'system'. */
  kind: string;
  actorSnapshotJson: string | null;
  inputJson: string | null;
  emittedEventsJson: string;
  /** Effect REQUESTS emitted by the reducer (each becomes a pending effect row). */
  emittedEffectsJson: string;
  stateHash: string | null;
  message: string | null;
  // New authoritative state after the transition.
  newCurrentStateJson: string;
  newStatus: string;
  /** New RNG cursor position after the method calls that drove this transition. */
  newRandomCursor: number;
}

export type ApplyTransitionResult =
  | { ok: true; session: ExperienceSessionRow; step: ExperienceStepRow; replayed: boolean }
  | { ok: false; conflict: 'stale_revision' };

export interface CaptureContextBundleData {
  mode: string;
  branchFrontierRevision?: number | null;
  messageFrontierPosition?: number | null;
  variantsJson?: string | null;
  compactSummaryJson?: string | null;
  characterSnapshotJson?: string | null;
  personaSnapshotJson?: string | null;
  sourceHashesJson?: string | null;
  providerProfileId?: string | null;
  modelId?: string | null;
}

export interface QueueAttachmentData {
  chatId: string;
  branchId: string;
  sessionId: string;
  sessionRevision: number;
  queueRevision: number;
  kind: string;
  publicEventsJson: string;
  hiddenStateCheckpointJson: string;
  rulesSourceHash: string;
  visualSourceHash?: string | null;
}

// ─── Store ───────────────────────────────────────────────────────────────────

/**
 * Interactive-runtime session persistence (INTERACTIVE_RUNTIME_FOUNDATION_PLAN,
 * Wave 2 / IR-21).
 *
 * The AUTHORITY CORE for experience state: branch-scoped sessions, the ordered
 * action/effect/system journal, durable model effects, frozen RP-context
 * bundles, and queued/bound RP-result attachments. Every mutating transition is
 * compare-and-swap on a monotonic revision and idempotent via a per-session
 * unique request id, so duplicate clicks, stale windows, retries, and delayed
 * model completions can never commit the same transition twice.
 *
 * Cross-store atomicity (binding an attachment to a user message in Wave 5) uses
 * synchronous `*InTx(tx)` cores that share the caller's `DbTransaction`, mirroring
 * `DiceRollStore.bindActiveAndResetInTx` / `forkCopyRollsInTx`: they throw BEFORE
 * any write on a stale revision, so a message-insert sharing the `tx` rolls back
 * fully. No `async`/`await` inside those cores — bun:sqlite query methods are
 * synchronous (see the "Synchronous transaction callbacks" constraint).
 */
export class ExperienceStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  // ─── Session lifecycle ───────────────────────────────────────────────────

  /**
   * Create a new branch-scoped session and claim the branch's active slot.
   * Returns a clean conflict if the branch already has an active session (the
   * design's "one active game per branch" rule — a new game requires the current
   * one to end or be explicitly finished). The unique {branchId, activeSlot}
   * index is the backstop; this check surfaces the conflict as a typed result.
   */
  async createSession(
    data: CreateSessionData,
  ): Promise<{ ok: true; session: ExperienceSessionRow } | { ok: false; conflict: 'branch_has_active' }> {
    const active = await this.getActiveSessionForBranch(data.branchId);
    if (active !== null) return { ok: false, conflict: 'branch_has_active' };

    const id = this.idGen.next('xs');
    const now = this.clock.now();
    const [row] = await this.db
      .insert(experienceSessions)
      .values({
        id,
        chatId: data.chatId,
        branchId: data.branchId,
        activeSlot: 0,
        rulesId: data.rulesId,
        rulesLabel: data.rulesLabel,
        rulesRevision: data.rulesRevision,
        rulesSource: data.rulesSource,
        rulesSourceHash: data.rulesSourceHash,
        visualId: data.visualId ?? null,
        visualLabel: data.visualLabel ?? null,
        visualRevision: data.visualRevision ?? null,
        visualSource: data.visualSource ?? null,
        visualSourceHash: data.visualSourceHash ?? null,
        apiVersion: data.apiVersion,
        manifestId: data.manifestId,
        manifestName: data.manifestName,
        initialSettingsJson: data.initialSettingsJson,
        currentStateJson: data.currentStateJson,
        status: 'active',
        revision: 0,
        participantsJson: data.participantsJson,
        capabilityGrantsJson: data.capabilityGrantsJson,
        contextMode: data.contextMode,
        reportFrontier: 0,
        randomSeed: data.randomSeed,
        randomCursor: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return { ok: true, session: this.mapRowSession(row!) };
  }

  async getSessionById(id: string): Promise<ExperienceSessionRow | null> {
    const row = await this.db
      .select()
      .from(experienceSessions)
      .where(eq(experienceSessions.id, id))
      .get();
    return row ? this.mapRowSession(row) : null;
  }

  /** The branch's active session (activeSlot NOT NULL), or null when none. */
  async getActiveSessionForBranch(branchId: string): Promise<ExperienceSessionRow | null> {
    const row = await this.db
      .select()
      .from(experienceSessions)
      .where(
        and(eq(experienceSessions.branchId, branchId), isNotNull(experienceSessions.activeSlot)),
      )
      .get();
    return row ? this.mapRowSession(row) : null;
  }

  /**
   * Mark a session finished (completed naturally, or interrupted by an explicit
   * user end) and release the branch's active slot (activeSlot → NULL). A
   * finished session stays queryable for history/replay; its bound attachments
   * persist (no-FK session_id survives). `status` is 'completed' or 'interrupted'.
   */
  async finishSession(sessionId: string, status: 'completed' | 'interrupted'): Promise<ExperienceSessionRow> {
    const now = this.clock.now();
    const [row] = await this.db
      .update(experienceSessions)
      .set({ status, activeSlot: null, updatedAt: now })
      .where(eq(experienceSessions.id, sessionId))
      .returning();
    if (!row) throw new Error(`Experience session '${sessionId}' not found after finish`);
    return this.mapRowSession(row);
  }

  // ─── CAS transition (the core write path) ────────────────────────────────

  /**
   * Apply one transition atomically: idempotency check (requestId) → CAS
   * (expectedRevision) → bump revision, update authoritative state, append a
   * journal step, and insert pending effect rows for every emitted effect
   * request. All four writes share ONE transaction.
   *
   * Idempotency: a duplicate requestId returns the PRIOR applied step's session
   * state with `replayed: true` — it never applies twice. CAS: a stale
   * expectedRevision returns `stale_revision` BEFORE any write.
   */
  async applyTransition(data: ApplyTransitionData): Promise<ApplyTransitionResult> {
    // 1. Idempotency — a step with this requestId already applied?
    if (data.requestId !== null) {
      const priorStep = await this.getStepByRequestId(data.sessionId, data.requestId);
      if (priorStep !== null) {
        const session = await this.getSessionById(data.sessionId);
        if (session !== null) {
          return { ok: true, session, step: priorStep, replayed: true };
        }
      }
    }

    // 2. CAS — load + compare revision BEFORE any write.
    const current = await this.getSessionById(data.sessionId);
    if (current === null) {
      throw new Error(`Experience session '${data.sessionId}' not found`);
    }
    if (current.revision !== data.expectedRevision) {
      return { ok: false, conflict: 'stale_revision' };
    }

    // 3. Apply atomically.
    const step = this.db.transaction((tx) => {
      const now = this.clock.now();
      const nextRevision = current.revision + 1;
      const stepId = this.idGen.next('xst');

      tx
        .update(experienceSessions)
        .set({
          currentStateJson: data.newCurrentStateJson,
          status: data.newStatus,
          revision: nextRevision,
          randomCursor: data.newRandomCursor,
          updatedAt: now,
        })
        .where(eq(experienceSessions.id, data.sessionId))
        .run();

      tx
        .insert(experienceSteps)
        .values({
          id: stepId,
          sessionId: data.sessionId,
          sequence: nextRevision,
          kind: data.kind,
          requestId: data.requestId,
          expectedRevision: data.expectedRevision,
          appliedRevision: nextRevision,
          actorSnapshotJson: data.actorSnapshotJson,
          inputJson: data.inputJson,
          emittedEventsJson: data.emittedEventsJson,
          emittedEffectsJson: data.emittedEffectsJson,
          stateHash: data.stateHash,
          message: data.message,
          createdAt: now,
        })
        .run();

      // Insert pending effect rows for each emitted request (persist before run).
      const effectRequests = parseJsonArray(data.emittedEffectsJson);
      for (let i = 0; i < effectRequests.length; i += 1) {
        const effectId = this.idGen.next('xe');
        tx
          .insert(experienceEffects)
          .values({
            id: effectId,
            sessionId: data.sessionId,
            kind: 'model',
            status: 'pending',
            originatingRevision: nextRevision,
            requestJson: JSON.stringify(effectRequests[i]),
            resultJson: null,
            error: null,
            attemptCount: 0,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }

      return {
        id: stepId,
        sessionId: data.sessionId,
        sequence: nextRevision,
        kind: data.kind,
        requestId: data.requestId,
        expectedRevision: data.expectedRevision,
        appliedRevision: nextRevision,
        actorSnapshotJson: data.actorSnapshotJson,
        inputJson: data.inputJson,
        emittedEventsJson: data.emittedEventsJson,
        emittedEffectsJson: data.emittedEffectsJson,
        stateHash: data.stateHash,
        message: data.message,
        createdAt: now,
      } satisfies ExperienceStepRow;
    });

    const updated = await this.getSessionById(data.sessionId);
    return { ok: true, session: updated!, step, replayed: false };
  }

  // ─── Journal (replay reads) ──────────────────────────────────────────────

  /** Ordered journal for a session (replay / recalculation source). */
  async getSteps(sessionId: string): Promise<ExperienceStepRow[]> {
    const rows = await this.db
      .select()
      .from(experienceSteps)
      .where(eq(experienceSteps.sessionId, sessionId))
      .orderBy(asc(experienceSteps.sequence))
      .all();
    return rows.map((r) => this.mapRowStep(r));
  }

  async getStepByRequestId(sessionId: string, requestId: string): Promise<ExperienceStepRow | null> {
    const row = await this.db
      .select()
      .from(experienceSteps)
      .where(
        and(
          eq(experienceSteps.sessionId, sessionId),
          eq(experienceSteps.requestId, requestId),
        ),
      )
      .get();
    return row ? this.mapRowStep(row) : null;
  }

  // ─── Durable effects ─────────────────────────────────────────────────────

  async getEffectById(id: string): Promise<ExperienceEffectRow | null> {
    const row = await this.db
      .select()
      .from(experienceEffects)
      .where(eq(experienceEffects.id, id))
      .get();
    return row ? this.mapRowEffect(row) : null;
  }

  async getEffectsForSession(sessionId: string): Promise<ExperienceEffectRow[]> {
    const rows = await this.db
      .select()
      .from(experienceEffects)
      .where(eq(experienceEffects.sessionId, sessionId))
      .all();
    return rows.map((r) => this.mapRowEffect(r));
  }

  /**
   * Atomically claim a pending effect: pending → running. Returns the claimed
   * effect, or null if it was no longer pending (already claimed/completed).
   * "Persist before execution": the host calls this BEFORE running the model,
   * so a crash after claim leaves a `running` effect that restart reconciles.
   */
  async claimEffect(effectId: string): Promise<ExperienceEffectRow | null> {
    const now = this.clock.now();
    // Conditional update: only pending effects transition to running.
    const [row] = await this.db
      .update(experienceEffects)
      .set({ status: 'running', updatedAt: now })
      .where(and(eq(experienceEffects.id, effectId), eq(experienceEffects.status, 'pending')))
      .returning();
    return row ? this.mapRowEffect(row) : null;
  }

  async completeEffect(effectId: string, resultJson: string): Promise<ExperienceEffectRow | null> {
    const now = this.clock.now();
    const [row] = await this.db
      .update(experienceEffects)
      .set({ status: 'succeeded', resultJson, error: null, updatedAt: now })
      .where(eq(experienceEffects.id, effectId))
      .returning();
    return row ? this.mapRowEffect(row) : null;
  }

  async failEffect(effectId: string, error: string): Promise<ExperienceEffectRow | null> {
    const now = this.clock.now();
    const [row] = await this.db
      .update(experienceEffects)
      .set({ status: 'failed', error, updatedAt: now })
      .where(eq(experienceEffects.id, effectId))
      .returning();
    return row ? this.mapRowEffect(row) : null;
  }

  async cancelEffect(effectId: string): Promise<ExperienceEffectRow | null> {
    const now = this.clock.now();
    const [row] = await this.db
      .update(experienceEffects)
      .set({ status: 'cancelled', updatedAt: now })
      .where(eq(experienceEffects.id, effectId))
      .returning();
    return row ? this.mapRowEffect(row) : null;
  }

  /**
   * Restart reconciliation: every effect still `running` (interrupted by a
   * process loss after claim) moves to `unknown` — NEVER directly back to
   * `pending`. Only an explicit user retry creates a new attempt. Returns the
   * count of reconciled effects. Called once at startup.
   */
  async reconcileUnknownEffects(): Promise<number> {
    const now = this.clock.now();
    const rows = await this.db
      .update(experienceEffects)
      .set({ status: 'unknown', updatedAt: now })
      .where(eq(experienceEffects.status, 'running'))
      .returning();
    return rows.length;
  }

  /**
   * Explicit user retry: a `failed`/`unknown`/`cancelled` effect returns to
   * `pending` with attemptCount incremented (preserving the original effect id
   * and audit history). Returns null if the effect was already succeeded/running.
   */
  async retryEffect(effectId: string): Promise<ExperienceEffectRow | null> {
    const current = await this.getEffectById(effectId);
    if (current === null) return null;
    if (current.status === 'succeeded' || current.status === 'running' || current.status === 'pending') {
      return null;
    }
    const now = this.clock.now();
    const [row] = await this.db
      .update(experienceEffects)
      .set({ status: 'pending', attemptCount: current.attemptCount + 1, error: null, updatedAt: now })
      .where(eq(experienceEffects.id, effectId))
      .returning();
    return row ? this.mapRowEffect(row) : null;
  }

  // ─── Context bundles ─────────────────────────────────────────────────────

  async getContextBundle(sessionId: string): Promise<ExperienceContextBundleRow | null> {
    const row = await this.db
      .select()
      .from(experienceContextBundles)
      .where(eq(experienceContextBundles.sessionId, sessionId))
      .get();
    return row ? this.mapRowBundle(row) : null;
  }

  /**
   * Capture (or replace) the session's frozen RP-context bundle. One row per
   * session (unique sessionId); a re-capture overwrites. Independent from
   * chat_summaries — this never mutates the normal summary surface.
   */
  async captureContextBundle(
    sessionId: string,
    data: CaptureContextBundleData,
  ): Promise<ExperienceContextBundleRow> {
    const existing = await this.getContextBundle(sessionId);
    const now = this.clock.now();
    const values = {
      mode: data.mode,
      branchFrontierRevision: data.branchFrontierRevision ?? null,
      messageFrontierPosition: data.messageFrontierPosition ?? null,
      variantsJson: data.variantsJson ?? null,
      compactSummaryJson: data.compactSummaryJson ?? null,
      characterSnapshotJson: data.characterSnapshotJson ?? null,
      personaSnapshotJson: data.personaSnapshotJson ?? null,
      sourceHashesJson: data.sourceHashesJson ?? null,
      providerProfileId: data.providerProfileId ?? null,
      modelId: data.modelId ?? null,
      updatedAt: now,
    };
    if (existing !== null) {
      const [row] = await this.db
        .update(experienceContextBundles)
        .set(values)
        .where(eq(experienceContextBundles.id, existing.id))
        .returning();
      return this.mapRowBundle(row!);
    }
    const id = this.idGen.next('xcb');
    const [row] = await this.db
      .insert(experienceContextBundles)
      .values({ id, sessionId, createdAt: now, ...values })
      .returning();
    return this.mapRowBundle(row!);
  }

  // ─── Attachments (queued/bound RP results) ───────────────────────────────

  /** Queue a new immutable report/transcript (unbound; boundMessageId NULL). */
  async queueAttachment(data: QueueAttachmentData): Promise<ExperienceAttachmentRow> {
    const id = this.idGen.next('xa');
    const now = this.clock.now();
    const [row] = await this.db
      .insert(experienceAttachments)
      .values({
        id,
        chatId: data.chatId,
        branchId: data.branchId,
        sessionId: data.sessionId,
        sessionRevision: data.sessionRevision,
        queueRevision: data.queueRevision,
        kind: data.kind,
        publicEventsJson: data.publicEventsJson,
        hiddenStateCheckpointJson: data.hiddenStateCheckpointJson,
        rulesSourceHash: data.rulesSourceHash,
        visualSourceHash: data.visualSourceHash ?? null,
        boundMessageId: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return this.mapRowAttachment(row!);
  }

  async getAttachmentById(id: string): Promise<ExperienceAttachmentRow | null> {
    const row = await this.db
      .select()
      .from(experienceAttachments)
      .where(eq(experienceAttachments.id, id))
      .get();
    return row ? this.mapRowAttachment(row) : null;
  }

  /** The session's current queued (unbound) attachment, or null. */
  async getQueuedAttachmentForSession(sessionId: string): Promise<ExperienceAttachmentRow | null> {
    const row = await this.db
      .select()
      .from(experienceAttachments)
      .where(
        and(
          eq(experienceAttachments.sessionId, sessionId),
          isNull(experienceAttachments.boundMessageId),
        ),
      )
      .get();
    return row ? this.mapRowAttachment(row) : null;
  }

  /**
   * Bind an attachment to a committed user message. Wraps the synchronous
   * {@link bindAttachmentInTx} core in its own transaction; Wave 5 calls the
   * core directly inside the message-insert transaction so the bind is atomic
   * with the user-message write.
   */
  async bindAttachment(attachmentId: string, messageId: string): Promise<ExperienceAttachmentRow | null> {
    return this.db.transaction((tx) => this.bindAttachmentInTx(tx, attachmentId, messageId));
  }

  bindAttachmentInTx(
    tx: DbTransaction,
    attachmentId: string,
    messageId: string,
  ): ExperienceAttachmentRow | null {
    const now = this.clock.now();
    tx
      .update(experienceAttachments)
      .set({ boundMessageId: messageId, updatedAt: now })
      .where(eq(experienceAttachments.id, attachmentId))
      .run();
    const row = tx
      .select()
      .from(experienceAttachments)
      .where(eq(experienceAttachments.id, attachmentId))
      .get();
    return row ? this.mapRowAttachment(row) : null;
  }

  /**
   * Release the message's bound attachment back to queued (boundMessageId →
   * NULL). Called when a user-message insert is rolled back — the attachment
   * returns to pending-send.
   */
  async rollbackReleaseAttachment(messageId: string): Promise<void> {
    await this.db
      .update(experienceAttachments)
      .set({ boundMessageId: null })
      .where(eq(experienceAttachments.boundMessageId, messageId))
      .run();
  }

  /**
   * Delete all attachments bound to a message (message-delete cleanup). Called
   * by the message lifecycle so a deleted RP message does not orphan its bound
   * attachment checkpoint.
   */
  async deleteAttachmentsWithMessage(messageId: string): Promise<void> {
    await this.db
      .delete(experienceAttachments)
      .where(eq(experienceAttachments.boundMessageId, messageId))
      .run();
  }

  async getAttachmentsForMessage(messageId: string): Promise<ExperienceAttachmentRow[]> {
    const rows = await this.db
      .select()
      .from(experienceAttachments)
      .where(eq(experienceAttachments.boundMessageId, messageId))
      .all();
    return rows.map((r) => this.mapRowAttachment(r));
  }

  async getAttachmentsForMessages(
    messageIds: string[],
  ): Promise<Map<string, ExperienceAttachmentRow[]>> {
    const out = new Map<string, ExperienceAttachmentRow[]>();
    if (messageIds.length === 0) return out;
    const rows = await this.db
      .select()
      .from(experienceAttachments)
      .where(inArray(experienceAttachments.boundMessageId, messageIds))
      .all();
    for (const row of rows) {
      const key = row.boundMessageId!;
      const list = out.get(key) ?? [];
      list.push(this.mapRowAttachment(row));
      out.set(key, list);
    }
    return out;
  }

  /** All bound attachments for a branch (branch-fork restore source lookup). */
  async getBoundAttachmentsForBranch(
    chatId: string,
    branchId: string,
  ): Promise<ExperienceAttachmentRow[]> {
    const rows = await this.db
      .select()
      .from(experienceAttachments)
      .where(
        and(
          eq(experienceAttachments.chatId, chatId),
          eq(experienceAttachments.branchId, branchId),
          isNotNull(experienceAttachments.boundMessageId),
        ),
      )
      .all();
    return rows.map((r) => this.mapRowAttachment(r));
  }

  /**
   * Fork-copy core: copy every attachment bound to a source message id onto its
   * corresponding new message id, within the caller's transaction. Used by
   * `ChatStore.forkBranch` (Wave 5) so the attachment copy is atomic with the
   * message/variant copy. Copied attachments get a fresh id and rebind to the
   * forked message; the immutable snapshot (events, hidden checkpoint, source
   * hashes, queue revision) is preserved.
   */
  forkCopyAttachmentsInTx(tx: DbTransaction, msgIdMap: Map<string, string>): number {
    if (msgIdMap.size === 0) return 0;
    const sourceRows = tx
      .select()
      .from(experienceAttachments)
      .where(inArray(experienceAttachments.boundMessageId, [...msgIdMap.keys()]))
      .all();
    if (sourceRows.length === 0) return 0;

    const now = this.clock.now();
    const copies: (typeof experienceAttachments.$inferInsert)[] = sourceRows.map((src) => ({
      id: this.idGen.next('xa'),
      chatId: src.chatId,
      branchId: src.branchId,
      sessionId: src.sessionId,
      sessionRevision: src.sessionRevision,
      queueRevision: src.queueRevision,
      kind: src.kind,
      publicEventsJson: src.publicEventsJson,
      hiddenStateCheckpointJson: src.hiddenStateCheckpointJson,
      rulesSourceHash: src.rulesSourceHash,
      visualSourceHash: src.visualSourceHash,
      boundMessageId: msgIdMap.get(src.boundMessageId!)!,
      createdAt: now,
      updatedAt: now,
    }));
    tx.insert(experienceAttachments).values(copies).run();
    return copies.length;
  }

  // ─── Row mappers ─────────────────────────────────────────────────────────

  private mapRowSession(row: typeof experienceSessions.$inferSelect): ExperienceSessionRow {
    return {
      id: row.id,
      chatId: row.chatId,
      branchId: row.branchId,
      activeSlot: row.activeSlot,
      rulesId: row.rulesId,
      rulesLabel: row.rulesLabel,
      rulesRevision: row.rulesRevision,
      rulesSource: row.rulesSource,
      rulesSourceHash: row.rulesSourceHash,
      visualId: row.visualId,
      visualLabel: row.visualLabel,
      visualRevision: row.visualRevision,
      visualSource: row.visualSource,
      visualSourceHash: row.visualSourceHash,
      apiVersion: row.apiVersion,
      manifestId: row.manifestId,
      manifestName: row.manifestName,
      initialSettingsJson: row.initialSettingsJson,
      currentStateJson: row.currentStateJson,
      status: row.status,
      revision: row.revision,
      participantsJson: row.participantsJson,
      capabilityGrantsJson: row.capabilityGrantsJson,
      contextMode: row.contextMode,
      reportFrontier: row.reportFrontier,
      randomSeed: row.randomSeed,
      randomCursor: row.randomCursor,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapRowStep(row: typeof experienceSteps.$inferSelect): ExperienceStepRow {
    return {
      id: row.id,
      sessionId: row.sessionId,
      sequence: row.sequence,
      kind: row.kind,
      requestId: row.requestId,
      expectedRevision: row.expectedRevision,
      appliedRevision: row.appliedRevision,
      actorSnapshotJson: row.actorSnapshotJson,
      inputJson: row.inputJson,
      emittedEventsJson: row.emittedEventsJson,
      emittedEffectsJson: row.emittedEffectsJson,
      stateHash: row.stateHash,
      message: row.message,
      createdAt: row.createdAt,
    };
  }

  private mapRowEffect(row: typeof experienceEffects.$inferSelect): ExperienceEffectRow {
    return {
      id: row.id,
      sessionId: row.sessionId,
      kind: row.kind,
      status: row.status,
      originatingRevision: row.originatingRevision,
      requestJson: row.requestJson,
      resultJson: row.resultJson,
      error: row.error,
      attemptCount: row.attemptCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapRowBundle(row: typeof experienceContextBundles.$inferSelect): ExperienceContextBundleRow {
    return {
      id: row.id,
      sessionId: row.sessionId,
      mode: row.mode,
      branchFrontierRevision: row.branchFrontierRevision,
      messageFrontierPosition: row.messageFrontierPosition,
      variantsJson: row.variantsJson,
      compactSummaryJson: row.compactSummaryJson,
      characterSnapshotJson: row.characterSnapshotJson,
      personaSnapshotJson: row.personaSnapshotJson,
      sourceHashesJson: row.sourceHashesJson,
      providerProfileId: row.providerProfileId,
      modelId: row.modelId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapRowAttachment(row: typeof experienceAttachments.$inferSelect): ExperienceAttachmentRow {
    return {
      id: row.id,
      chatId: row.chatId,
      branchId: row.branchId,
      sessionId: row.sessionId,
      sessionRevision: row.sessionRevision,
      queueRevision: row.queueRevision,
      kind: row.kind,
      publicEventsJson: row.publicEventsJson,
      hiddenStateCheckpointJson: row.hiddenStateCheckpointJson,
      rulesSourceHash: row.rulesSourceHash,
      visualSourceHash: row.visualSourceHash,
      boundMessageId: row.boundMessageId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseJsonArray(json: string): unknown[] {
  const parsed = JSON.parse(json) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}
