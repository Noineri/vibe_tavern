import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";

import { createDb, type AppDb } from "../src/db-connection.js";
import * as schema from "../src/db-schema.js";
import { MessageStore } from "../src/stores/message-store.js";
import { DiceRollStore, DiceBindError } from "../src/stores/dice-roll-store.js";
import { ExperienceStore, ExperienceBindError } from "../src/stores/experience-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";
import type { DbTransaction } from "../src/db-connection.js";

// IR-51 (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 5 unit 1): the atomic
// send-binding reasoning core for experience attachments — the direct analogue
// of DICE-B10's dice-atomic-send.test.ts. These tests pin the SAME boundary the
// user-turn commit uses: `MessageStore.addMessageWithBind` sharing ONE
// synchronous bun:sqlite transaction with `ExperienceStore.verifyAndBindAttachmentInTx`
// (and, in the combined case, with `DiceRollStore.bindActiveAndResetInTx` too).
// They cover every self-check case in the unit's Required result, plus a
// characterization of the unchanged no-bind `addMessage` path.
//
// The transaction mechanism is load-bearing and IDENTICAL to the Dice path:
// drizzle-orm 0.38.4 + bun-sqlite only rolls back SYNCHRONOUS transaction
// callbacks (an `await` inside suspends past the native commit), so a stale
// queue/session revision or an already-bound throw must roll the user-message
// insert back too — no ghost message, no partial bind. See dice-atomic-send for
// the full mechanism note; this file deliberately mirrors its structure.
//
// Note on awaits: the experience store's CREATE methods are async, so they are
// awaited. The atomic commit itself — `addMessageWithBind` +
// `verifyAndBindAttachmentInTx` — is SYNCHRONOUS (no `await` inside; that is the
// whole point), so it is called without await.

// ─── Test harness ────────────────────────────────────────────────────────────

const FIXED_NOW = "2026-07-21T00:00:00.000Z";
let clockTick = 0;
const testClock: StoreClock = {
  now() {
    clockTick++;
    return new Date(Date.parse(FIXED_NOW) + clockTick).toISOString();
  },
};

let idCounters: Map<string, number>;
const testIdGen: StoreIdGenerator = {
  next(prefix: string): string {
    const n = (idCounters.get(prefix) ?? 0) + 1;
    idCounters.set(prefix, n);
    return `${prefix}_b10_${String(n).padStart(4, "0")}`;
  },
};

type Db = Awaited<ReturnType<typeof createDb>>;

/** Minimum FK parents: character → chat (two branches). ExperienceStore needs
 *  an active session on the branch before an attachment can be queued. */
function bootstrap(db: Db) {
  db.insert(schema.characters).values({
    id: "char_1", name: "TestChar", description: "",
    alternateGreetingsJson: "[]", extensionsJson: "{}", tagsJson: "[]",
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
  db.insert(schema.chats).values({
    id: "chat_1", characterId: "char_1", personaId: null,
    activeBranchId: "brnch_1", promptPresetId: null,
    title: "Test chat", summary: "", messageHistoryLimit: 0,
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
  db.insert(schema.chatBranches).values({
    id: "brnch_1", chatId: "chat_1", parentBranchId: null,
    forkedFromMessageId: null, label: "main", createdAt: FIXED_NOW,
  }).run();
  db.insert(schema.chatBranches).values({
    id: "brnch_2", chatId: "chat_1", parentBranchId: null,
    forkedFromMessageId: null, label: "alt", createdAt: FIXED_NOW,
  }).run();
}

/** Minimal session factory mirroring experience-store.test.ts's baseSession. */
function baseSession() {
  return {
    chatId: "chat_1",
    branchId: "brnch_1",
    rulesId: "script_1",
    rulesLabel: "Tic-Tac-Toe",
    rulesRevision: 3,
    rulesSource: "context.experience.register({ create(){}, reduce(){} });",
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
  } as const;
}

function rollInput(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req_default",
    actorType: "persona",
    actorId: "persona_1",
    actorLabel: "Player",
    scriptId: "script_1",
    scriptLabel: "Fate Die",
    scriptRevision: 12345,
    checkId: "fate_check",
    checkLabel: "Fate Roll",
    notation: "4dF",
    faceShape: "dF",
    resolution: "narrative",
    mode: "normal",
    attemptsJson: JSON.stringify([
      { attemptId: "attempt_1", faces: [1, 0, -1, 1], modifier: 0, subtotal: 1, total: 1 },
    ]),
    finalJson: null,
    ...overrides,
  };
}

let db: Db;
let messages: MessageStore;
let dice: DiceRollStore;
let experiences: ExperienceStore;

beforeEach(async () => {
  db = await createDb(":memory:");
  bootstrap(db);
  clockTick = 0;
  idCounters = new Map();
  messages = new MessageStore(db, { clock: testClock, idGenerator: testIdGen });
  dice = new DiceRollStore(db, { clock: testClock, idGenerator: testIdGen });
  experiences = new ExperienceStore(db, { clock: testClock, idGenerator: testIdGen });
});

/** Count messages in a branch (sync, on the shared connection). */
function branchMessageCount(branchId: string): number {
  return db.select().from(schema.messages).where(eq(schema.messages.branchId, branchId)).all().length;
}

/** Seed an active session on brnch_1 and return its id (queueAttachment FK). */
async function seedSession(): Promise<string> {
  const created = await experiences.createSession(baseSession());
  if (!created.ok) throw new Error("setup createSession failed");
  return created.session.id;
}

/** Queue an attachment at queueRevision=1, sessionRevision=2 and return it. */
async function seedQueued(sessionId: string, overrides: { queueRevision?: number; sessionRevision?: number } = {}) {
  return experiences.queueAttachment({
    chatId: "chat_1",
    branchId: "brnch_1",
    sessionId,
    sessionRevision: overrides.sessionRevision ?? 2,
    queueRevision: overrides.queueRevision ?? 1,
    kind: "report",
    publicEventsJson: '[{"type":"round","summary":"X moved"}]',
    hiddenStateCheckpointJson: '{"board":["X","",""]}',
    rulesSourceHash: "abc123",
  });
}

/** A synchronous experience bind hook — exactly what
 *  ChatApplicationService.appendUserMessage passes to addMessageWithBind. */
function experienceBindHook(attachmentId: string, queueRevision: number, sessionRevision: number) {
  return (tx: DbTransaction, messageId: string) =>
    experiences.verifyAndBindAttachmentInTx(tx, attachmentId, queueRevision, sessionRevision, messageId);
}

/** A synchronous dice bind hook — see dice-atomic-send.test.ts. */
function diceBindHook(mode: "normal" | "immersive", pendingRevision: number) {
  return (tx: DbTransaction, messageId: string) =>
    dice.bindActiveAndResetInTx(tx, "chat_1", "brnch_1", mode, pendingRevision, messageId);
}

const baseInput = {
  chatId: "chat_1",
  branchId: "brnch_1",
  role: "user",
  authorType: "user",
  content: "submit turn",
};

// ─── Characterization: no-bind addMessage is unchanged ───────────────────────

describe("IR-51 atomic send binding — characterization (no-experience unchanged)", () => {
  test("addMessage (no bind) inserts message + variant and returns the message, no attachment query", async () => {
    const sessionId = await seedSession();
    await seedQueued(sessionId); // a queued attachment exists but is not referenced
    const before = branchMessageCount("brnch_1");

    const message = await messages.addMessage(baseInput);

    expect(branchMessageCount("brnch_1")).toBe(before + 1);
    expect(message.role).toBe("user");
    // The queued attachment was NOT touched by a plain send.
    const queued = await experiences.getQueuedAttachmentForSession(sessionId);
    expect(queued).not.toBeNull();
    expect(queued!.boundMessageId).toBeNull();
  });

  test("addMessageWithBind with an empty hook list commits the message and binds nothing", () => {
    const { message } = messages.addMessageWithBind(baseInput, []);
    expect(branchMessageCount("brnch_1")).toBe(1);
    expect(message.content).toBe("submit turn");
  });
});

// ─── Invariants ──────────────────────────────────────────────────────────────

describe("IR-51 atomic send binding — invariants", () => {
  test("successful experience bind commits the message AND binds the attachment in one transaction", async () => {
    const sessionId = await seedSession();
    const queued = await seedQueued(sessionId);

    const { message } = messages.addMessageWithBind(baseInput, [
      experienceBindHook(queued.id, queued.queueRevision, queued.sessionRevision),
    ]);

    expect(branchMessageCount("brnch_1")).toBe(1);
    // The attachment is now bound to the new message.
    const bound = await experiences.getAttachmentsForMessage(message.id);
    expect(bound).toHaveLength(1);
    expect(bound[0]!.id).toBe(queued.id);
    expect(bound[0]!.boundMessageId).toBe(message.id);
    // The queued (unbound) slot is empty for this session now.
    expect(await experiences.getQueuedAttachmentForSession(sessionId)).toBeNull();
  });

  test("combined Dice + Experience bind: both binds commit atomically in ONE transaction", async () => {
    const sessionId = await seedSession();
    const queued = await seedQueued(sessionId);
    // Seed a pending Dice roll on the same branch (DICE-B10 contract).
    await dice.createRoll({ chatId: "chat_1", branchId: "brnch_1", mode: "normal", ...rollInput({ requestId: "req_combo" }) });

    const { message } = messages.addMessageWithBind(baseInput, [
      diceBindHook("normal", 1),
      experienceBindHook(queued.id, queued.queueRevision, queued.sessionRevision),
    ]);

    // ONE message inserted, BOTH binds applied.
    expect(branchMessageCount("brnch_1")).toBe(1);
    const boundRolls = await dice.getRollsForMessage(message.id);
    expect(boundRolls).toHaveLength(1);
    expect(boundRolls[0]!.boundMessageId).toBe(message.id);
    const boundAtt = await experiences.getAttachmentsForMessage(message.id);
    expect(boundAtt).toHaveLength(1);
    expect(boundAtt[0]!.id).toBe(queued.id);
    // Both lanes reset / emptied.
    const pending = await dice.listPending("chat_1", "brnch_1");
    expect(pending.normal.rolls.filter((r) => r.boundMessageId === null).length).toBe(0);
    expect(await experiences.getQueuedAttachmentForSession(sessionId)).toBeNull();
  });

  test("stale queue revision inserts NOTHING (no ghost message, attachment stays queued)", async () => {
    const sessionId = await seedSession();
    const queued = await seedQueued(sessionId); // queueRevision=1
    const before = branchMessageCount("brnch_1");

    // Client sends queueRevision=99 (someone queued a newer report since).
    expect(() =>
      messages.addMessageWithBind(baseInput, [experienceBindHook(queued.id, 99, queued.sessionRevision)]),
    ).toThrow(ExperienceBindError);

    expect(branchMessageCount("brnch_1")).toBe(before); // NOTHING inserted
    const stillQueued = await experiences.getQueuedAttachmentForSession(sessionId);
    expect(stillQueued?.id).toBe(queued.id);
    expect(stillQueued?.boundMessageId).toBeNull(); // still queued, unbound
  });

  test("stale session revision inserts NOTHING", async () => {
    const sessionId = await seedSession();
    const queued = await seedQueued(sessionId); // sessionRevision=2
    const before = branchMessageCount("brnch_1");

    expect(() =>
      messages.addMessageWithBind(baseInput, [experienceBindHook(queued.id, queued.queueRevision, 777)]),
    ).toThrow(ExperienceBindError);

    expect(branchMessageCount("brnch_1")).toBe(before);
    expect((await experiences.getQueuedAttachmentForSession(sessionId))?.boundMessageId).toBeNull();
  });

  test("already_bound (re-send) inserts NOTHING", async () => {
    const sessionId = await seedSession();
    const queued = await seedQueued(sessionId);

    // First send binds it successfully.
    messages.addMessageWithBind(baseInput, [
      experienceBindHook(queued.id, queued.queueRevision, queued.sessionRevision),
    ]);
    expect(branchMessageCount("brnch_1")).toBe(1);

    // A second send reusing the same (now-bound) attachment id must fail atomically.
    expect(() =>
      messages.addMessageWithBind(baseInput, [
        experienceBindHook(queued.id, queued.queueRevision, queued.sessionRevision),
      ]),
    ).toThrow(ExperienceBindError);

    // Still only the ONE message from the first send.
    expect(branchMessageCount("brnch_1")).toBe(1);
  });

  test("unknown attachment id (not_found) inserts NOTHING", () => {
    const before = branchMessageCount("brnch_1");
    expect(() =>
      messages.addMessageWithBind(baseInput, [experienceBindHook("xa_does_not_exist", 1, 2)]),
    ).toThrow(ExperienceBindError);
    expect(branchMessageCount("brnch_1")).toBe(before);
  });

  test("combined atomicity: dice ok but experience stale → BOTH roll back (no message, dice roll NOT consumed)", async () => {
    const sessionId = await seedSession();
    const queued = await seedQueued(sessionId);
    await dice.createRoll({ chatId: "chat_1", branchId: "brnch_1", mode: "normal", ...rollInput({ requestId: "req_atomic" }) });
    const before = branchMessageCount("brnch_1");

    // Dice hook is valid (revision 1), but the experience hook is stale. The
    // shared transaction must roll back EVERYTHING: no message, dice roll still
    // pending (unconsumed), attachment still queued.
    expect(() =>
      messages.addMessageWithBind(baseInput, [
        diceBindHook("normal", 1),
        experienceBindHook(queued.id, 999, queued.sessionRevision),
      ]),
    ).toThrow(ExperienceBindError);

    expect(branchMessageCount("brnch_1")).toBe(before);
    const pending = await dice.listPending("chat_1", "brnch_1");
    expect(pending.normal.rolls.filter((r) => r.boundMessageId === null).length).toBe(1); // roll survived
    expect((await experiences.getQueuedAttachmentForSession(sessionId))?.boundMessageId).toBeNull();
  });

  test("the user message row is fully committed (variant + content) on a successful bind", async () => {
    const sessionId = await seedSession();
    const queued = await seedQueued(sessionId);

    const { message } = messages.addMessageWithBind(
      { ...baseInput, content: "full turn body", variants: ["full turn body", "alt phrasing"] },
      [experienceBindHook(queued.id, queued.queueRevision, queued.sessionRevision)],
    );

    expect(message.content).toBe("full turn body");
    const row = db.select().from(schema.messages).where(eq(schema.messages.id, message.id)).get();
    expect(row?.content).toBe("full turn body");
    const variants = db.select().from(schema.messageVariants).where(eq(schema.messageVariants.messageId, message.id)).all();
    expect(variants).toHaveLength(2);
  });
});

// ─── Rollback / release ──────────────────────────────────────────────────────

describe("IR-51 atomic send binding — rollback / release", () => {
  test("rollbackReleaseAttachment returns a bound attachment to queued (compensating write)", async () => {
    const sessionId = await seedSession();
    const queued = await seedQueued(sessionId);

    const { message } = messages.addMessageWithBind(baseInput, [
      experienceBindHook(queued.id, queued.queueRevision, queued.sessionRevision),
    ]);
    expect(await experiences.getQueuedAttachmentForSession(sessionId)).toBeNull();

    // The assembly-failure compensating write releases the bind.
    await experiences.rollbackReleaseAttachment(message.id);

    const requeued = await experiences.getQueuedAttachmentForSession(sessionId);
    expect(requeued?.id).toBe(queued.id);
    expect(requeued?.boundMessageId).toBeNull();
  });

  test("a bind throw rolls back the user-message insert (real transaction rollback, not a soft failure)", async () => {
    const sessionId = await seedSession();
    const queued = await seedQueued(sessionId);
    const messageIdBefore = db.select().from(schema.messages).all().map((m) => m.id);

    expect(() =>
      messages.addMessageWithBind(baseInput, [experienceBindHook(queued.id, 1, 99999)]),
    ).toThrow(ExperienceBindError);

    // No new message id was persisted at all.
    const messageIdAfter = db.select().from(schema.messages).all().map((m) => m.id);
    expect(messageIdAfter).toEqual(messageIdBefore);
  });
});

// ─── Dice path unchanged ─────────────────────────────────────────────────────

describe("IR-51 — Dice path unchanged (addMessageWithDiceBind delegates to the composable core)", () => {
  test("addMessageWithDiceBind still binds Dice and returns {message, boundCount}", async () => {
    await dice.createRoll({ chatId: "chat_1", branchId: "brnch_1", mode: "normal", ...rollInput({ requestId: "req_delegate" }) });

    const { message, boundCount } = messages.addMessageWithDiceBind(baseInput, (tx, messageId) =>
      dice.bindActiveAndResetInTx(tx, "chat_1", "brnch_1", "normal", 1, messageId),
    );

    expect(boundCount).toBe(1);
    expect(branchMessageCount("brnch_1")).toBe(1);
    const bound = await dice.getRollsForMessage(message.id);
    expect(bound).toHaveLength(1);
    // Stale re-bind still throws DiceBindError (delegation preserved the contract).
    expect(() =>
      messages.addMessageWithDiceBind(baseInput, (tx, messageId) =>
        dice.bindActiveAndResetInTx(tx, "chat_1", "brnch_1", "normal", 1, messageId),
      ),
    ).toThrow(DiceBindError);
  });
});
