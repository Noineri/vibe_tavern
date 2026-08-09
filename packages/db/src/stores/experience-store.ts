import { eq, and, isNull, isNotNull, asc, desc, inArray } from 'drizzle-orm';
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
  /** Cursor consumed by create(); persisted before the session becomes active. */
  randomCursor?: number;
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

/**
 * Input for {@link ExperienceStore.freezeReport} (IR-70B). The report service
 * (IR-70C) builds the public events and hidden checkpoint from the journal and
 * calls this core to freeze them at `sessionRevision`, advancing the session's
 * report frontier atomically. The store owns the monotonic `queueRevision` —
 * the caller never supplies it.
 */
export interface FreezeReportData {
  chatId: string;
  branchId: string;
  sessionId: string;
  /** Session revision the report is frozen at — becomes the new reportFrontier. */
  sessionRevision: number;
  kind: string;
  publicEventsJson: string;
  /** Opaque authoritative hidden-state checkpoint (never derived from events). */
  hiddenStateCheckpointJson: string;
  rulesSourceHash: string;
  visualSourceHash?: string | null;
}

/** The report payload composed by the service for an atomic start/final freeze. */
export type AtomicReportData = Omit<FreezeReportData, 'chatId' | 'branchId' | 'sessionId' | 'sessionRevision'>;

export type FinishSessionWithReportResult =
  | { ok: true; session: ExperienceSessionRow; attachment: ExperienceAttachmentRow | null; idempotent: boolean }
  | { ok: false; conflict: 'session_not_found' | 'stale_revision' };

export type FreezeReportConflict =
  | 'session_not_found'
  | 'scope_mismatch'
  | 'frontier_beyond_revision'
  | 'frontier_regression'
  | 'stale_freeze';

/**
 * Result of {@link ExperienceStore.freezeReport}. `idempotent: true` means the
 * exact same frontier + content was already frozen and the existing row was
 * returned without a queueRevision bump; `idempotent: false` means a real
 * freeze committed (a new row inserted or the unbound row replaced in place).
 */
export type FreezeReportResult =
  | { ok: true; attachment: ExperienceAttachmentRow; session: ExperienceSessionRow; idempotent: boolean }
  | { ok: false; conflict: FreezeReportConflict };

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
        randomCursor: data.randomCursor ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return { ok: true, session: this.mapRowSession(row!) };
  }

  /**
   * Atomically creates the active session and its revision-zero report. The
   * callback receives the fully identified session row, but runs synchronously
   * inside the SQLite transaction so a report construction failure rolls back
   * the active-slot claim as well as both inserts.
   */
  createSessionWithInitialReport(
    data: CreateSessionData,
    makeReport: (session: ExperienceSessionRow) => AtomicReportData,
  ): { ok: true; session: ExperienceSessionRow; attachment: ExperienceAttachmentRow } | { ok: false; conflict: 'branch_has_active' } {
    return this.db.transaction((tx) => {
      const active = tx
        .select({ id: experienceSessions.id })
        .from(experienceSessions)
        .where(and(eq(experienceSessions.branchId, data.branchId), isNotNull(experienceSessions.activeSlot)))
        .get();
      if (active) return { ok: false, conflict: 'branch_has_active' };

      const id = this.idGen.next('xs');
      const now = this.clock.now();
      const session: ExperienceSessionRow = {
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
        randomCursor: data.randomCursor ?? 0,
        createdAt: now,
        updatedAt: now,
      };
      const report = makeReport(session);
      tx.insert(experienceSessions).values({ ...session }).run();
      const attachment: ExperienceAttachmentRow = {
        id: this.idGen.next('xa'),
        chatId: session.chatId,
        branchId: session.branchId,
        sessionId: session.id,
        sessionRevision: 0,
        queueRevision: 1,
        kind: report.kind,
        publicEventsJson: report.publicEventsJson,
        hiddenStateCheckpointJson: report.hiddenStateCheckpointJson,
        rulesSourceHash: report.rulesSourceHash,
        visualSourceHash: report.visualSourceHash ?? null,
        boundMessageId: null,
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(experienceAttachments).values(attachment).run();
      return { ok: true, session, attachment };
    });
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

  /**
   * Atomically finalizes the host-owned active slot and freezes the supplied
   * report. An active reducer state becomes an interrupted manual finish and
   * gains the public user-ended system step. A rule-completed state keeps its
   * status/revision and only releases the slot while freezing its accumulated
   * public result. The optional synchronous seam proves rollback atomicity.
   */
  finishSessionWithFinalReport(
    sessionId: string,
    expectedRevision: number,
    report: AtomicReportData,
    beforeFreeze?: () => void,
  ): FinishSessionWithReportResult {
    return this.db.transaction((tx) => {
      const current = tx.select().from(experienceSessions).where(eq(experienceSessions.id, sessionId)).get();
      if (!current) return { ok: false, conflict: 'session_not_found' };
      if (current.activeSlot === null) {
        const attachment = tx
          .select()
          .from(experienceAttachments)
          .where(and(eq(experienceAttachments.sessionId, sessionId), isNull(experienceAttachments.boundMessageId)))
          .orderBy(desc(experienceAttachments.queueRevision))
          .get();
        return {
          ok: true,
          session: this.mapRowSession(current),
          attachment: attachment ? this.mapRowAttachment(attachment) : null,
          idempotent: true,
        };
      }
      if (current.revision !== expectedRevision) return { ok: false, conflict: 'stale_revision' };

      const manualFinish = current.status === 'active';
      const finalRevision = manualFinish ? current.revision + 1 : current.revision;
      const finalStatus = manualFinish ? 'interrupted' : current.status;
      const now = this.clock.now();
      tx
        .update(experienceSessions)
        .set({ status: finalStatus, activeSlot: null, revision: finalRevision, reportFrontier: finalRevision, updatedAt: now })
        .where(eq(experienceSessions.id, sessionId))
        .run();
      if (manualFinish) {
        tx
          .insert(experienceSteps)
          .values({
            id: this.idGen.next('xst'),
            sessionId,
            sequence: finalRevision,
            kind: 'system',
            requestId: null,
            expectedRevision,
            appliedRevision: finalRevision,
            actorSnapshotJson: null,
            inputJson: null,
            emittedEventsJson: JSON.stringify([{ visibility: 'public', type: 'experience_finished', detail: 'The user decided to end the game.' }]),
            emittedEffectsJson: '[]',
            stateHash: null,
            message: 'The user decided to end the game.',
            createdAt: now,
          })
          .run();
      }
      beforeFreeze?.();

      const attachment = this.writeFinalAttachmentInTx(tx, this.mapRowSession(current), finalRevision, report, now);
      const updated = tx.select().from(experienceSessions).where(eq(experienceSessions.id, sessionId)).get();
      return { ok: true, session: this.mapRowSession(updated!), attachment, idempotent: false };
    });
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

  /** Write or replace the one queued terminal attachment inside its caller's transaction. */
  private writeFinalAttachmentInTx(
    tx: DbTransaction,
    session: Pick<ExperienceSessionRow, 'id' | 'chatId' | 'branchId'>,
    finalRevision: number,
    report: AtomicReportData,
    now: string,
  ): ExperienceAttachmentRow {
    const existing = tx
      .select()
      .from(experienceAttachments)
      .where(and(eq(experienceAttachments.sessionId, session.id), isNull(experienceAttachments.boundMessageId)))
      .orderBy(desc(experienceAttachments.queueRevision))
      .get();
    const visualSourceHash = report.visualSourceHash ?? null;
    if (
      existing
      && existing.sessionRevision === finalRevision
      && existing.kind === report.kind
      && existing.publicEventsJson === report.publicEventsJson
      && existing.hiddenStateCheckpointJson === report.hiddenStateCheckpointJson
      && existing.rulesSourceHash === report.rulesSourceHash
      && existing.visualSourceHash === visualSourceHash
    ) {
      return this.mapRowAttachment(existing);
    }
    const max = tx
      .select()
      .from(experienceAttachments)
      .where(eq(experienceAttachments.sessionId, session.id))
      .orderBy(desc(experienceAttachments.queueRevision))
      .get();
    const queueRevision = (max?.queueRevision ?? 0) + 1;
    const attachmentId = existing?.id ?? this.idGen.next('xa');
    if (existing) {
      tx.update(experienceAttachments).set({
        sessionRevision: finalRevision,
        queueRevision,
        kind: report.kind,
        publicEventsJson: report.publicEventsJson,
        hiddenStateCheckpointJson: report.hiddenStateCheckpointJson,
        rulesSourceHash: report.rulesSourceHash,
        visualSourceHash,
        updatedAt: now,
      }).where(eq(experienceAttachments.id, existing.id)).run();
    } else {
      tx.insert(experienceAttachments).values({
        id: attachmentId,
        chatId: session.chatId,
        branchId: session.branchId,
        sessionId: session.id,
        sessionRevision: finalRevision,
        queueRevision,
        kind: report.kind,
        publicEventsJson: report.publicEventsJson,
        hiddenStateCheckpointJson: report.hiddenStateCheckpointJson,
        rulesSourceHash: report.rulesSourceHash,
        visualSourceHash,
        boundMessageId: null,
        createdAt: now,
        updatedAt: now,
      }).run();
    }
    const attachment = tx.select().from(experienceAttachments).where(eq(experienceAttachments.id, attachmentId)).get();
    return this.mapRowAttachment(attachment!);
  }

  /**
   * Freeze a report/transcript snapshot at `sessionRevision`, advancing the
   * session's `reportFrontier` in the SAME synchronous transaction. This is the
   * IR-70B transactional queue core that the report service (IR-70C) calls to
   * freeze or explicitly replace the one queued experience attachment.
   *
   * The store — not the caller — owns monotonic `queueRevision`, derived from
   * persisted session attachment history (highest queueRevision across ALL
   * attachments for the session + 1) so a newly queued row after an earlier row
   * was bound never resets to 1.
   *
   * Semantics:
   *  - No unbound row exists → INSERT a new queued attachment (first freeze, or
   *    the first freeze after the previous report was bound).
   *  - An unbound row exists → REPLACE it IN PLACE (same attachment id) with the
   *    new content and an advanced queueRevision (the "Add later events" action).
   *  - An exact duplicate freeze (same sessionRevision + content) at the current
   *    frontier → idempotent: return the current row without bumping.
   *
   * Bound historical attachments are immutable and never updated.
   *
   * Rejections (each a typed conflict, never a partial write):
   *  - `session_not_found`        — the session id does not exist.
   *  - `scope_mismatch`           — chatId/branchId do not match the session.
   *  - `frontier_beyond_revision` — sessionRevision exceeds the session's current
   *                                 authoritative revision (a report of unplayed state).
   *  - `frontier_regression`      — sessionRevision is below the current reportFrontier.
   *  - `stale_freeze`             — sessionRevision equals the reportFrontier but the
   *                                 content differs (non-monotonic re-freeze), or the
   *                                 frontier was already frozen-and-bound and no
   *                                 unbound row remains to re-freeze at that revision.
   *
   * The hidden checkpoint content is opaque to this core: it is persisted
   * verbatim and never derived from public events.
   */
  freezeReport(data: FreezeReportData): FreezeReportResult {
    return this.db.transaction((tx) => {
      const sessionRow = tx
        .select()
        .from(experienceSessions)
        .where(eq(experienceSessions.id, data.sessionId))
        .get();
      if (!sessionRow) {
        return { ok: false, conflict: 'session_not_found' };
      }
      if (sessionRow.chatId !== data.chatId || sessionRow.branchId !== data.branchId) {
        return { ok: false, conflict: 'scope_mismatch' };
      }
      if (data.sessionRevision > sessionRow.revision) {
        return { ok: false, conflict: 'frontier_beyond_revision' };
      }
      if (data.sessionRevision < sessionRow.reportFrontier) {
        return { ok: false, conflict: 'frontier_regression' };
      }

      // The current unbound (queued) row, if any — deterministically the highest
      // queueRevision. At most one unbound row is authoritative for a session.
      const existingUnbound = tx
        .select()
        .from(experienceAttachments)
        .where(
          and(
            eq(experienceAttachments.sessionId, data.sessionId),
            isNull(experienceAttachments.boundMessageId),
          ),
        )
        .orderBy(desc(experienceAttachments.queueRevision))
        .get();

      // Exact-duplicate idempotency at the current frontier — return the row
      // without bumping the queueRevision.
      if (
        existingUnbound &&
        sessionRow.reportFrontier === data.sessionRevision &&
        existingUnbound.sessionRevision === data.sessionRevision &&
        existingUnbound.publicEventsJson === data.publicEventsJson &&
        existingUnbound.hiddenStateCheckpointJson === data.hiddenStateCheckpointJson &&
        existingUnbound.kind === data.kind &&
        existingUnbound.rulesSourceHash === data.rulesSourceHash &&
        (existingUnbound.visualSourceHash ?? null) === (data.visualSourceHash ?? null)
      ) {
        return {
          ok: true,
          attachment: this.mapRowAttachment(existingUnbound),
          session: this.mapRowSession(sessionRow),
          idempotent: true,
        };
      }

      // At sessionRevision === reportFrontier the only valid path is the
      // idempotent duplicate (handled above). A first-ever freeze at revision 0
      // (reportFrontier 0, no attachments at all) is allowed to fall through.
      if (data.sessionRevision === sessionRow.reportFrontier) {
        const anyAttachment = tx
          .select({ id: experienceAttachments.id })
          .from(experienceAttachments)
          .where(eq(experienceAttachments.sessionId, data.sessionId))
          .limit(1)
          .get();
        if (sessionRow.reportFrontier !== 0 || anyAttachment) {
          return { ok: false, conflict: 'stale_freeze' };
        }
      }

      // Monotonic queueRevision derived from persisted history (all attachments).
      const maxQrRow = tx
        .select()
        .from(experienceAttachments)
        .where(eq(experienceAttachments.sessionId, data.sessionId))
        .orderBy(desc(experienceAttachments.queueRevision))
        .get();
      const nextQueueRevision = (maxQrRow?.queueRevision ?? 0) + 1;
      const now = this.clock.now();

      let attachmentId: string;
      if (existingUnbound) {
        // Replace the unbound row IN PLACE (same id) — "Add later events".
        attachmentId = existingUnbound.id;
        tx
          .update(experienceAttachments)
          .set({
            sessionRevision: data.sessionRevision,
            queueRevision: nextQueueRevision,
            kind: data.kind,
            publicEventsJson: data.publicEventsJson,
            hiddenStateCheckpointJson: data.hiddenStateCheckpointJson,
            rulesSourceHash: data.rulesSourceHash,
            visualSourceHash: data.visualSourceHash ?? null,
            updatedAt: now,
          })
          .where(eq(experienceAttachments.id, existingUnbound.id))
          .run();
      } else {
        // Insert a new queued attachment.
        attachmentId = this.idGen.next('xa');
        tx
          .insert(experienceAttachments)
          .values({
            id: attachmentId,
            chatId: data.chatId,
            branchId: data.branchId,
            sessionId: data.sessionId,
            sessionRevision: data.sessionRevision,
            queueRevision: nextQueueRevision,
            kind: data.kind,
            publicEventsJson: data.publicEventsJson,
            hiddenStateCheckpointJson: data.hiddenStateCheckpointJson,
            rulesSourceHash: data.rulesSourceHash,
            visualSourceHash: data.visualSourceHash ?? null,
            boundMessageId: null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }

      // Advance the report frontier in the SAME transaction.
      tx
        .update(experienceSessions)
        .set({ reportFrontier: data.sessionRevision, updatedAt: now })
        .where(eq(experienceSessions.id, data.sessionId))
        .run();

      const attachmentRow = tx
        .select()
        .from(experienceAttachments)
        .where(eq(experienceAttachments.id, attachmentId))
        .get();
      const updatedSession = tx
        .select()
        .from(experienceSessions)
        .where(eq(experienceSessions.id, data.sessionId))
        .get();

      return {
        ok: true,
        attachment: this.mapRowAttachment(attachmentRow!),
        session: this.mapRowSession(updatedSession!),
        idempotent: false,
      };
    });
  }

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

  /**
   * The session's current queued (unbound) attachment, or null. Selects
   * deterministically by highest queueRevision — at most one unbound row is
   * authoritative for a session, but a rollback-release can transiently expose
   * an older row, so the deterministic ordering resolves it to the newest
   * (which subsumes any older report).
   */
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
      .orderBy(desc(experienceAttachments.queueRevision))
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
   * Verify a queued attachment is still the row the client thinks it is, then
   * bind it to a committed user message — all synchronously inside the caller's
   * transaction (IR-51). This is the experience-attachment analogue of
   * {@link DiceRollStore.bindActiveAndResetInTx}: it runs AFTER the message row
   * exists (so the `bound_message_id` FK is satisfiable), verifies the
   * preconditions FIRST, and throws {@link ExperienceBindError} synchronously on
   * any mismatch so the SHARED transaction (the user-message insert included)
   * rolls back — no ghost message, no partial bind, no orphaned attachment.
   *
   * Preconditions (each a distinct error code so the UI can react):
   *  - `not_found`      — the attachment id does not exist.
   *  - `already_bound`   — the row is already bound to a message (re-send / replay).
   *  - `stale_queue`     — someone queued a newer report since the client last
   *                       saw this row (`queueRevision` advanced); the client is
   *                       binding an outdated snapshot.
   *  - `stale_session`   — the row's frozen `sessionRevision` differs from what
   *                       the client saw (the row was replaced / session reset).
   *
   * A frozen report is a historical snapshot, so an ADVANCING live session does
   * NOT invalidate a queued row — only a REPLACED row (different queueRevision /
   * sessionRevision on the stored row) fails. The client echoes back the two
   * revisions it saw; the server checks they match the stored row.
   */
  verifyAndBindAttachmentInTx(
    tx: DbTransaction,
    attachmentId: string,
    expectedQueueRevision: number,
    expectedSessionRevision: number,
    messageId: string,
  ): ExperienceAttachmentRow {
    const row = tx
      .select()
      .from(experienceAttachments)
      .where(eq(experienceAttachments.id, attachmentId))
      .get();
    if (!row) {
      throw new ExperienceBindError('not_found', `Experience attachment '${attachmentId}' was not found.`);
    }
    if (row.boundMessageId !== null) {
      throw new ExperienceBindError('already_bound', `Experience attachment '${attachmentId}' is already bound to message '${row.boundMessageId}'.`);
    }
    if (row.queueRevision !== expectedQueueRevision) {
      throw new ExperienceBindError(
        'stale_queue',
        `Experience attachment '${attachmentId}' queue revision mismatch: expected ${expectedQueueRevision}, stored ${row.queueRevision}.`,
      );
    }
    if (row.sessionRevision !== expectedSessionRevision) {
      throw new ExperienceBindError(
        'stale_session',
        `Experience attachment '${attachmentId}' session revision mismatch: expected ${expectedSessionRevision}, stored ${row.sessionRevision}.`,
      );
    }
    const now = this.clock.now();
    tx
      .update(experienceAttachments)
      .set({ boundMessageId: messageId, updatedAt: now })
      .where(eq(experienceAttachments.id, attachmentId))
      .run();
    const bound = tx
      .select()
      .from(experienceAttachments)
      .where(eq(experienceAttachments.id, attachmentId))
      .get();
    return this.mapRowAttachment(bound!);
  }

  /**
   * Release the message's bound attachment back to queued (boundMessageId →
   * NULL). Synchronous core for the compensating write path; the async wrapper
   * {@link rollbackReleaseAttachment} delegates here. Called when a user-message
   * insert is rolled back / the prepared turn fails assembly — the attachment
   * returns to pending-send.
   *
   * If a NEWER unbound report already exists for the session (because the user
   * froze a later report while this one was bound), the rolled-back attachment
   * is OBSOLETE — the newer report subsumes the older — so it is DELETED. If
   * only OLDER unbound rows exist, they are obsolete instead: delete them and
   * release the newer bound row. This leaves exactly one authoritative unbound
   * snapshot after the rollback. When no other queued row exists, the original
   * IR-51 behavior is preserved and the failed-send attachment returns to queued.
   */
  rollbackReleaseAttachmentInTx(tx: DbTransaction, messageId: string): void {
    const bound = tx
      .select()
      .from(experienceAttachments)
      .where(eq(experienceAttachments.boundMessageId, messageId))
      .all();
    for (const row of bound) {
      const unboundRows = tx
        .select()
        .from(experienceAttachments)
        .where(
          and(
            eq(experienceAttachments.sessionId, row.sessionId),
            isNull(experienceAttachments.boundMessageId),
          ),
        )
        .orderBy(desc(experienceAttachments.queueRevision))
        .all();
      const authoritativeUnbound = unboundRows[0];
      if (authoritativeUnbound && authoritativeUnbound.queueRevision > row.queueRevision) {
        // A newer queued snapshot subsumes both this failed-send row and every
        // older duplicate that may have been exposed by a legacy/fixture path.
        const obsoleteIds = [row.id, ...unboundRows.slice(1).map((candidate) => candidate.id)];
        tx.delete(experienceAttachments).where(inArray(experienceAttachments.id, obsoleteIds)).run();
      } else {
        // The failed-send row is newest. Remove any older/equal queued rows
        // before releasing it so the session still has exactly one queued row.
        if (unboundRows.length > 0) {
          tx
            .delete(experienceAttachments)
            .where(inArray(experienceAttachments.id, unboundRows.map((candidate) => candidate.id)))
            .run();
        }
        tx
          .update(experienceAttachments)
          .set({ boundMessageId: null })
          .where(eq(experienceAttachments.id, row.id))
          .run();
      }
    }
  }

  async rollbackReleaseAttachment(messageId: string): Promise<void> {
    this.db.transaction((tx) => this.rollbackReleaseAttachmentInTx(tx, messageId));
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
   * message/variant copy. Copied attachments get a fresh id, rebind to the
   * forked message, and land on `newBranchId` (the forked branch — NOT the
   * source branch, so the FK `branch_id → chat_branches` cascade and the
   * branchId query stay correct on the new branch); the immutable snapshot
   * (events, hidden checkpoint, source hashes, queue revision, session id) is
   * preserved verbatim. Unlike `DiceRollStore.forkCopyRollsInTx` (dice rolls
   * carry no branch_id), this core needs the new branch id because the
   * `experience_attachments.branch_id` column is real and FK-cascade-backed.
   */
  forkCopyAttachmentsInTx(tx: DbTransaction, msgIdMap: Map<string, string>, newBranchId: string): number {
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
      branchId: newBranchId,
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

/**
 * Thrown synchronously by {@link ExperienceStore.verifyAndBindAttachmentInTx}
 * when a queued attachment cannot be bound to a user message. Because the bind
 * runs inside the shared message-insert transaction, the throw rolls the whole
 * turn back (no ghost message). Mirrors {@link DiceBindError} (DICE-B10) so the
 * two atomic-send paths share a recognizable error shape. The `code` lets the
 * caller map to a precise client outcome (409 conflict vs 404 vs 422).
 */
export class ExperienceBindError extends Error {
  constructor(
    readonly code: 'not_found' | 'already_bound' | 'stale_queue' | 'stale_session',
    message: string,
  ) {
    super(message);
    this.name = 'ExperienceBindError';
  }
}
