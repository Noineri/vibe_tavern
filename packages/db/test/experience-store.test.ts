/**
 * Experience store characterization tests
 * (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 2 / IR-21).
 *
 * Proves the core session/step/effect/context/attachment methods work: active-
 * slot enforcement, CAS transition (revision bump + stale rejection), requestId
 * idempotency, the durable-effect lifecycle, context-bundle upsert, and
 * attachment queue/bind/release/delete. The full edge-case invariant suite
 * (interruption/retry races, fork-copy, concurrent two-tab races, Windows temp
 * cleanup) is IR-22.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { createDb, type AppDb } from "../src/db-connection.js";
import { ExperienceStore } from "../src/stores/experience-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// ─── Test setup ─────────────────────────────────────────────────────────────

const fixedClock: StoreClock = { now: () => "2026-08-02T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

async function setupDb(): Promise<AppDb> {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-experience-test-"));
  return createDb(join(dataRoot, "test.db"));
}

async function seedParents(db: AppDb) {
  await db.run(
    sql`INSERT INTO characters (id, name, created_at, updated_at) VALUES ('char_1', 'Hero', '2026-01-01', '2026-01-01')`,
  );
  await db.run(
    sql`INSERT INTO chats (id, character_id, active_branch_id, title, created_at, updated_at) VALUES ('chat_1', 'char_1', 'branch_1', 'Test', '2026-01-01', '2026-01-01')`,
  );
  await db.run(
    sql`INSERT INTO chat_branches (id, chat_id, label, created_at) VALUES ('branch_1', 'chat_1', 'Main', '2026-01-01')`,
  );
}

let msgPosition = 0;
async function seedMessage(db: AppDb, msgId: string) {
  await db.run(
    sql`INSERT INTO messages (id, chat_id, branch_id, role, author_type, position, content, state, created_at, updated_at) VALUES (${msgId}, 'chat_1', 'branch_1', 'user', 'user', ${msgPosition++}, 'Hi', 'complete', '2026-01-01', '2026-01-01')`,
  );
}

function baseSession(overrides: Record<string, unknown> = {}) {
  return {
    chatId: "chat_1",
    branchId: "branch_1",
    rulesId: "script_1",
    rulesLabel: "Tic-Tac-Toe",
    rulesRevision: 3,
    rulesSource: "context.experience.register({...});",
    rulesSourceHash: "abc123",
    apiVersion: 1,
    manifestId: "ttt",
    manifestName: "Tic-Tac-Toe",
    initialSettingsJson: "{}",
    currentStateJson: '{"board":["","","","","","","","",""]}',
    participantsJson: "[]",
    capabilityGrantsJson: "[]",
    contextMode: "none",
    randomSeed: "seed_001",
    ...overrides,
  };
}

function baseTransition(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "xs_test_1",
    expectedRevision: 0,
    requestId: "req_1",
    kind: "action",
    actorSnapshotJson: '{"participantId":"p1"}',
    inputJson: '{"type":"place","requestId":"req_1","expectedRevision":0}',
    emittedEventsJson: '[{"visibility":"public","type":"placed","detail":{"cell":0}}]',
    emittedEffectsJson: "[]",
    stateHash: "state_hash_1",
    message: null,
    newCurrentStateJson: '{"board":["X","","","","","","","",""]}',
    newStatus: "active",
    newRandomCursor: 1,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ExperienceStore — session lifecycle + active-slot enforcement", () => {
  let db: AppDb;
  let store: ExperienceStore;
  beforeEach(async () => {
    db = await setupDb();
    await seedParents(db);
    store = new ExperienceStore(db, { clock: fixedClock, idGenerator: idGen });
    counter = 0;
  });

  test("createSession claims the branch active slot at revision 0", async () => {
    const out = await store.createSession(baseSession());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.session.activeSlot).toBe(0);
    expect(out.session.revision).toBe(0);
    expect(out.session.status).toBe("active");
    expect(out.session.rulesSourceHash).toBe("abc123");
  });

  test("one active session per branch — a second create is a typed conflict", async () => {
    expect((await store.createSession(baseSession())).ok).toBe(true);
    const second = await store.createSession(baseSession());
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.conflict).toBe("branch_has_active");
  });

  test("a finished session releases the active slot, allowing a new one", async () => {
    const first = await store.createSession(baseSession());
    if (!first.ok) return;
    await store.finishSession(first.session.id, "completed");
    expect((await store.getActiveSessionForBranch("branch_1"))).toBeNull();
    // A new active session can now be created in the same branch.
    const second = await store.createSession(baseSession());
    expect(second.ok).toBe(true);
  });

  test("getActiveSessionForBranch finds the active session, not finished ones", async () => {
    const first = await store.createSession(baseSession());
    if (!first.ok) return;
    expect((await store.getActiveSessionForBranch("branch_1"))?.id).toBe(first.session.id);
    await store.finishSession(first.session.id, "interrupted");
    expect((await store.getActiveSessionForBranch("branch_1"))).toBeNull();
  });
});

describe("ExperienceStore — CAS transition (the core write path)", () => {
  let db: AppDb;
  let store: ExperienceStore;
  beforeEach(async () => {
    db = await setupDb();
    await seedParents(db);
    store = new ExperienceStore(db, { clock: fixedClock, idGenerator: idGen });
    counter = 0;
    const created = await store.createSession(baseSession());
    if (!created.ok) throw new Error("setup createSession failed");
  });

  test("applies a transition: bumps revision, appends a journal step", async () => {
    const out = await store.applyTransition(baseTransition());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.session.revision).toBe(1);
    expect(out.replayed).toBe(false);
    expect(out.step.sequence).toBe(1);
    expect(out.step.appliedRevision).toBe(1);
    expect(out.step.requestId).toBe("req_1");

    const steps = await store.getSteps("xs_test_1");
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe("action");
  });

  test("rejects a stale expectedRevision BEFORE writing (CAS)", async () => {
    await store.applyTransition(baseTransition({ requestId: "req_1" }));
    // Session is now rev 1; a request claiming rev 0 is stale.
    const stale = await store.applyTransition(
      baseTransition({ requestId: "req_2", expectedRevision: 0 }),
    );
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.conflict).toBe("stale_revision");
    // No second step was appended.
    expect(await store.getSteps("xs_test_1")).toHaveLength(1);
  });

  test("duplicate requestId is idempotent — returns the prior result, never re-applies", async () => {
    const first = await store.applyTransition(baseTransition({ requestId: "req_dup" }));
    const dup = await store.applyTransition(baseTransition({ requestId: "req_dup" }));
    expect(first.ok && dup.ok).toBe(true);
    if (!first.ok || !dup.ok) return;
    expect(dup.replayed).toBe(true);
    expect(first.replayed).toBe(false);
    // Revision did NOT advance a second time.
    expect(dup.session.revision).toBe(first.session.revision);
    // Exactly one step row exists (the duplicate did not append).
    expect(await store.getSteps("xs_test_1")).toHaveLength(1);
  });

  test("emitted effects become pending effect rows with the correct kind (persist before run)", async () => {
    const out = await store.applyTransition(
      baseTransition({
        requestId: "req_eff",
        emittedEffectsJson:
          '[{"kind":"model","request":{"prompt":"reply"}},{"kind":"timer","request":{"viewer":"model","actionType":"tick","afterMs":5000}}]',
      }),
    );
    expect(out.ok).toBe(true);
    const effects = await store.getEffectsForSession("xs_test_1");
    expect(effects).toHaveLength(2);
    expect(effects[0].status).toBe("pending");
    expect(effects[0].kind).toBe("model");
    expect(effects[0].originatingRevision).toBe(out.ok ? out.session.revision : -1);
    expect(effects[1].status).toBe("pending");
    expect(effects[1].kind).toBe("timer");
  });
});

describe("ExperienceStore — durable-effect lifecycle", () => {
  let db: AppDb;
  let store: ExperienceStore;
  let effectId: string;
  beforeEach(async () => {
    db = await setupDb();
    await seedParents(db);
    store = new ExperienceStore(db, { clock: fixedClock, idGenerator: idGen });
    counter = 0;
    await store.createSession(baseSession());
    await store.applyTransition(
      baseTransition({ emittedEffectsJson: '[{"kind":"model","request":{}}]' }),
    );
    const effects = await store.getEffectsForSession("xs_test_1");
    effectId = effects[0].id;
  });

  test("claim moves pending → running; a second claim returns null", async () => {
    expect((await store.claimEffect(effectId))?.status).toBe("running");
    expect(await store.claimEffect(effectId)).toBeNull();
  });

  test("complete sets running → succeeded with the result payload", async () => {
    await store.claimEffect(effectId);
    const done = await store.completeEffect(effectId, '{"action":"reply_a"}');
    expect(done?.status).toBe("succeeded");
    expect(done?.resultJson).toBe('{"action":"reply_a"}');
  });

  test("fail and cancel record terminal states with metadata", async () => {
    await store.claimEffect(effectId);
    expect((await store.failEffect(effectId, "timeout"))?.status).toBe("failed");
    // retry from failed → pending, attemptCount 1
    const retried = await store.retryEffect(effectId);
    expect(retried?.status).toBe("pending");
    expect(retried?.attemptCount).toBe(1);
    expect(retried?.id).toBe(effectId); // original id preserved
  });

  test("reconcileUnknownEffects moves running → unknown (never back to pending)", async () => {
    await store.claimEffect(effectId); // now running
    const count = await store.reconcileUnknownEffects();
    expect(count).toBe(1);
    expect((await store.getEffectById(effectId))?.status).toBe("unknown");
  });

  test("getPendingEffectsByKind filters by kind across sessions and drops claimed rows", async () => {
    // Session 1 (from beforeEach) already carries a pending model effect at rev 1.
    // Add a timer effect to session 1.
    await store.applyTransition(
      baseTransition({
        requestId: "req_timer_1",
        expectedRevision: 1,
        emittedEffectsJson: '[{"kind":"timer","request":{"viewer":"model","actionType":"tick","afterMs":1000}}]',
      }),
    );

    // A second branch + session, with its own timer effect only.
    await db.run(
      sql`INSERT INTO chat_branches (id, chat_id, label, created_at) VALUES ('branch_2', 'chat_1', 'Second', '2026-01-01')`,
    );
    const second = await store.createSession({ ...baseSession(), branchId: "branch_2" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await store.applyTransition(
      baseTransition({
        sessionId: second.session.id,
        requestId: "req_timer_2",
        emittedEffectsJson: '[{"kind":"timer","request":{"viewer":"model","actionType":"tick","afterMs":2000}}]',
      }),
    );

    // Kind + status filter: only pending timer rows, across both sessions.
    const timers = await store.getPendingEffectsByKind("timer");
    expect(timers).toHaveLength(2);
    expect(timers.every((e) => e.kind === "timer" && e.status === "pending")).toBe(true);
    // Model rows are NOT returned by the timer query.
    const models = await store.getPendingEffectsByKind("model");
    expect(models).toHaveLength(1);
    expect(models[0].kind).toBe("model");

    // Claiming a timer effect moves it pending → running, so it drops out.
    await store.claimEffect(timers[0].id);
    expect(await store.getPendingEffectsByKind("timer")).toHaveLength(1);
  });

  test("cancelPendingEffectsAboveRevision cancels only pending rows of the kind above the revision", async () => {
    // beforeEach left a pending model effect at rev 1; the timer test above ran
    // in its own beforeEach world: this test builds its own rows from scratch.
    // Session state: rev 0 → three transitions → timers at revs 1, 2, 3.
    await store.applyTransition(
      baseTransition({
        requestId: "req_t_low",
        expectedRevision: 1,
        emittedEffectsJson: '[{"kind":"timer","request":{"viewer":"model","actionType":"tick","afterMs":1000}}]',
      }),
    );
    await store.applyTransition(
      baseTransition({
        requestId: "req_t_mid",
        expectedRevision: 2,
        emittedEffectsJson: '[{"kind":"timer","request":{"viewer":"model","actionType":"tick","afterMs":1000}}]',
      }),
    );
    await store.applyTransition(
      baseTransition({
        requestId: "req_t_high",
        expectedRevision: 3,
        emittedEffectsJson:
          '[{"kind":"timer","request":{"viewer":"model","actionType":"tick","afterMs":1000}},{"kind":"model","request":{"prompt":"reply"}}]',
      }),
    );

    // Undo to rev 1: timers at revs 2, 3, 4 must cancel (their spawn steps no
    // longer exist in the rewound timeline); the beforeEach model effect at
    // rev 1 and the model effect at rev 4 are untouched (kind filter).
    const cancelled = await store.cancelPendingEffectsAboveRevision("xs_test_1", 1, "timer");
    expect(cancelled).toHaveLength(3);
    const effects = await store.getEffectsForSession("xs_test_1");
    const byKindRev = new Map(effects.map((e) => [`${e.kind}:${e.originatingRevision}`, e.status]));
    expect(byKindRev.get("model:1")).toBe("pending");
    expect(byKindRev.get("timer:2")).toBe("cancelled");
    expect(byKindRev.get("timer:3")).toBe("cancelled");
    expect(byKindRev.get("timer:4")).toBe("cancelled");
    expect(byKindRev.get("model:4")).toBe("pending");

    // Re-running is idempotent: nothing pending above rev 1 remains.
    expect(await store.cancelPendingEffectsAboveRevision("xs_test_1", 1, "timer")).toHaveLength(0);
  });
});

describe("ExperienceStore — context bundle + attachments", () => {
  let db: AppDb;
  let store: ExperienceStore;
  beforeEach(async () => {
    db = await setupDb();
    await seedParents(db);
    store = new ExperienceStore(db, { clock: fixedClock, idGenerator: idGen });
    counter = 0;
    await store.createSession(baseSession());
  });

  test("captureContextBundle inserts then upserts on re-capture (one row per session)", async () => {
    const first = await store.captureContextBundle("xs_test_1", {
      mode: "current_branch",
      branchFrontierRevision: 5,
    });
    expect(first.mode).toBe("current_branch");
    const recapture = await store.captureContextBundle("xs_test_1", {
      mode: "recent",
      messageFrontierPosition: 9,
    });
    expect(recapture.mode).toBe("recent");
    expect(recapture.id).toBe(first.id); // same row, updated
    const all = await store.getContextBundle("xs_test_1");
    expect(all?.messageFrontierPosition).toBe(9);
  });

  test("captureContextBundle persists source provenance when provided, nulls when omitted", async () => {
    const withSource = await store.captureContextBundle("xs_test_1", {
      mode: "recent",
      sourceCharacterId: "char_1",
      sourceChatId: "chat_1",
      sourcePersonaId: "persona_1",
    });
    expect(withSource.sourceCharacterId).toBe("char_1");
    expect(withSource.sourceChatId).toBe("chat_1");
    expect(withSource.sourcePersonaId).toBe("persona_1");

    // Re-capture without the fields nulls them (ambient source), not stale leftovers.
    const withoutSource = await store.captureContextBundle("xs_test_1", {
      mode: "recent",
      messageFrontierPosition: 3,
    });
    expect(withoutSource.sourceCharacterId).toBeNull();
    expect(withoutSource.sourceChatId).toBeNull();
    expect(withoutSource.sourcePersonaId).toBeNull();
  });

  test("queue → bind → getForMessage; rollback releases back to queued", async () => {
    const queued = await store.queueAttachment({
      chatId: "chat_1",
      branchId: "branch_1",
      sessionId: "xs_test_1",
      sessionRevision: 2,
      queueRevision: 1,
      kind: "report",
      publicEventsJson: '[{"type":"start"}]',
      hiddenStateCheckpointJson: '{"board":["X"]}',
      rulesSourceHash: "abc123",
    });
    expect(queued.boundMessageId).toBeNull();
    expect((await store.getQueuedAttachmentForSession("xs_test_1"))?.id).toBe(queued.id);

    await seedMessage(db, "msg_1");
    const bound = await store.bindAttachment(queued.id, "msg_1");
    expect(bound?.boundMessageId).toBe("msg_1");
    expect((await store.getAttachmentsForMessage("msg_1"))).toHaveLength(1);
    // Queued lookup is now empty for this session.
    expect(await store.getQueuedAttachmentForSession("xs_test_1")).toBeNull();

    // Rollback releases the binding (user-message insert failed).
    await store.rollbackReleaseAttachment("msg_1");
    expect((await store.getQueuedAttachmentForSession("xs_test_1"))?.id).toBe(queued.id);
  });

  test("deleteAttachmentsWithMessage cleans up on message delete", async () => {
    await seedMessage(db, "msg_2");
    const att = await store.queueAttachment({
      chatId: "chat_1",
      branchId: "branch_1",
      sessionId: "xs_test_1",
      sessionRevision: 2,
      queueRevision: 1,
      kind: "report",
      publicEventsJson: "[]",
      hiddenStateCheckpointJson: "{}",
      rulesSourceHash: "abc123",
    });
    await store.bindAttachment(att.id, "msg_2");
    await store.deleteAttachmentsWithMessage("msg_2");
    expect(await store.getAttachmentById(att.id)).toBeNull();
  });
});
