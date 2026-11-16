/**
 * Experience store INVARIANT suite
 * (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 2 / IR-22).
 *
 * These tests behavior-pin the durable-storage edge cases that the IR-21
 * characterization tests only sampled: idempotency that returns the EXACT prior
 * transition (duplicate payload ignored), CAS serialization of concurrent
 * two-tab/stale-revision races, the "delayed model completion can never
 * overwrite newer session state" rule, persist-before-run + terminal-before-
 * continuation effect ordering, restart reconciliation, fork-copy attachment
 * integrity + transactional rollback, and message-delete cleanup ordering.
 *
 * They mirror the DiceRollStore fork/transaction suite (`:memory:` DB,
 * ChatStore.forkBranch sharing one synchronous bun:sqlite transaction with the
 * store's forkCopy core). Per the IR-22 self-check, this file runs beside
 * DiceRollStore + MessageStore transaction tests on Windows.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { createDb, type AppDb } from "../src/db-connection.js";
import * as schema from "../src/db-schema.js";

import { ChatStore } from "../src/stores/chat-store.js";
import { MessageStore } from "../src/stores/message-store.js";
import { ExperienceStore } from "../src/stores/experience-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// ─── Test setup ─────────────────────────────────────────────────────────────

const FIXED_NOW = "2026-08-02T00:00:00.000Z";

const fixedClock: StoreClock = { now: () => FIXED_NOW };
let idCounters: Map<string, number>;
const idGen: StoreIdGenerator = {
  next: (prefix) => {
    const n = (idCounters.get(prefix) ?? 0) + 1;
    idCounters.set(prefix, n);
    return `${prefix}_inv_${String(n).padStart(3, "0")}`;
  },
};

let db: AppDb;
let chatStore: ChatStore;
let messageStore: MessageStore;
let store: ExperienceStore;

function seedParents(targetDb: AppDb) {
  // FK parents: character → persona → chat + root branch.
  targetDb.insert(schema.characters).values({
    id: "char_1", name: "TestChar", description: "",
    alternateGreetingsJson: "[]", extensionsJson: "{}", tagsJson: "[]",
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
  targetDb.insert(schema.personas).values({
    id: "persona_1", name: "Player", description: "",
    defaultForNewChats: 0, hasFileOnDisk: 0,
    createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
  targetDb.insert(schema.chats).values({
    id: "chat_1", characterId: "char_1", personaId: "persona_1",
    activeBranchId: "branch_1", promptPresetId: null,
    title: "Inv chat", summary: "", messageHistoryLimit: 0,
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
  targetDb.insert(schema.chatBranches).values({
    id: "branch_1", chatId: "chat_1", parentBranchId: null,
    forkedFromMessageId: null, label: "main", createdAt: FIXED_NOW,
  }).run();
}

beforeEach(async () => {
  idCounters = new Map();
  db = await createDb(":memory:");
  chatStore = new ChatStore(db, { clock: fixedClock, idGenerator: idGen });
  messageStore = new MessageStore(db, { clock: fixedClock, idGenerator: idGen });
  store = new ExperienceStore(db, { clock: fixedClock, idGenerator: idGen });
  seedParents(db);
});

function baseSession(overrides: Record<string, unknown> = {}) {
  return {
    chatId: "chat_1",
    branchId: "branch_1",
    rulesId: "script_1",
    rulesLabel: "TTT",
    rulesRevision: 1,
    rulesSource: "register({})",
    rulesSourceHash: "hash_1",
    apiVersion: 1,
    manifestId: "ttt",
    manifestName: "Tic-Tac-Toe",
    initialSettingsJson: "{}",
    currentStateJson: '{"rev":0}',
    participantsJson: "[]",
    capabilityGrantsJson: "[]",
    contextMode: "none",
    randomSeed: "seed_001",
    ...overrides,
  };
}

function baseTransition(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "xs_inv_session",
    expectedRevision: 0,
    requestId: "req_1",
    kind: "action",
    actorSnapshotJson: '{"participantId":"p1"}',
    inputJson: "{}",
    emittedEventsJson: "[]",
    emittedEffectsJson: "[]",
    stateHash: "h",
    message: null,
    newCurrentStateJson: '{"rev":1}',
    newStatus: "active",
    newRandomCursor: 1,
    ...overrides,
  };
}

/** Create the session the base transitions target. */
/** Create the session the base transitions target (id is generated). */
async function seedSession() {
  const out = await store.createSession(baseSession({ currentStateJson: '{"rev":0}' }));
  if (!out.ok) throw new Error("seedSession failed");
  return out.session;
}

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe("IR-22 — idempotency: duplicate requestId returns the EXACT prior transition", () => {
  test("a duplicate is replayed: same step (seq + appliedRevision), revision does not advance", async () => {
    const s = await seedSession();
    const first = await store.applyTransition(baseTransition({ sessionId: s.id, requestId: "req_dup" }));
    expect(first.ok && !first.replayed).toBe(true);

    const dup = await store.applyTransition(baseTransition({ sessionId: s.id, requestId: "req_dup" }));
    expect(dup.ok && dup.replayed).toBe(true);
    if (!first.ok || !dup.ok) return;

    // The replayed step IS the original step — same sequence + appliedRevision.
    expect(dup.step.sequence).toBe(first.step.sequence);
    expect(dup.step.appliedRevision).toBe(first.step.appliedRevision);
    expect(dup.step.id).toBe(first.step.id);
    // Revision did not advance a second time.
    expect(dup.session.revision).toBe(first.session.revision);
    // Exactly one step row.
    expect(await store.getSteps(s.id)).toHaveLength(1);
  });

  test("the DUPLICATE's payload is ignored — only the original transition's state stands", async () => {
    const s = await seedSession();
    await store.applyTransition(
      baseTransition({ sessionId: s.id, requestId: "req_payload", newCurrentStateJson: '{"rev":1,"src":"original"}' }),
    );
    // A duplicate arrives carrying a DIFFERENT payload.
    const dup = await store.applyTransition(
      baseTransition({ sessionId: s.id, requestId: "req_payload", newCurrentStateJson: '{"rev":1,"src":"DUPLICATE"}' }),
    );
    expect(dup.ok && dup.replayed).toBe(true);
    if (!dup.ok) return;

    // Session state is still the ORIGINAL, never the duplicate's.
    expect(dup.session.currentStateJson).toBe('{"rev":1,"src":"original"}');
    const fresh = await store.getSessionById(s.id);
    expect(fresh?.currentStateJson).toBe('{"rev":1,"src":"original"}');
    // The replayed step is the original step (original state hash), not the duplicate's.
    expect(dup.step.stateHash).toBe("h");
  });

  test("a null requestId skips idempotency (anonymous system step) and always applies", async () => {
    const s = await seedSession();
    const a = await store.applyTransition(baseTransition({ sessionId: s.id, requestId: null }));
    const b = await store.applyTransition(baseTransition({ sessionId: s.id, requestId: null, expectedRevision: 1 }));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.session.revision).toBe(2);
    expect(await store.getSteps(s.id)).toHaveLength(2);
  });
});

// ─── CAS serialization (two-tab / stale-revision races) ─────────────────────

describe("IR-22 — CAS serializes concurrent transitions (no lost updates)", () => {
  test("two concurrent contenders claiming the same revision: exactly one commits with no lost updates", async () => {
    const s = await seedSession();
    const origGetSessionById = store.getSessionById.bind(store);

    // Coordinate BOTH contenders at the pre-transaction read (experience-store.ts:591)
    // so both observe revision 0 before either enters db.transaction(...).
    let arrived = 0;
    let releaseBarrier!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    store.getSessionById = async (id: string) => {
      const row = await origGetSessionById(id);
      arrived += 1;
      if (arrived === 1) {
        await bothRead;
      } else if (arrived === 2) {
        releaseBarrier();
      }
      return row;
    };

    try {
      const results = await Promise.allSettled([
        store.applyTransition(
          baseTransition({ sessionId: s.id, requestId: "req_a", expectedRevision: 0, newCurrentStateJson: '{"winner":"a"}' }),
        ),
        store.applyTransition(
          baseTransition({ sessionId: s.id, requestId: "req_b", expectedRevision: 0, newCurrentStateJson: '{"winner":"b"}' }),
        ),
      ]);

      const winners = results.filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof store.applyTransition>> & { ok: true }> =>
          r.status === "fulfilled" && r.value.ok,
      );
      expect(winners).toHaveLength(1);

      const loser = results.find((r) => r !== winners[0])!;
      if (loser.status === "fulfilled") {
        expect(loser.value).toEqual({ ok: false, conflict: "stale_revision" });
      } else {
        // Unique (session_id, sequence) index rolls back the losing tx atomically.
        expect(String(loser.reason)).toMatch(/UNIQUE constraint failed/i);
      }

      const winnerStep = winners[0].value.step;
      const winnerState = winners[0].value.session.currentStateJson;
      const steps = await store.getSteps(s.id);
      expect(steps).toHaveLength(1);
      expect(steps[0].requestId).toBe(winnerStep.requestId);
      const fresh = await origGetSessionById(s.id);
      expect(fresh?.revision).toBe(1);
      expect(fresh?.currentStateJson).toBe(winnerState);
    } finally {
      store.getSessionById = origGetSessionById;
    }

    // Subsequent sequential stale request still yields a clean typed conflict.
    const sequentialStale = await store.applyTransition(
      baseTransition({ sessionId: s.id, requestId: "req_late", expectedRevision: 0 }),
    );
    expect(sequentialStale).toEqual({ ok: false, conflict: "stale_revision" });
  });

  test("stale revision after DB close and reopen rejects without corrupting state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vt-xstore-inv-restart-"));
    const dbPath = join(dir, "restart.db");
    const firstDb = await createDb(dbPath);
    seedParents(firstDb);
    const firstStore = new ExperienceStore(firstDb, { clock: fixedClock, idGenerator: idGen });
    const created = await firstStore.createSession(baseSession({ currentStateJson: '{"rev":0}' }));
    if (!created.ok) throw new Error("createSession failed");

    await firstStore.applyTransition(baseTransition({ sessionId: created.session.id, requestId: "req_a" }));
    await firstStore.applyTransition(
      baseTransition({ sessionId: created.session.id, requestId: "req_b", expectedRevision: 1, newCurrentStateJson: '{"rev":2}' }),
    );
    firstDb.$client.close();

    // Real restart: reopen the SQLite file with a fresh ExperienceStore.
    const reopenedDb = await createDb(dbPath);
    const reopenedStore = new ExperienceStore(reopenedDb, { clock: fixedClock, idGenerator: idGen });

    const stale = await reopenedStore.applyTransition(
      baseTransition({ sessionId: created.session.id, requestId: "req_recovered", expectedRevision: 1 }),
    );
    expect(stale).toEqual({ ok: false, conflict: "stale_revision" });

    // Session intact at rev 2 with its real state; exactly two steps.
    const fresh = await reopenedStore.getSessionById(created.session.id);
    expect(fresh?.revision).toBe(2);
    expect(fresh?.currentStateJson).toBe('{"rev":2}');
    expect(await reopenedStore.getSteps(created.session.id)).toHaveLength(2);
  });
});

// ─── Delayed model completion can never overwrite session state ─────────────

describe("IR-22 — delayed effect completions never overwrite newer session state", () => {
  test("an effect claimed at rev 1 completes AFTER the session advanced to rev 2 — session keeps rev 2", async () => {
    const s = await seedSession();
    // Transition 1 emits one model effect; session → rev 1.
    const t1 = await store.applyTransition(
      baseTransition({
        sessionId: s.id,
        requestId: "req_1",
        emittedEffectsJson: '[{"kind":"model","request":{"prompt":"reply"}}]',
        newCurrentStateJson: '{"rev":1}',
      }),
    );
    expect(t1.ok).toBe(true);
    const effectsRev1 = await store.getEffectsForSession(s.id);
    expect(effectsRev1).toHaveLength(1);
    expect(effectsRev1[0].originatingRevision).toBe(1);
    const effectId = effectsRev1[0].id;

    // Transition 2 advances the session to rev 2 BEFORE the effect finishes.
    await store.applyTransition(
      baseTransition({
        sessionId: s.id,
        requestId: "req_2",
        expectedRevision: 1,
        newCurrentStateJson: '{"rev":2}',
        newRandomCursor: 2,
      }),
    );

    // Now the delayed model effect finally completes.
    await store.claimEffect(effectId); // pending → running
    const done = await store.completeEffect(effectId, '{"action":"model_reply"}');

    // The effect row records its OWN terminal result…
    expect(done?.status).toBe("succeeded");
    expect(done?.resultJson).toBe('{"action":"model_reply"}');
    expect(done?.originatingRevision).toBe(1); // still anchored to rev 1

    // …but the SESSION state is unchanged at rev 2 — the late completion did NOT
    // write its result into currentState, did NOT rewind revision, did NOT
    // advance randomCursor.
    const fresh = await store.getSessionById(s.id);
    expect(fresh?.revision).toBe(2);
    expect(fresh?.currentStateJson).toBe('{"rev":2}');
    expect(fresh?.randomCursor).toBe(2);
  });

  test("a transition + its pending effect roll back together on effect failure and commit together on success", async () => {
    const s = await seedSession();
    await db.run(sql.raw(`
      CREATE TRIGGER inject_effect_insert_fail
      BEFORE INSERT ON experience_effects
      BEGIN
        SELECT RAISE(ABORT, 'inject_effect_fail');
      END
    `));
    try {
      await expect(
        store.applyTransition(
          baseTransition({
            sessionId: s.id,
            requestId: "req_abort",
            emittedEffectsJson: '[{"kind":"model","request":{}}]',
            newCurrentStateJson: '{"rev":1,"aborted":true}',
          }),
        ),
      ).rejects.toThrow("inject_effect_fail");
      const rolledBack = await store.getSessionById(s.id);
      expect(rolledBack?.revision).toBe(0);
      expect(rolledBack?.currentStateJson).toBe('{"rev":0}');
      expect(await store.getSteps(s.id)).toHaveLength(0);
      expect(await store.getEffectsForSession(s.id)).toHaveLength(0);
    } finally {
      await db.run(sql.raw("DROP TRIGGER IF EXISTS inject_effect_insert_fail"));
    }

    const out = await store.applyTransition(
      baseTransition({
        sessionId: s.id,
        requestId: "req_eff",
        emittedEffectsJson: '[{"kind":"model","request":{}},{"kind":"model","request":{}}]',
        newCurrentStateJson: '{"rev":1}',
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // In the SAME committed state: revision advanced, a journal step exists, AND
    // both pending effect rows exist. There is no window where the step landed
    // but the effects did not (atomic).
    expect(out.session.revision).toBe(1);
    expect(await store.getSteps(s.id)).toHaveLength(1);
    const effects = await store.getEffectsForSession(s.id);
    expect(effects).toHaveLength(2);
    expect(effects.every((e) => e.status === "pending")).toBe(true);
    expect(effects.every((e) => e.originatingRevision === 1)).toBe(true);
  });
});

// ─── Effect lifecycle invariants ─────────────────────────────────────────────

describe("IR-22 — effect lifecycle: reconcile-on-restart, retry, cancellation", () => {
  test("restart reconciles running → unknown; retry moves unknown → pending (attempt tracked), session untouched", async () => {
    const s = await seedSession();
    await store.applyTransition(
      baseTransition({
        sessionId: s.id,
        requestId: "req_e",
        emittedEffectsJson: '[{"kind":"model","request":{}}]',
        newCurrentStateJson: '{"rev":1}',
      }),
    );
    const [eff] = await store.getEffectsForSession(s.id);
    await store.claimEffect(eff.id); // pending → running
    // Process dies mid-run; on restart the host reclaims orphans.
    const reclaimed = await store.reconcileUnknownEffects();
    expect(reclaimed).toBe(1);
    expect((await store.getEffectById(eff.id))?.status).toBe("unknown");

    // Manual retry (operator decision) returns it to pending, attempt counted.
    const retried = await store.retryEffect(eff.id);
    expect(retried?.status).toBe("pending");
    expect(retried?.attemptCount).toBe(1);
    expect(retried?.id).toBe(eff.id); // original id preserved across retry

    // The session's authoritative state was never touched by any effect op.
    const fresh = await store.getSessionById(s.id);
    expect(fresh?.revision).toBe(1);
  });

  test("a cancelled effect cannot be claimed and does not block the session", async () => {
    const s = await seedSession();
    await store.applyTransition(
      baseTransition({
        sessionId: s.id,
        requestId: "req_c",
        emittedEffectsJson: '[{"kind":"model","request":{}}]',
      }),
    );
    const [eff] = await store.getEffectsForSession(s.id);
    await store.claimEffect(eff.id);
    await store.cancelEffect(eff.id);
    expect((await store.getEffectById(eff.id))?.status).toBe("cancelled");
    expect(await store.claimEffect(eff.id)).toBeNull();
    expect(await store.getPendingEffectsByKind("model")).toEqual([]);

    // Another action proceeds normally — the cancelled effect did not block.
    const next = await store.applyTransition(
      baseTransition({ sessionId: s.id, requestId: "req_next", expectedRevision: 1, newCurrentStateJson: '{"rev":2}' }),
    );
    expect(next.ok && next.session.revision).toBe(2);
  });
});

// ─── Fork-copy attachment integrity + transactional rollback ────────────────

describe("IR-22 — fork-copy attachments: fresh id, rebound, snapshot preserved, atomic rollback", () => {
  test("forkBranch copies a bound attachment: fresh id, rebound to forked message, snapshot identical", async () => {
    const s = await seedSession();
    // A user message carrying a bound experience attachment.
    const userMsg = await messageStore.addMessage({
      chatId: "chat_1", branchId: "branch_1", role: "user", authorType: "user", content: "your turn",
    });
    const queued = await store.queueAttachment({
      chatId: "chat_1", branchId: "branch_1", sessionId: s.id, sessionRevision: 1, queueRevision: 1,
      kind: "report", publicEventsJson: '[{"type":"start"}]',
      hiddenStateCheckpointJson: '{"board":["X"]}', rulesSourceHash: "hash_1", visualSourceHash: "vhash_1",
    });
    await store.bindAttachment(queued.id, userMsg.id);

    // An assistant reply after it (also copied on fork, carries no attachment).
    const assistant = await messageStore.addMessage({
      chatId: "chat_1", branchId: "branch_1", role: "assistant", authorType: "assistant", content: "ok",
    });

    const forked = await chatStore.forkBranch(
      "chat_1", assistant.id, "xp fork",
      undefined,
      (tx, msgIdMap, newBranchId) => store.forkCopyAttachmentsInTx(tx, msgIdMap, newBranchId),
    );

    const forkedMsgs = await messageStore.getMessages(forked.id);
    const forkedUser = forkedMsgs.find((m) => m.role === "user")!;
    expect(forkedUser.id).not.toBe(userMsg.id);

    const forkedAtts = await store.getAttachmentsForMessage(forkedUser.id);
    expect(forkedAtts).toHaveLength(1);
    const copy = forkedAtts[0];
    // Fresh id, rebound to the FORKED message.
    expect(copy.id).not.toBe(queued.id);
    expect(copy.boundMessageId).toBe(forkedUser.id);
    // Immutable snapshot preserved verbatim.
    expect(copy.publicEventsJson).toBe('[{"type":"start"}]');
    expect(copy.hiddenStateCheckpointJson).toBe('{"board":["X"]}');
    expect(copy.rulesSourceHash).toBe("hash_1");
    expect(copy.visualSourceHash).toBe("vhash_1");
    expect(copy.queueRevision).toBe(1);
    expect(copy.sessionRevision).toBe(1);
    // Source attachment is untouched (still bound to the original message).
    const source = await store.getAttachmentById(queued.id);
    expect(source?.boundMessageId).toBe(userMsg.id);
  });

  test("the forkCopy tx core rolls back atomically with its caller (a throw leaves no orphan copies)", async () => {
    const s = await seedSession();
    const userMsg = await messageStore.addMessage({
      chatId: "chat_1", branchId: "branch_1", role: "user", authorType: "user", content: "x",
    });
    const queued = await store.queueAttachment({
      chatId: "chat_1", branchId: "branch_1", sessionId: s.id, sessionRevision: 1, queueRevision: 1,
      kind: "report", publicEventsJson: "[]", hiddenStateCheckpointJson: "{}", rulesSourceHash: "hash_1",
    });
    await store.bindAttachment(queued.id, userMsg.id);

    // A real target message (FK target) so the copy SUCCEEDS, then the caller
    // throws — proving the successful copy rolls back with the failing tx.
    const targetMsg = await messageStore.addMessage({
      chatId: "chat_1", branchId: "branch_1", role: "user", authorType: "user", content: "target",
    });
    expect(() =>
      db.transaction((tx) => {
        const n = store.forkCopyAttachmentsInTx(tx, new Map([[userMsg.id, targetMsg.id]]), "branch_1");
        expect(n).toBe(1); // the copy happened inside the tx…
        throw new Error("simulate caller failure");
      }),
    ).toThrow("simulate caller failure");

    // …but nothing persisted — no orphan copy bound to targetMsg.
    const rows = await store.getAttachmentsForMessage(targetMsg.id);
    expect(rows).toHaveLength(0);
    // Original survives.
    expect((await store.getAttachmentById(queued.id))?.boundMessageId).toBe(userMsg.id);
  });

  test("forkCopy is a no-op when there are no bound attachments on the forked messages", async () => {
    const s = await seedSession();
    const userMsg = await messageStore.addMessage({
      chatId: "chat_1", branchId: "branch_1", role: "user", authorType: "user", content: "clean",
    });
    const assistant = await messageStore.addMessage({
      chatId: "chat_1", branchId: "branch_1", role: "assistant", authorType: "assistant", content: "ok",
    });
    const forked = await chatStore.forkBranch(
      "chat_1", assistant.id, "noatt",
      undefined,
      (tx, msgIdMap, newBranchId) => store.forkCopyAttachmentsInTx(tx, msgIdMap, newBranchId),
    );
    const forkedMsgs = await messageStore.getMessages(forked.id);
    expect(forkedMsgs.map((m) => ({ role: m.role, content: m.content }))).toEqual([
      { role: "user", content: "clean" },
      { role: "assistant", content: "ok" },
    ]);
    expect(forkedMsgs.map((m) => m.id)).not.toContain(userMsg.id);
    for (const m of forkedMsgs) {
      expect(await store.getAttachmentsForMessage(m.id)).toHaveLength(0);
    }
    void s;
  });
});

// ─── Message-delete cleanup ordering ────────────────────────────────────────

describe("IR-22 — message-delete cleanup ordering", () => {
  test("deleteAttachmentsWithMessage removes the bound attachment; a no-attachment message is a safe no-op", async () => {
    const s = await seedSession();
    const withAtt = await messageStore.addMessage({
      chatId: "chat_1", branchId: "branch_1", role: "user", authorType: "user", content: "a",
    });
    const queued = await store.queueAttachment({
      chatId: "chat_1", branchId: "branch_1", sessionId: s.id, sessionRevision: 1, queueRevision: 1,
      kind: "report", publicEventsJson: "[]", hiddenStateCheckpointJson: "{}", rulesSourceHash: "hash_1",
    });
    await store.bindAttachment(queued.id, withAtt.id);
    expect(await store.getAttachmentsForMessage(withAtt.id)).toHaveLength(1);

    await store.deleteAttachmentsWithMessage(withAtt.id);
    expect(await store.getAttachmentById(queued.id)).toBeNull();
    expect(await store.getAttachmentsForMessage(withAtt.id)).toHaveLength(0);

    // A message with no attachment deletes cleanly (no throw).
    const bare = await messageStore.addMessage({
      chatId: "chat_1", branchId: "branch_1", role: "user", authorType: "user", content: "b",
    });
    await expect(store.deleteAttachmentsWithMessage(bare.id)).resolves.toBeUndefined();
  });

  test("rollbackReleaseAttachment returns ONLY the rolled-back message's attachment to queued", async () => {
    const s = await seedSession();
    const rolledBack = await messageStore.addMessage({
      chatId: "chat_1", branchId: "branch_1", role: "user", authorType: "user", content: "r",
    });
    const kept = await messageStore.addMessage({
      chatId: "chat_1", branchId: "branch_1", role: "user", authorType: "user", content: "k",
    });
    const a = await store.queueAttachment({
      chatId: "chat_1", branchId: "branch_1", sessionId: s.id, sessionRevision: 1, queueRevision: 1,
      kind: "report", publicEventsJson: "[]", hiddenStateCheckpointJson: "{}", rulesSourceHash: "hash_1",
    });
    const b = await store.queueAttachment({
      chatId: "chat_1", branchId: "branch_1", sessionId: s.id, sessionRevision: 1, queueRevision: 1,
      kind: "report", publicEventsJson: "[]", hiddenStateCheckpointJson: "{}", rulesSourceHash: "hash_1",
    });
    await store.bindAttachment(a.id, rolledBack.id);
    await store.bindAttachment(b.id, kept.id);

    // The rolled-back message's insert failed → release only that one.
    await store.rollbackReleaseAttachment(rolledBack.id);
    expect((await store.getAttachmentById(a.id))?.boundMessageId).toBeNull();
    expect((await store.getAttachmentById(b.id))?.boundMessageId).toBe(kept.id);
    // The released one is queryable as queued-for-its-session again.
    expect((await store.getQueuedAttachmentForSession(s.id))?.id).toBe(a.id);
  });
});

// ─── Active-slot invariant across branches ──────────────────────────────────

describe("IR-22 — active-slot invariant: per-branch, not global", () => {
  test("two branches of the same chat each hold one active session", async () => {
    db.insert(schema.chatBranches).values({
      id: "branch_2", chatId: "chat_1", parentBranchId: null,
      forkedFromMessageId: null, label: "alt", createdAt: FIXED_NOW,
    }).run();

    const a = await store.createSession(baseSession({ branchId: "branch_1" }));
    const b = await store.createSession(baseSession({ branchId: "branch_2" }));
    expect(a.ok && b.ok).toBe(true);

    expect((await store.getActiveSessionForBranch("branch_1"))?.id).toBe(a.ok ? a.session.id : null);
    expect((await store.getActiveSessionForBranch("branch_2"))?.id).toBe(b.ok ? b.session.id : null);

    // A second active in branch_1 is still a conflict, independent of branch_2.
    const c = await store.createSession(baseSession({ branchId: "branch_1" }));
    expect(c.ok).toBe(false);
  });
});
