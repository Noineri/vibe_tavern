import { eq, and, inArray, asc, desc, sql, isNull } from 'drizzle-orm';
import { dicePendingLanes, diceRolls, messages } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

// ─── Return types ─────────────────────────────────────────────────────────────

export interface DicePendingLane {
  id: string;
  chatId: string;
  branchId: string;
  mode: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface DiceRoll {
  id: string;
  requestId: string;
  laneId: string;
  boundMessageId: string | null;
  actorType: string;
  actorId: string;
  actorLabel: string;
  scriptId: string;
  scriptLabel: string;
  scriptRevision: number;
  checkId: string;
  checkLabel: string;
  notation: string;
  faceShape: string;
  resolution: string;
  mode: string;
  included: boolean;
  finalAttemptId: string | null;
  attemptsJson: string;
  finalJson: string | null;
  retryReason: string | null;
  policy: string | null;
  createdAt: string;
}

export interface LaneState {
  revision: number;
  rolls: DiceRoll[];
}

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Dice roll persistence (DICE_SYSTEM_BACKEND_PLAN, Wave B3 / DICE-B7).
 *
 * Manages durable branch+mode lanes and immutable roll snapshots. Every
 * pending mutation increments the lane's monotonic revision. The store is
 * the AUTHORITY CORE for dice state — the service layer wraps it with
 * validation and actor resolution.
 */
export class DiceRollStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  // ─── Lane operations ─────────────────────────────────────────────────────

  /**
   * Get or create a durable lane for {chatId, branchId, mode}. The lane row
   * owns the monotonic revision even when empty — it exists from creation and
   * is never deleted (only reset, which bumps revision).
   */
  async getOrCreateLane(chatId: string, branchId: string, mode: string): Promise<DicePendingLane> {
    const existing = await this.db
      .select()
      .from(dicePendingLanes)
      .where(
        and(
          eq(dicePendingLanes.chatId, chatId),
          eq(dicePendingLanes.branchId, branchId),
          eq(dicePendingLanes.mode, mode),
        ),
      )
      .get();

    if (existing) return this.mapRowLane(existing);

    const id = this.idGen.next('dpl');
    const now = this.clock.now();
    await this.db
      .insert(dicePendingLanes)
      .values({
        id,
        chatId,
        branchId,
        mode,
        revision: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const row = await this.db
      .select()
      .from(dicePendingLanes)
      .where(eq(dicePendingLanes.id, id))
      .get();
    return this.mapRowLane(row!);
  }

  /**
   * List both lanes' pending state for a chat+branch. Returns both normal
   * and immersive lanes with their current revision and rolls.
   */
  async listPending(chatId: string, branchId: string): Promise<{ normal: LaneState; immersive: LaneState }> {
    const normal = await this.getOrCreateLane(chatId, branchId, 'normal');
    const immersive = await this.getOrCreateLane(chatId, branchId, 'immersive');

    const normalRolls = await this.getLaneRolls(normal.id);
    const immersiveRolls = await this.getLaneRolls(immersive.id);

    return {
      normal: { revision: normal.revision, rolls: normalRolls },
      immersive: { revision: immersive.revision, rolls: immersiveRolls },
    };
  }

  // ─── Roll creation ───────────────────────────────────────────────────────

  /**
   * Create a roll. Idempotent on requestId (DB unique = race net; duplicate
   * returns existing). The roll belongs to the lane for {chatId, branchId, mode}.
   */
  async createRoll(input: {
    chatId: string;
    branchId: string;
    mode: string;
    requestId: string;
    actorType: string;
    actorId: string;
    actorLabel: string;
    scriptId: string;
    scriptLabel: string;
    scriptRevision: number;
    checkId: string;
    checkLabel: string;
    notation: string;
    faceShape: string;
    resolution: string;
    attemptsJson: string;
    finalJson: string | null;
    retryReason?: string;
    policy?: string;
    finalAttemptId?: string | null;
  }): Promise<DiceRoll> {
    // Idempotency check — if a roll with this requestId already exists, return it.
    const existing = await this.db
      .select()
      .from(diceRolls)
      .where(eq(diceRolls.requestId, input.requestId))
      .get();
    if (existing) return this.mapRowRoll(existing);

    // Get or create the lane.
    const lane = await this.getOrCreateLane(input.chatId, input.branchId, input.mode);

    // Increment revision (every pending mutation increments).
    await this.bumpLaneRevision(lane.id);

    const id = this.idGen.next('dr');
    const now = this.clock.now();

    const [row] = await this.db
      .insert(diceRolls)
      .values({
        id,
        requestId: input.requestId,
        laneId: lane.id,
        boundMessageId: null,
        actorType: input.actorType,
        actorId: input.actorId,
        actorLabel: input.actorLabel,
        scriptId: input.scriptId,
        scriptLabel: input.scriptLabel,
        scriptRevision: input.scriptRevision,
        checkId: input.checkId,
        checkLabel: input.checkLabel,
        notation: input.notation,
        faceShape: input.faceShape,
        resolution: input.resolution,
        mode: input.mode,
        included: true,
        finalAttemptId: input.finalAttemptId ?? null,
        attemptsJson: input.attemptsJson,
        finalJson: input.finalJson,
        retryReason: input.retryReason ?? null,
        policy: input.policy ?? null,
        createdAt: now,
      })
      .returning();

    return this.mapRowRoll(row!);
  }

  // ─── Normal mode operations ──────────────────────────────────────────────

  /**
   * Replace a Normal pending roll for the same actor+check. If an existing
   * roll in the Normal lane matches the same actorType+actorId+scriptId+checkId
   * (and is not bound to a message), it is removed before the new one is created.
   * The lane revision is incremented.
   */
  async replaceNormalPending(input: {
    chatId: string;
    branchId: string;
    actorType: string;
    actorId: string;
    scriptId: string;
    checkId: string;
    requestId: string;
    actorLabel: string;
    scriptLabel: string;
    scriptRevision: number;
    checkLabel: string;
    notation: string;
    faceShape: string;
    resolution: string;
    attemptsJson: string;
    finalJson: string | null;
  }): Promise<DiceRoll> {
    const lane = await this.getOrCreateLane(input.chatId, input.branchId, 'normal');

    // Remove existing unbound roll for same actor+check in this lane.
    const existingRolls = await this.getLaneRolls(lane.id);
    for (const roll of existingRolls) {
      if (
        roll.boundMessageId === null &&
        roll.actorType === input.actorType &&
        roll.actorId === input.actorId &&
        roll.scriptId === input.scriptId &&
        roll.checkId === input.checkId
      ) {
        await this.db.delete(diceRolls).where(eq(diceRolls.id, roll.id)).run();
      }
    }

    // Create the new roll (this will bump the lane revision internally).
    return this.createRoll({
      chatId: input.chatId,
      branchId: input.branchId,
      mode: 'normal',
      requestId: input.requestId,
      actorType: input.actorType,
      actorId: input.actorId,
      actorLabel: input.actorLabel,
      scriptId: input.scriptId,
      scriptLabel: input.scriptLabel,
      scriptRevision: input.scriptRevision,
      checkId: input.checkId,
      checkLabel: input.checkLabel,
      notation: input.notation,
      faceShape: input.faceShape,
      resolution: input.resolution,
      attemptsJson: input.attemptsJson,
      finalJson: input.finalJson,
    });
  }

  /**
   * Remove one Normal pending roll by id. Only unbound rolls in the Normal
   * lane can be removed.
   */
  async removeRoll(rollId: string): Promise<void> {
    await this.db.delete(diceRolls).where(eq(diceRolls.id, rollId)).run();
  }

  /**
   * Clear the entire Normal lane — removes all unbound rolls.
   */
  async clearNormalLane(chatId: string, branchId: string): Promise<void> {
    const lane = await this.getOrCreateLane(chatId, branchId, 'normal');
    await this.db
      .delete(diceRolls)
      .where(
        and(
          eq(diceRolls.laneId, lane.id),
          isNull(diceRolls.boundMessageId),
        ),
      )
      .run();
    // Bump revision on clear.
    await this.bumpLaneRevision(lane.id);
  }

  // ─── Immersive mode operations ───────────────────────────────────────────

  /**
   * Compare-and-append an Immersive attempt. If the lane revision doesn't
   * match `expectedRevision`, returns a conflict (no write). If the grant
   * policy is satisfied, appends the attempt to the existing roll or creates
   * a new roll. Revision is always bumped on success.
   */
  async compareAndAppendAttempt(input: {
    chatId: string;
    branchId: string;
    expectedRevision: number;
    requestId: string;
    actorType: string;
    actorId: string;
    actorLabel: string;
    scriptId: string;
    scriptLabel: string;
    scriptRevision: number;
    checkId: string;
    checkLabel: string;
    notation: string;
    faceShape: string;
    resolution: string;
    existingRollId?: string;
    newAttemptJson: string;
    finalJson: string | null;
    retryReason?: string;
    policy?: string;
    finalAttemptId?: string | null;
  }): Promise<{ ok: true; roll: DiceRoll } | { ok: false; conflict: "stale_revision" }> {
    const lane = await this.getOrCreateLane(input.chatId, input.branchId, 'immersive');

    if (lane.revision !== input.expectedRevision) {
      return { ok: false, conflict: 'stale_revision' };
    }

    if (input.existingRollId) {
      // Append to existing roll's attempts.
      const existing = await this.db
        .select()
        .from(diceRolls)
        .where(eq(diceRolls.id, input.existingRollId))
        .get();
      if (!existing) {
        return { ok: false, conflict: 'stale_revision' };
      }

      const existingAttempts = JSON.parse(existing.attemptsJson) as unknown[];
      const newAttempt = JSON.parse(input.newAttemptJson);
      existingAttempts.push(newAttempt);

      await this.db
        .update(diceRolls)
        .set({
          attemptsJson: JSON.stringify(existingAttempts),
          finalJson: input.finalJson,
          finalAttemptId: input.finalAttemptId ?? existing.finalAttemptId,
          retryReason: input.retryReason ?? existing.retryReason,
          policy: input.policy ?? existing.policy,
        })
        .where(eq(diceRolls.id, input.existingRollId))
        .run();

      await this.bumpLaneRevision(lane.id);

      const updated = await this.db
        .select()
        .from(diceRolls)
        .where(eq(diceRolls.id, input.existingRollId))
        .get();
      return { ok: true, roll: this.mapRowRoll(updated!) };
    }

    // Create a new roll (which bumps revision internally).
    // Wrap the single attempt in an array for the roll's attemptsJson.
    const wrappedAttempts = `[${input.newAttemptJson}]`;
    const roll = await this.createRoll({
      chatId: input.chatId,
      branchId: input.branchId,
      mode: 'immersive',
      requestId: input.requestId,
      actorType: input.actorType,
      actorId: input.actorId,
      actorLabel: input.actorLabel,
      scriptId: input.scriptId,
      scriptLabel: input.scriptLabel,
      scriptRevision: input.scriptRevision,
      checkId: input.checkId,
      checkLabel: input.checkLabel,
      notation: input.notation,
      faceShape: input.faceShape,
      resolution: input.resolution,
      attemptsJson: wrappedAttempts,
      finalJson: input.finalJson,
      finalAttemptId: input.finalAttemptId,
      retryReason: input.retryReason,
      policy: input.policy,
    });

    return { ok: true, roll };
  }

  // ─── Include/exclude and choose ──────────────────────────────────────────

  /**
   * Set the included state of a roll (Immersive include/exclude from binding).
   */
  async setIncluded(rollId: string, included: boolean): Promise<void> {
    const roll = await this.db
      .select()
      .from(diceRolls)
      .where(eq(diceRolls.id, rollId))
      .get();
    if (!roll) return;

    await this.db
      .update(diceRolls)
      .set({ included })
      .where(eq(diceRolls.id, rollId))
      .run();

    // Bump the lane revision.
    await this.bumpLaneRevision(roll.laneId);
  }

  /**
   * Choose a final attempt for a choose-policy roll.
   */
  async chooseFinalAttempt(rollId: string, attemptId: string): Promise<void> {
    const roll = await this.db
      .select()
      .from(diceRolls)
      .where(eq(diceRolls.id, rollId))
      .get();
    if (!roll) return;

    // Mark the chosen attempt in the attempts array.
    const attempts = JSON.parse(roll.attemptsJson) as Array<Record<string, unknown>>;
    for (const a of attempts) {
      a.chosenFinal = a.attemptId === attemptId;
    }

    await this.db
      .update(diceRolls)
      .set({
        finalAttemptId: attemptId,
        attemptsJson: JSON.stringify(attempts),
      })
      .where(eq(diceRolls.id, rollId))
      .run();

    // Bump the lane revision.
    await this.bumpLaneRevision(roll.laneId);
  }

  // ─── Atomic bind + reset ─────────────────────────────────────────────────

  /**
   * Atomic bind: verify revision, bind included/finalized active-mode rows
   * to newMessageId, discard inactive-mode lane, reset BOTH lanes
   * (revision++). All in ONE transaction.
   *
   * Returns the number of rolls bound.
   */
  async bindActiveAndReset(
    chatId: string,
    branchId: string,
    mode: string,
    pendingRevision: number,
    newMessageId: string,
  ): Promise<number> {
    const activeMode = mode;
    const inactiveMode = mode === 'normal' ? 'immersive' : 'normal';

    return this.db.transaction(async (tx) => {
      // Verify the active lane's revision matches.
      const activeLane = await tx
        .select()
        .from(dicePendingLanes)
        .where(
          and(
            eq(dicePendingLanes.chatId, chatId),
            eq(dicePendingLanes.branchId, branchId),
            eq(dicePendingLanes.mode, activeMode),
          ),
        )
        .get();

      if (!activeLane || activeLane.revision !== pendingRevision) {
        throw new DiceBindError('stale_revision', `Expected revision ${pendingRevision}, got ${activeLane?.revision ?? 'none'}`);
      }

      // Bind included UNBOUND rolls in the active lane to the new message.
      const activeRolls = await tx
        .select()
        .from(diceRolls)
        .where(and(
          eq(diceRolls.laneId, activeLane.id),
          eq(diceRolls.included, true),
          isNull(diceRolls.boundMessageId),
        ))
        .all();

      let boundCount = 0;
      for (const roll of activeRolls) {
        // For choose-policy rolls, require a final choice.
        if (roll.policy === 'choose' && roll.finalAttemptId === null) {
          throw new DiceBindError('unresolved_choose', `Roll ${roll.id} has choose policy but no finalAttemptId`);
        }
        await tx
          .update(diceRolls)
          .set({ boundMessageId: newMessageId })
          .where(eq(diceRolls.id, roll.id))
          .run();
        boundCount++;
      }

      // Discard inactive lane's unbound rolls.
      const inactiveLane = await tx
        .select()
        .from(dicePendingLanes)
        .where(
          and(
            eq(dicePendingLanes.chatId, chatId),
            eq(dicePendingLanes.branchId, branchId),
            eq(dicePendingLanes.mode, inactiveMode),
          ),
        )
        .get();

      if (inactiveLane) {
        await tx
          .delete(diceRolls)
          .where(
            and(
              eq(diceRolls.laneId, inactiveLane.id),
              isNull(diceRolls.boundMessageId),
            ),
          )
          .run();
      }

      // Reset both lanes (revision++).
      const now = this.clock.now();
      await tx
        .update(dicePendingLanes)
        .set({ revision: activeLane.revision + 1, updatedAt: now })
        .where(eq(dicePendingLanes.id, activeLane.id))
        .run();

      if (inactiveLane) {
        await tx
          .update(dicePendingLanes)
          .set({ revision: inactiveLane.revision + 1, updatedAt: now })
          .where(eq(dicePendingLanes.id, inactiveLane.id))
          .run();
      }

      return boundCount;
    });
  }

  /**
   * Rollback release: set boundMessageId to null for all rolls bound to
   * this message. Called when prepareLiveTurn fails and the user-message
   * insert is rolled back — rolls go back to pending.
   */
  async rollbackRelease(newMessageId: string): Promise<void> {
    await this.db
      .update(diceRolls)
      .set({ boundMessageId: null })
      .where(eq(diceRolls.boundMessageId, newMessageId))
      .run();
  }

  // ─── Message lifecycle ───────────────────────────────────────────────────

  /**
   * Delete all rolls bound to a specific message. Used when a user message
   * is deleted from the chat.
   */
  async deleteRollsWithMessage(messageId: string): Promise<void> {
    await this.db
      .delete(diceRolls)
      .where(eq(diceRolls.boundMessageId, messageId))
      .run();
  }

  /**
   * Copy all rolls from one message to another (branch fork). The copied
   * rolls get new ids but preserve all snapshot data.
   */
  async forkCopyRolls(srcMessageId: string, dstMessageId: string): Promise<void> {
    const sourceRolls = await this.db
      .select()
      .from(diceRolls)
      .where(eq(diceRolls.boundMessageId, srcMessageId))
      .all();

    if (sourceRolls.length === 0) return;

    const now = this.clock.now();
    for (const src of sourceRolls) {
      await this.db
        .insert(diceRolls)
        .values({
          id: this.idGen.next('dr'),
          requestId: this.idGen.next('req'), // new idempotency key for the fork
          laneId: src.laneId,
          boundMessageId: dstMessageId,
          actorType: src.actorType,
          actorId: src.actorId,
          actorLabel: src.actorLabel,
          scriptId: src.scriptId,
          scriptLabel: src.scriptLabel,
          scriptRevision: src.scriptRevision,
          checkId: src.checkId,
          checkLabel: src.checkLabel,
          notation: src.notation,
          faceShape: src.faceShape,
          resolution: src.resolution,
          mode: src.mode,
          included: src.included,
          finalAttemptId: src.finalAttemptId,
          attemptsJson: src.attemptsJson,
          finalJson: src.finalJson,
          retryReason: src.retryReason,
          policy: src.policy,
          createdAt: now,
        })
        .run();
    }
  }

  // ─── Batch historical reads ──────────────────────────────────────────────

  /**
   * Get all rolls bound to a specific message (for the message read DTO
   * and prompt projection).
   */
  async getRollsForMessage(messageId: string): Promise<DiceRoll[]> {
    const rows = await this.db
      .select()
      .from(diceRolls)
      .where(eq(diceRolls.boundMessageId, messageId))
      .orderBy(asc(diceRolls.createdAt))
      .all();
    return rows.map((r) => this.mapRowRoll(r));
  }

  /**
   * Batch-load rolls for multiple messages (prompt projection). Returns a
   * map from messageId to its rolls.
   */
  async getRollsForMessages(messageIds: string[]): Promise<Map<string, DiceRoll[]>> {
    if (messageIds.length === 0) return new Map();

    const rows = await this.db
      .select()
      .from(diceRolls)
      .where(inArray(diceRolls.boundMessageId, messageIds))
      .orderBy(asc(diceRolls.createdAt))
      .all();

    const map = new Map<string, DiceRoll[]>();
    for (const row of rows) {
      if (!row.boundMessageId) continue;
      const list = map.get(row.boundMessageId);
      if (list) list.push(this.mapRowRoll(row));
      else map.set(row.boundMessageId, [this.mapRowRoll(row)]);
    }
    return map;
  }

  /**
   * Get a single roll by id.
   */
  async getRollById(rollId: string): Promise<DiceRoll | null> {
    const row = await this.db
      .select()
      .from(diceRolls)
      .where(eq(diceRolls.id, rollId))
      .get();
    return row ? this.mapRowRoll(row) : null;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async getLaneRolls(laneId: string): Promise<DiceRoll[]> {
    const rows = await this.db
      .select()
      .from(diceRolls)
      .where(eq(diceRolls.laneId, laneId))
      .orderBy(asc(diceRolls.createdAt))
      .all();
    return rows.map((r) => this.mapRowRoll(r));
  }

  private async bumpLaneRevision(laneId: string): Promise<void> {
    const now = this.clock.now();
    await this.db
      .update(dicePendingLanes)
      .set({
        revision: sql`${dicePendingLanes.revision} + 1`,
        updatedAt: now,
      })
      .where(eq(dicePendingLanes.id, laneId))
      .run();
  }

  private mapRowLane(row: typeof dicePendingLanes.$inferSelect): DicePendingLane {
    return {
      id: row.id,
      chatId: row.chatId,
      branchId: row.branchId,
      mode: row.mode,
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapRowRoll(row: typeof diceRolls.$inferSelect): DiceRoll {
    return {
      id: row.id,
      requestId: row.requestId,
      laneId: row.laneId,
      boundMessageId: row.boundMessageId,
      actorType: row.actorType,
      actorId: row.actorId,
      actorLabel: row.actorLabel,
      scriptId: row.scriptId,
      scriptLabel: row.scriptLabel,
      scriptRevision: row.scriptRevision,
      checkId: row.checkId,
      checkLabel: row.checkLabel,
      notation: row.notation,
      faceShape: row.faceShape,
      resolution: row.resolution,
      mode: row.mode,
      included: row.included,
      finalAttemptId: row.finalAttemptId,
      attemptsJson: row.attemptsJson,
      finalJson: row.finalJson,
      retryReason: row.retryReason,
      policy: row.policy,
      createdAt: row.createdAt,
    };
  }
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class DiceBindError extends Error {
  constructor(
    readonly code: 'stale_revision' | 'unresolved_choose',
    message: string,
  ) {
    super(message);
    this.name = 'DiceBindError';
  }
}
