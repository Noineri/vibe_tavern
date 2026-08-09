/**
 * ExperienceStore — report-freeze queue core (IR-70B).
 * (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 7 backend prerequisite unit 2.)
 *
 * These tests pin the transactional replace-in-place queue semantics that the
 * report service (IR-70C) will call to freeze or explicitly replace the one
 * queued experience attachment while advancing the session report frontier
 * atomically. They exercise the REAL store against a real bun:sqlite DB — never
 * a narrowed pure-function substitute — so the synchronous transaction boundary
 * (insert-or-replace + frontier advance sharing ONE transaction, rejections
 * leaving zero partial writes) is the actual behavior under test.
 *
 * Invariants covered (one test each unless noted):
 *  - first freeze inserts a new queued row (queueRevision 1)
 *  - in-place explicit replacement ("Add later events") keeps the same id,
 *    advances queueRevision + sessionRevision + content
 *  - exact-duplicate freeze at the same frontier/content is idempotent (no bump)
 *  - monotonic queueRevision: a newly queued row after an earlier row was bound
 *    does not reset to 1
 *  - atomic frontier update (reportFrontier advances in the same transaction)
 *  - every rejection rolls back both row and frontier (no partial writes)
 *  - a client holding an old attachment id + old revisions receives stale_queue
 *    / stale_session through verifyAndBindAttachmentInTx after a replacement
 *  - getQueuedAttachmentForSession selects deterministically by highest queueRev
 *  - rollback-release collision with a newer queued snapshot preserves the newer
 *    and deletes the older (no two ambiguous unbound rows)
 *  - bound historical attachments are immutable (freezeReport never updates them)
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";

import { createDb, type AppDb } from "../src/db-connection.js";
import type { DbTransaction } from "../src/db-connection.js";
import * as schema from "../src/db-schema.js";
import { MessageStore } from "../src/stores/message-store.js";
import {
  ExperienceStore,
  ExperienceBindError,
  type FreezeReportData,
  type FreezeReportResult,
} from "../src/stores/experience-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// ─── Test setup ─────────────────────────────────────────────────────────────

const FIXED_NOW = "2026-08-02T00:00:00.000Z";

let clockTick = 0;
const testClock: StoreClock = {
  now() {
    clockTick += 1;
    return new Date(Date.parse(FIXED_NOW) + clockTick).toISOString();
  },
};

let idCounters: Map<string, number>;
const testIdGen: StoreIdGenerator = {
  next(prefix: string): string {
    const n = (idCounters.get(prefix) ?? 0) + 1;
    idCounters.set(prefix, n);
    return `${prefix}_70b_${String(n).padStart(4, "0")}`;
  },
};

let db: AppDb;
let messages: MessageStore;
let store: ExperienceStore;

beforeEach(async () => {
  clockTick = 0;
  idCounters = new Map();
  db = await createDb(":memory:");
  messages = new MessageStore(db, { clock: testClock, idGenerator: testIdGen });
  store = new ExperienceStore(db, { clock: testClock, idGenerator: testIdGen });

  db.insert(schema.characters).values({
    id: "char_1", name: "TestChar", description: "",
    alternateGreetingsJson: "[]", extensionsJson: "{}", tagsJson: "[]",
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
  db.insert(schema.personas).values({
    id: "persona_1", name: "Player", description: "",
    defaultForNewChats: 0, hasFileOnDisk: 0,
    createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
  db.insert(schema.chats).values({
    id: "chat_1", characterId: "char_1", personaId: "persona_1",
    activeBranchId: "branch_1", promptPresetId: null,
    title: "Freeze chat", summary: "", messageHistoryLimit: 0,
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
  db.insert(schema.chatBranches).values({
    id: "branch_1", chatId: "chat_1", parentBranchId: null,
    forkedFromMessageId: null, label: "main", createdAt: FIXED_NOW,
  }).run();
  db.insert(schema.chatBranches).values({
    id: "branch_2", chatId: "chat_1", parentBranchId: null,
    forkedFromMessageId: null, label: "alt", createdAt: FIXED_NOW,
  }).run();
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
    sessionId: "",
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

function freezeData(sessionId: string, sessionRevision: number, overrides: Partial<FreezeReportData> = {}): FreezeReportData {
  return {
    chatId: "chat_1",
    branchId: "branch_1",
    sessionId,
    sessionRevision,
    kind: "report",
    publicEventsJson: JSON.stringify({ title: "Report", summary: "round 1", events: [{ type: "move", detail: { cell: 0 } }] }),
    hiddenStateCheckpointJson: '{"board":["X","","","","","","","",""]}',
    rulesSourceHash: "hash_1",
    visualSourceHash: "vhash_1",
    ...overrides,
  };
}

/** Create an active session and advance it to `targetRevision` (0 = just created). */
async function seedSession(targetRevision: number): Promise<string> {
  const created = await store.createSession(baseSession({ currentStateJson: `{"rev":0}` }));
  if (!created.ok) throw new Error("seedSession createSession failed");
  const sessionId = created.session.id;
  for (let i = 0; i < targetRevision; i += 1) {
    const out = await store.applyTransition(
      baseTransition({
        sessionId,
        expectedRevision: i,
        requestId: `seed_req_${i}`,
        newCurrentStateJson: `{"rev":${i + 1}}`,
        newRandomCursor: i + 1,
      }),
    );
    if (!out.ok) throw new Error(`seedSession transition ${i} failed`);
  }
  return sessionId;
}

/** Bind an attachment to a new user message inside a real shared transaction. */
function bindInTx(attachmentId: string, queueRevision: number, sessionRevision: number): string {
  const baseInput = {
    chatId: "chat_1",
    branchId: "branch_1",
    role: "user" as const,
    authorType: "user" as const,
    content: "submit turn",
  };
  const { message } = messages.addMessageWithBind(baseInput, [
    (tx: DbTransaction, messageId: string) =>
      store.verifyAndBindAttachmentInTx(tx, attachmentId, queueRevision, sessionRevision, messageId),
  ]);
  return message.id;
}

/** Count attachment rows for a session (sync). */
function attachmentCount(sessionId: string): number {
  return db.select().from(schema.experienceAttachments).where(eq(schema.experienceAttachments.sessionId, sessionId)).all().length;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("IR-70B — freezeReport first freeze + in-place replacement", () => {
  test("first freeze inserts a new queued row at queueRevision 1 and advances the frontier", async () => {
    const sessionId = await seedSession(3);

    const result = store.freezeReport(freezeData(sessionId, 3));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.idempotent).toBe(false);
    expect(result.attachment.boundMessageId).toBeNull();
    expect(result.attachment.queueRevision).toBe(1);
    expect(result.attachment.sessionRevision).toBe(3);
    expect(result.session.reportFrontier).toBe(3);
    expect(attachmentCount(sessionId)).toBe(1);
  });

  test("in-place explicit replacement keeps the same id, advances queueRevision + content", async () => {
    const sessionId = await seedSession(5);
    const first = store.freezeReport(freezeData(sessionId, 3));
    if (!first.ok) throw new Error("first freeze failed");
    const firstId = first.attachment.id;

    // "Add later events": freeze a later report at a higher revision.
    const second = store.freezeReport(
      freezeData(sessionId, 5, {
        publicEventsJson: JSON.stringify({ title: "Report", summary: "round 2", events: [{ type: "move", detail: { cell: 1 } }] }),
        hiddenStateCheckpointJson: '{"board":["X","O","","","","","","",""]}',
      }),
    );

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.idempotent).toBe(false);
    expect(second.attachment.id).toBe(firstId); // SAME id — replaced in place
    expect(second.attachment.queueRevision).toBe(2); // advanced
    expect(second.attachment.sessionRevision).toBe(5);
    expect(second.session.reportFrontier).toBe(5);
    // Still exactly one row (no second row created).
    expect(attachmentCount(sessionId)).toBe(1);
  });

  test("first freeze at revision 0 (start report) is allowed", async () => {
    const sessionId = await seedSession(0);

    const result = store.freezeReport(freezeData(sessionId, 0, {
      publicEventsJson: JSON.stringify({ title: "Start", events: [] }),
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment.queueRevision).toBe(1);
    expect(result.attachment.sessionRevision).toBe(0);
    expect(result.session.reportFrontier).toBe(0);
  });
});

describe("IR-70B — exact-duplicate idempotency", () => {
  test("an exact duplicate freeze at the same frontier + content returns the current row without bumping", async () => {
    const sessionId = await seedSession(3);
    const data = freezeData(sessionId, 3);
    const first = store.freezeReport(data);
    if (!first.ok) throw new Error("first freeze failed");

    const dup = store.freezeReport(data);

    expect(dup.ok).toBe(true);
    if (!dup.ok) return;
    expect(dup.idempotent).toBe(true);
    expect(dup.attachment.id).toBe(first.attachment.id);
    expect(dup.attachment.queueRevision).toBe(first.attachment.queueRevision); // no bump
    expect(dup.attachment.sessionRevision).toBe(first.attachment.sessionRevision);
    expect(dup.session.reportFrontier).toBe(first.session.reportFrontier);
    expect(attachmentCount(sessionId)).toBe(1);
  });

  test("a content change at the same frontier is rejected as stale_freeze", async () => {
    const sessionId = await seedSession(3);
    store.freezeReport(freezeData(sessionId, 3));

    const stale = store.freezeReport(
      freezeData(sessionId, 3, { publicEventsJson: JSON.stringify({ events: [{ type: "other" }] }) }),
    );

    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.conflict).toBe("stale_freeze");
    // No partial writes: still one row, frontier unchanged.
    expect(attachmentCount(sessionId)).toBe(1);
  });
});

describe("IR-70B — monotonic queueRevision after a bound historical row", () => {
  test("a newly queued row after an earlier row was bound does not reset to 1", async () => {
    const sessionId = await seedSession(5);
    // First freeze → qr 1.
    const first = store.freezeReport(freezeData(sessionId, 3));
    if (!first.ok) throw new Error("first freeze failed");
    // Bind it (becomes historical / immutable).
    bindInTx(first.attachment.id, first.attachment.queueRevision, first.attachment.sessionRevision);
    // Second freeze at a higher revision → must be qr 2, NOT 1.
    const second = store.freezeReport(freezeData(sessionId, 5));

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.attachment.queueRevision).toBe(2);
    expect(second.attachment.sessionRevision).toBe(5);
    // Two rows now: the bound historical one + the new queued one.
    expect(attachmentCount(sessionId)).toBe(2);
  });

  test("replace-in-place after two bound rows continues the monotonic sequence", async () => {
    const sessionId = await seedSession(8);
    const a = store.freezeReport(freezeData(sessionId, 2));
    if (!a.ok) throw new Error("a failed");
    bindInTx(a.attachment.id, 1, 2);

    const b = store.freezeReport(freezeData(sessionId, 5));
    if (!b.ok) throw new Error("b failed");
    expect(b.attachment.queueRevision).toBe(2);
    bindInTx(b.attachment.id, 2, 5);

    // Third freeze (no unbound row) → qr 3.
    const c = store.freezeReport(freezeData(sessionId, 7));
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.attachment.queueRevision).toBe(3);

    // Replace-in-place at a HIGHER revision (session advanced) → qr 4 (not reset).
    const d = store.freezeReport(freezeData(sessionId, 8, {
      publicEventsJson: JSON.stringify({ events: [{ type: "final" }] }),
    }));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.attachment.queueRevision).toBe(4);
    expect(d.attachment.id).toBe(c.attachment.id);
  });
});

describe("IR-70B — atomic frontier update", () => {
  test("reportFrontier advances to the frozen revision in the same transaction", async () => {
    const sessionId = await seedSession(4);

    const result = store.freezeReport(freezeData(sessionId, 4));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.reportFrontier).toBe(4);
    // Re-read from the DB to confirm the write actually persisted.
    const fresh = await store.getSessionById(sessionId);
    expect(fresh?.reportFrontier).toBe(4);
  });

  test("reportFrontier never decreases across successive freezes", async () => {
    const sessionId = await seedSession(6);
    store.freezeReport(freezeData(sessionId, 2));
    store.freezeReport(freezeData(sessionId, 4, {
      publicEventsJson: JSON.stringify({ events: [{ type: "b" }] }),
    }));
    const last = store.freezeReport(freezeData(sessionId, 6, {
      publicEventsJson: JSON.stringify({ events: [{ type: "c" }] }),
    }));

    expect(last.ok).toBe(true);
    if (!last.ok) return;
    expect(last.session.reportFrontier).toBe(6);
  });
});

describe("IR-70B — every rejection rolls back both row and frontier (no partial writes)", () => {
  test("session_not_found: no writes", async () => {
    const before = db.select().from(schema.experienceAttachments).all().length;

    const result = store.freezeReport(freezeData("xs_nonexistent", 1));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflict).toBe("session_not_found");
    expect(db.select().from(schema.experienceAttachments).all().length).toBe(before);
  });

  test("scope_mismatch: wrong chatId/branchId — frontier unchanged, no row", async () => {
    const sessionId = await seedSession(3);
    const frontierBefore = (await store.getSessionById(sessionId))!.reportFrontier;
    const rowsBefore = attachmentCount(sessionId);

    const result = store.freezeReport(freezeData(sessionId, 3, { chatId: "chat_wrong", branchId: "branch_2" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflict).toBe("scope_mismatch");
    expect(attachmentCount(sessionId)).toBe(rowsBefore);
    expect((await store.getSessionById(sessionId))!.reportFrontier).toBe(frontierBefore);
  });

  test("frontier_beyond_revision: sessionRevision exceeds session.revision — no writes", async () => {
    const sessionId = await seedSession(2);
    const frontierBefore = (await store.getSessionById(sessionId))!.reportFrontier;
    const rowsBefore = attachmentCount(sessionId);

    const result = store.freezeReport(freezeData(sessionId, 5));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflict).toBe("frontier_beyond_revision");
    expect(attachmentCount(sessionId)).toBe(rowsBefore);
    expect((await store.getSessionById(sessionId))!.reportFrontier).toBe(frontierBefore);
  });

  test("frontier_regression: sessionRevision below current reportFrontier — no writes", async () => {
    const sessionId = await seedSession(6);
    // Establish frontier at 5.
    store.freezeReport(freezeData(sessionId, 5));
    const rowsAfterFirstFreeze = attachmentCount(sessionId);

    const result = store.freezeReport(freezeData(sessionId, 3, {
      publicEventsJson: JSON.stringify({ events: [{ type: "regressed" }] }),
    }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflict).toBe("frontier_regression");
    expect(attachmentCount(sessionId)).toBe(rowsAfterFirstFreeze);
    expect((await store.getSessionById(sessionId))!.reportFrontier).toBe(5);
  });

  test("stale_freeze: re-freezing an already-bound frontier with no unbound row — no writes", async () => {
    const sessionId = await seedSession(4);
    const first = store.freezeReport(freezeData(sessionId, 4));
    if (!first.ok) throw new Error("first freeze failed");
    // Bind the row so no unbound row remains.
    bindInTx(first.attachment.id, first.attachment.queueRevision, first.attachment.sessionRevision);
    const rowsBefore = attachmentCount(sessionId);

    const result = store.freezeReport(freezeData(sessionId, 4, {
      publicEventsJson: JSON.stringify({ events: [{ type: "dup" }] }),
    }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflict).toBe("stale_freeze");
    expect(attachmentCount(sessionId)).toBe(rowsBefore);
  });
});

describe("IR-70B — old client revision rejection after replacement", () => {
  test("a client holding old queueRevision receives stale_queue after in-place replacement", async () => {
    const sessionId = await seedSession(5);
    const first = store.freezeReport(freezeData(sessionId, 3));
    if (!first.ok) throw new Error("first freeze failed");
    const oldQueueRevision = first.attachment.queueRevision;
    const oldSessionRevision = first.attachment.sessionRevision;
    const attachmentId = first.attachment.id;

    // Replace in place: queueRevision advances to 2, sessionRevision to 5.
    store.freezeReport(freezeData(sessionId, 5, {
      publicEventsJson: JSON.stringify({ events: [{ type: "later" }] }),
      hiddenStateCheckpointJson: '{"board":["X","O","","","","","","",""]}',
    }));

    // A stale client still holds queueRevision 1 → stale_queue.
    expect(() => bindInTx(attachmentId, oldQueueRevision, 5)).toThrow(ExperienceBindError);
    try {
      bindInTx(attachmentId, oldQueueRevision, 5);
    } catch (e) {
      expect((e as ExperienceBindError).code).toBe("stale_queue");
    }
  });

  test("a client holding old sessionRevision receives stale_session after replacement", async () => {
    const sessionId = await seedSession(5);
    const first = store.freezeReport(freezeData(sessionId, 3));
    if (!first.ok) throw new Error("first freeze failed");
    const attachmentId = first.attachment.id;

    store.freezeReport(freezeData(sessionId, 5, {
      publicEventsJson: JSON.stringify({ events: [{ type: "later" }] }),
    }));

    // Client holds the NEW queueRevision (2) but the OLD sessionRevision (3).
    expect(() => bindInTx(attachmentId, 2, 3)).toThrow(ExperienceBindError);
    try {
      bindInTx(attachmentId, 2, 3);
    } catch (e) {
      expect((e as ExperienceBindError).code).toBe("stale_session");
    }
  });

  test("a client holding the CURRENT revisions binds successfully after replacement", async () => {
    const sessionId = await seedSession(5);
    const first = store.freezeReport(freezeData(sessionId, 3));
    if (!first.ok) throw new Error("first freeze failed");
    const attachmentId = first.attachment.id;

    const replaced = store.freezeReport(freezeData(sessionId, 5, {
      publicEventsJson: JSON.stringify({ events: [{ type: "later" }] }),
    }));
    if (!replaced.ok) throw new Error("replace failed");

    // Binding with the current revisions succeeds.
    const messageId = bindInTx(attachmentId, replaced.attachment.queueRevision, replaced.attachment.sessionRevision);
    const bound = await store.getAttachmentsForMessage(messageId);
    expect(bound).toHaveLength(1);
    expect(bound[0]!.id).toBe(attachmentId);
  });
});

describe("IR-70B — deterministic queued read", () => {
  test("getQueuedAttachmentForSession returns the highest-queueRevision unbound row", async () => {
    const sessionId = await seedSession(5);
    const first = store.freezeReport(freezeData(sessionId, 3));
    if (!first.ok) throw new Error("first freeze failed");
    bindInTx(first.attachment.id, 1, 3);

    // Freeze again → new row at qr 2 (the first was bound).
    const second = store.freezeReport(freezeData(sessionId, 5));
    if (!second.ok) throw new Error("second freeze failed");

    const queued = await store.getQueuedAttachmentForSession(sessionId);
    expect(queued?.id).toBe(second.attachment.id);
    expect(queued?.queueRevision).toBe(2);
  });

  test("getQueuedAttachmentForSession returns null when the only row is bound", async () => {
    const sessionId = await seedSession(3);
    const first = store.freezeReport(freezeData(sessionId, 3));
    if (!first.ok) throw new Error("first freeze failed");
    bindInTx(first.attachment.id, 1, 3);

    expect(await store.getQueuedAttachmentForSession(sessionId)).toBeNull();
  });
});

describe("IR-70B — rollback-release collision with a newer queued snapshot", () => {
  test("releasing an older bound row when a newer unbound row exists DELETES the older", async () => {
    const sessionId = await seedSession(5);
    // Freeze + bind (qr 1, sessionRevision 3).
    const first = store.freezeReport(freezeData(sessionId, 3));
    if (!first.ok) throw new Error("first freeze failed");
    const firstId = first.attachment.id;
    const messageId = bindInTx(first.attachment.id, 1, 3);

    // While bound, freeze a newer report (qr 2, sessionRevision 5) — inserts a new unbound row.
    const second = store.freezeReport(freezeData(sessionId, 5));
    if (!second.ok) throw new Error("second freeze failed");
    const secondId = second.attachment.id;

    // Two rows: one bound (qr 1), one unbound (qr 2).
    expect(attachmentCount(sessionId)).toBe(2);

    // The send of messageId failed → release. The bound row (qr 1) is OLDER than
    // the unbound row (qr 2), so it is DELETED (not re-queued), leaving one
    // authoritative unbound row.
    await store.rollbackReleaseAttachment(messageId);

    expect(await store.getAttachmentById(firstId)).toBeNull(); // deleted
    const queued = await store.getQueuedAttachmentForSession(sessionId);
    expect(queued?.id).toBe(secondId); // newer survives
    expect(queued?.queueRevision).toBe(2);
    expect(attachmentCount(sessionId)).toBe(1);
  });

  test("releasing a bound row when NO newer unbound row exists returns it to queued (IR-51 preserved)", async () => {
    const sessionId = await seedSession(3);
    const first = store.freezeReport(freezeData(sessionId, 3));
    if (!first.ok) throw new Error("first freeze failed");
    const firstId = first.attachment.id;
    const messageId = bindInTx(first.attachment.id, 1, 3);

    // No newer queued row exists → release returns to queued as before.
    await store.rollbackReleaseAttachment(messageId);

    const queued = await store.getQueuedAttachmentForSession(sessionId);
    expect(queued?.id).toBe(firstId);
    expect(queued?.boundMessageId).toBeNull();
    expect(attachmentCount(sessionId)).toBe(1);
  });

  test("releasing the NEWEST bound row deletes an older unbound row and keeps only the newer", async () => {
    const sessionId = await seedSession(5);
    const first = store.freezeReport(freezeData(sessionId, 3));
    if (!first.ok) throw new Error("first freeze failed");
    bindInTx(first.attachment.id, 1, 3);

    const second = store.freezeReport(freezeData(sessionId, 5));
    if (!second.ok) throw new Error("second freeze failed");
    const secondId = second.attachment.id;
    const newerMsg = bindInTx(secondId, 2, 5);

    // Reproduce the real inverse collision: a legacy/fixture path exposes an
    // OLDER unbound row while the NEWEST row is bound to the failed message.
    const olderQueued = await store.queueAttachment({
      chatId: "chat_1",
      branchId: "branch_1",
      sessionId,
      sessionRevision: 3,
      queueRevision: 1,
      kind: "report",
      publicEventsJson: JSON.stringify({ title: "Old", events: [] }),
      hiddenStateCheckpointJson: '{"board":["X"]}',
      rulesSourceHash: "hash_1",
      visualSourceHash: "vhash_1",
    });
    expect((await store.getQueuedAttachmentForSession(sessionId))?.id).toBe(olderQueued.id);

    await store.rollbackReleaseAttachment(newerMsg);

    // The newer failed-send snapshot is released; the older queued duplicate is
    // deleted so exactly one authoritative unbound row remains.
    expect(await store.getAttachmentById(olderQueued.id)).toBeNull();
    const queued = await store.getQueuedAttachmentForSession(sessionId);
    expect(queued?.id).toBe(secondId);
    expect(queued?.queueRevision).toBe(2);
    expect(attachmentCount(sessionId)).toBe(2); // first bound history + second queued
  });
});

describe("IR-70B — bound historical attachments are immutable", () => {
  test("freezeReport after a bind creates a NEW row and never modifies the bound one", async () => {
    const sessionId = await seedSession(5);
    const first = store.freezeReport(freezeData(sessionId, 3, {
      publicEventsJson: JSON.stringify({ title: "Original", events: [{ type: "a" }] }),
      hiddenStateCheckpointJson: '{"board":["X"]}',
    }));
    if (!first.ok) throw new Error("first freeze failed");
    const boundId = first.attachment.id;
    const originalEvents = first.attachment.publicEventsJson;
    const originalCheckpoint = first.attachment.hiddenStateCheckpointJson;

    bindInTx(boundId, 1, 3);

    // Freeze a later report (new row at qr 2).
    store.freezeReport(freezeData(sessionId, 5, {
      publicEventsJson: JSON.stringify({ title: "Updated", events: [{ type: "b" }] }),
      hiddenStateCheckpointJson: '{"board":["X","O"]}',
    }));

    // The bound historical row is byte-for-byte unchanged.
    const bound = await store.getAttachmentById(boundId);
    expect(bound).not.toBeNull();
    expect(bound!.publicEventsJson).toBe(originalEvents);
    expect(bound!.hiddenStateCheckpointJson).toBe(originalCheckpoint);
    expect(bound!.queueRevision).toBe(1);
    expect(bound!.sessionRevision).toBe(3);
  });

  test("a content-only difference at the same frontier does not mutate the bound row", async () => {
    const sessionId = await seedSession(3);
    const first = store.freezeReport(freezeData(sessionId, 3));
    if (!first.ok) throw new Error("first freeze failed");
    const boundId = first.attachment.id;
    bindInTx(boundId, 1, 3);

    // Attempting a stale freeze at the same frontier must NOT touch the bound row.
    store.freezeReport(freezeData(sessionId, 3, {
      publicEventsJson: JSON.stringify({ events: [{ type: "tamper" }] }),
    }));

    const bound = await store.getAttachmentById(boundId);
    expect(bound?.publicEventsJson).toBe(first.attachment.publicEventsJson);
    expect(bound?.queueRevision).toBe(1);
  });
});
