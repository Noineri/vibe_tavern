import { describe, test, expect, beforeEach } from "bun:test";
import { eq, asc } from "drizzle-orm";
import { createHash } from "node:crypto";

import { createDb, type AppDb } from "../src/db-connection.js";
import type { DbTransaction } from "../src/db-connection.js";
import * as schema from "../src/db-schema.js";
import { ChatStore } from "../src/stores/chat-store.js";
import { MessageStore } from "../src/stores/message-store.js";
import { DiceRollStore } from "../src/stores/dice-roll-store.js";
import { ExperienceStore, ExperienceBindError } from "../src/stores/experience-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// IR-91C (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 5 unit 4): the END-TO-END
// cohesion of a COMBINED Dice + Experience binding across branch activation —
// the one seam none of IR-51 / IR-53 / DICE-B12 exercise.
//
// What those three siblings ALREADY pin (do NOT re-mount here):
//  - IR-51 (experience-atomic-send): the three-way atomic bind, the full
//    stale/already-bound/unknown rollback matrix, rollbackReleaseAttachment.
//  - IR-53 (experience-branch-lifecycle): fork clones a bound attachment, fork
//    snapshot byte-equality, combined Dice+Experience fork, fork rollback,
//    message-delete experience cascade.
//  - DICE-B12 (chat-store-fork-dice): dice fork clone + rollback.
//
// The named defect this suite pins: ChatStore.activateBranch (chat-store.ts)
// has NO test anywhere — the fork fixtures hardcode activeBranchId and never
// flip it, so nothing proves a combined Dice+Experience binding survives
// activate-sibling → restore-original through the real active-branch READ PATH.
// This suite walks ONE combined-bound message's full lifecycle and pins that.
//
// Mechanism (load-bearing, identical to the siblings): drizzle-orm 0.38.4 +
// bun:sqlite commits at the end of a SYNCHRONOUS transaction callback's prefix
// (an `await` inside suspends past the native commit, so its throws are never
// rolled back). The bind hooks and fork-copy hooks below are SYNCHRONOUS —
// called without `await` inside the transaction — exactly as the production
// ChatApplicationService wires them. See ASYNC_TRANSACTION_AUDIT.

// ─── Test harness (mirrors IR-51 / IR-53 / DICE-B12) ─────────────────────────

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
    return `${prefix}_b91_${String(n).padStart(4, "0")}`;
  },
};

const CHAT_ID = "chat_1";
const ROOT_BRANCH = "brnch_1";

let db: AppDb;
let chatStore: ChatStore;
let messageStore: MessageStore;
let diceStore: DiceRollStore;
let experiences: ExperienceStore;

beforeEach(async () => {
  clockTick = 0;
  idCounters = new Map();
  db = await createDb(":memory:");
  chatStore = new ChatStore(db, { clock: testClock, idGenerator: testIdGen });
  messageStore = new MessageStore(db, { clock: testClock, idGenerator: testIdGen });
  diceStore = new DiceRollStore(db, { clock: testClock, idGenerator: testIdGen });
  experiences = new ExperienceStore(db, { clock: testClock, idGenerator: testIdGen });

  // Minimum FK parents: character + persona → chat (active root branch).
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
    id: CHAT_ID, characterId: "char_1", personaId: "persona_1",
    activeBranchId: ROOT_BRANCH, promptPresetId: null,
    title: "IR-91C lifecycle chat", summary: "", messageHistoryLimit: 0,
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
  db.insert(schema.chatBranches).values({
    id: ROOT_BRANCH, chatId: CHAT_ID, parentBranchId: null,
    forkedFromMessageId: null, label: "main", createdAt: FIXED_NOW,
  }).run();
});

// ─── Shared fixtures ────────────────────────────────────────────────────────

function baseSession() {
  return {
    chatId: CHAT_ID,
    branchId: ROOT_BRANCH,
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
    scriptRevision: 1,
    checkId: "fate_check",
    checkLabel: "Fate Roll",
    notation: "4dF",
    faceShape: "dF",
    resolution: "narrative",
    mode: "normal",
    attemptsJson: JSON.stringify([{ attemptId: "a1", faces: [1, 0, -1, 1], modifier: 0, subtotal: 1, total: 1 }]),
    finalJson: null,
    ...overrides,
  };
}

function userInput(content: string) {
  return { chatId: CHAT_ID, branchId: ROOT_BRANCH, role: "user", authorType: "user", content };
}

async function seedSession(): Promise<string> {
  const created = await experiences.createSession(baseSession());
  if (!created.ok) throw new Error("setup createSession failed");
  return created.session.id;
}

/** Queue a report attachment at queueRevision=1, sessionRevision=2. */
async function queueReport(sessionId: string) {
  return experiences.queueAttachment({
    chatId: CHAT_ID,
    branchId: ROOT_BRANCH,
    sessionId,
    sessionRevision: 2,
    queueRevision: 1,
    kind: "report",
    publicEventsJson: JSON.stringify({ title: "Tic-Tac-Toe", summary: "Round 1", events: [{ type: "move", detail: "X center" }] }),
    hiddenStateCheckpointJson: '{"board":["X","","","","","","","",""]}',
    rulesSourceHash: "abc123",
  });
}

/** Create one pending normal-lane dice roll on the root branch. */
async function seedPendingRoll(requestId: string): Promise<void> {
  await diceStore.createRoll({ chatId: CHAT_ID, branchId: ROOT_BRANCH, mode: "normal", ...rollInput({ requestId }) });
}

/**
 * THE lifecycle base: queue an experience attachment AND a pending dice roll for
 * the SAME forthcoming user message, then commit message + variant + dice bind +
 * experience bind in ONE synchronous transaction (addMessageWithBind with both
 * hooks — exactly how ChatApplicationService.appendUserMessage wires it).
 */
async function combinedBindUserMessage(sessionId: string, content: string, requestId: string) {
  const queued = await queueReport(sessionId);
  await seedPendingRoll(requestId);
  const { message } = messageStore.addMessageWithBind(userInput(content), [
    (tx: DbTransaction, mid: string) => diceStore.bindActiveAndResetInTx(tx, CHAT_ID, ROOT_BRANCH, "normal", 1, mid),
    (tx: DbTransaction, mid: string) => experiences.verifyAndBindAttachmentInTx(tx, queued.id, queued.queueRevision, queued.sessionRevision, mid),
  ]);
  return { message, attachmentId: queued.id };
}

/** Fork the root branch from `fromMessageId`, cloning BOTH dice + experience. */
async function forkWithBothHooks(fromMessageId: string, label: string) {
  return chatStore.forkBranch(
    CHAT_ID,
    fromMessageId,
    label,
    (tx, msgIdMap) => diceStore.forkCopyRollsInTx(tx, msgIdMap),
    (tx, msgIdMap, newBranchId) => experiences.forkCopyAttachmentsInTx(tx, msgIdMap, newBranchId),
  );
}

// ─── Row-count + hash helpers ───────────────────────────────────────────────

function countMessages(branchId: string): number {
  return db.select().from(schema.messages).where(eq(schema.messages.branchId, branchId)).all().length;
}
function countVariants(messageId: string): number {
  return db.select().from(schema.messageVariants).where(eq(schema.messageVariants.messageId, messageId)).all().length;
}
function countDiceBoundTo(messageId: string): number {
  return db.select().from(schema.diceRolls).where(eq(schema.diceRolls.boundMessageId, messageId)).all().length;
}
function countAttachmentsBoundTo(messageId: string): number {
  return db.select().from(schema.experienceAttachments).where(eq(schema.experienceAttachments.boundMessageId, messageId)).all().length;
}
function totalBranches(): number {
  return db.select().from(schema.chatBranches).where(eq(schema.chatBranches.chatId, CHAT_ID)).all().length;
}
function totalRows(table: typeof schema.messages): number {
  return db.select().from(table).all().length;
}

/**
 * Deterministic sha256[:16] over a branch's binding state: ordered messages →
 * their bound dice-roll ids (sorted) + bound attachment ids w/ queue/session
 * revision + kind (sorted). Every id is produced by the deterministic testIdGen
 * (counter reset in beforeEach), so this hash is stable across independent
 * temp-DB runs and is UNCHANGED by pure activation switches (which only flip
 * chats.activeBranchId — they touch no binding row).
 */
function bindingStateHash(branchId: string): string {
  const msgs = db.select().from(schema.messages)
    .where(eq(schema.messages.branchId, branchId))
    .orderBy(asc(schema.messages.position)).all();
  const parts: string[] = [];
  for (const m of msgs) {
    const rolls = db.select().from(schema.diceRolls)
      .where(eq(schema.diceRolls.boundMessageId, m.id)).all()
      .map((r) => r.id).sort();
    const atts = db.select().from(schema.experienceAttachments)
      .where(eq(schema.experienceAttachments.boundMessageId, m.id)).all()
      .map((a) => `${a.id}#${a.queueRevision}/${a.sessionRevision}/${a.kind}`).sort();
    parts.push(`${m.id}:${m.role}:rolls[${rolls.join(",")}]:atts[${atts.join(",")}]`);
  }
  return createHash("sha256").update(parts.join("||")).digest("hex").slice(0, 16);
}

/**
 * The active-branch READ PATH a render/restore uses: resolve the chat's active
 * branch, read its messages, then the dice rolls + experience attachments bound
 * to its user message. Returns the resolved branch id + the binding edges.
 */
async function readActiveCombinedBinding() {
  const active = await chatStore.getActiveBranch(CHAT_ID);
  if (!active) throw new Error("no active branch");
  const msgs = await messageStore.getMessages(active.id);
  const user = msgs.find((m) => m.role === "user");
  if (!user) throw new Error("no user message on active branch");
  const rolls = await diceStore.getRollsForMessage(user.id);
  const attachments = await experiences.getAttachmentsForMessage(user.id);
  return { branchId: active.id, userMessageId: user.id, rolls, attachments };
}

// ─── L1 — three-way atomic bind ─────────────────────────────────────────────

describe("IR-91C — combined Dice+Experience binding survives fork + branch activation", () => {
  test("L1 — three-way atomic bind commits message+variant+dice+experience in ONE transaction", async () => {
    const sessionId = await seedSession();
    const { message, attachmentId } = await combinedBindUserMessage(sessionId, "submit turn", "req_l1");

    // Exact row counts: 1 message, 1 variant, 1 bound dice roll, 1 bound attachment.
    expect(countMessages(ROOT_BRANCH)).toBe(1);
    expect(countVariants(message.id)).toBe(1);
    expect(countDiceBoundTo(message.id)).toBe(1);
    expect(countAttachmentsBoundTo(message.id)).toBe(1);

    // Binding edges point at the newly committed message.
    const roll = (await diceStore.getRollsForMessage(message.id))[0]!;
    expect(roll.boundMessageId).toBe(message.id);
    const att = (await experiences.getAttachmentsForMessage(message.id))[0]!;
    expect(att.id).toBe(attachmentId);
    expect(att.boundMessageId).toBe(message.id);

    // Both lanes are drained by the single transaction.
    const pending = await diceStore.listPending(CHAT_ID, ROOT_BRANCH);
    expect(pending.normal.rolls.filter((r) => r.boundMessageId === null).length).toBe(0);
    expect(await experiences.getQueuedAttachmentForSession(sessionId)).toBeNull();

    // Stable binding-state hash over the root branch (reported in the gate).
    const h = bindingStateHash(ROOT_BRANCH);
    expect(h).toBe("b92cdfd9365698c4"); // stable across runs (deterministic fixtures)
    expect(h).toBe(bindingStateHash(ROOT_BRANCH)); // determinism: recompute === first compute
  });

  // ─── L2 — fork after the combined bind ────────────────────────────────────

  test("L2 — fork AFTER the combined bind clones BOTH dice roll and attachment onto the new branch", async () => {
    const sessionId = await seedSession();
    const { message, attachmentId } = await combinedBindUserMessage(sessionId, "move + roll", "req_l2");

    const forked = await forkWithBothHooks(message.id, "sibling");
    const forkedUser = (await messageStore.getMessages(forked.id)).find((m) => m.role === "user")!;

    // New message id on the forked branch; both clones point there (msgIdMap),
    // not at the source message.
    expect(forkedUser.id).not.toBe(message.id);
    const forkedRolls = await diceStore.getRollsForMessage(forkedUser.id);
    expect(forkedRolls).toHaveLength(1);
    expect(forkedRolls[0]!.boundMessageId).toBe(forkedUser.id);
    const forkedAtts = await experiences.getAttachmentsForMessage(forkedUser.id);
    expect(forkedAtts).toHaveLength(1);
    expect(forkedAtts[0]!.boundMessageId).toBe(forkedUser.id);
    expect(forkedAtts[0]!.id).not.toBe(attachmentId); // fresh id, not the source's

    // Exact counts on BOTH branches (source untouched, fork carries one of each).
    expect(countMessages(ROOT_BRANCH)).toBe(1);
    expect(countMessages(forked.id)).toBe(1);
    expect(countDiceBoundTo(message.id)).toBe(1);
    expect(countDiceBoundTo(forkedUser.id)).toBe(1);
    expect(countAttachmentsBoundTo(message.id)).toBe(1);
    expect(countAttachmentsBoundTo(forkedUser.id)).toBe(1);

    // Per-branch binding-state hashes: distinct (no leak across branches).
    const hashOrig = bindingStateHash(ROOT_BRANCH);
    const hashFork = bindingStateHash(forked.id);
    expect(hashOrig).toBe("b92cdfd9365698c4"); // root branch stable across runs
    expect(hashFork).toBe("d8d353d12f7c8f95"); // forked branch stable across runs
    expect(hashOrig).not.toBe(hashFork); // distinct branches → distinct bindings (no leak)
  });

  // ─── L3 — activation / restore (THE GAP) ──────────────────────────────────

  test("L3 (GAP) — activateBranch sibling then restore: each branch's combined binding reads correctly, no leak", async () => {
    const sessionId = await seedSession();
    const { message } = await combinedBindUserMessage(sessionId, "activate me", "req_l3");
    const forked = await forkWithBothHooks(message.id, "sibling");
    const forkedUser = (await messageStore.getMessages(forked.id)).find((m) => m.role === "user")!;

    // Baseline: active = root; the read path returns root's combined binding.
    expect((await chatStore.getActiveBranch(CHAT_ID))!.id).toBe(ROOT_BRANCH);
    let read = await readActiveCombinedBinding();
    expect(read.branchId).toBe(ROOT_BRANCH);
    expect(read.userMessageId).toBe(message.id);
    expect(read.rolls).toHaveLength(1);
    expect(read.attachments).toHaveLength(1);

    // Snapshot per-branch hashes + total row counts before any switch.
    const hashOrig = bindingStateHash(ROOT_BRANCH);
    const hashFork = bindingStateHash(forked.id);
    const totalsBefore = {
      branches: totalBranches(),
      messages: countMessages(ROOT_BRANCH) + countMessages(forked.id),
      dice: totalRows(schema.diceRolls),
      atts: totalRows(schema.experienceAttachments),
    };

    // ── Activate the sibling (forked) branch ──
    await chatStore.activateBranch(CHAT_ID, forked.id);
    expect((await chatStore.getActiveBranch(CHAT_ID))!.id).toBe(forked.id);
    read = await readActiveCombinedBinding();
    expect(read.branchId).toBe(forked.id);
    expect(read.userMessageId).toBe(forkedUser.id); // sibling's OWN message
    expect(read.rolls).toHaveLength(1);
    expect(read.rolls[0]!.boundMessageId).toBe(forkedUser.id);
    expect(read.attachments).toHaveLength(1);
    expect(read.attachments[0]!.boundMessageId).toBe(forkedUser.id);

    // No binding leaked across branches; hashes + totals unchanged by the switch.
    expect(bindingStateHash(ROOT_BRANCH)).toBe(hashOrig);
    expect(bindingStateHash(forked.id)).toBe(hashFork);
    expect({
      branches: totalBranches(),
      messages: countMessages(ROOT_BRANCH) + countMessages(forked.id),
      dice: totalRows(schema.diceRolls),
      atts: totalRows(schema.experienceAttachments),
    }).toEqual(totalsBefore);

    // ── Restore the original (root) branch ──
    await chatStore.activateBranch(CHAT_ID, ROOT_BRANCH);
    expect((await chatStore.getActiveBranch(CHAT_ID))!.id).toBe(ROOT_BRANCH);
    read = await readActiveCombinedBinding();
    expect(read.branchId).toBe(ROOT_BRANCH);
    expect(read.userMessageId).toBe(message.id); // original message again
    expect(read.rolls).toHaveLength(1);
    expect(read.rolls[0]!.boundMessageId).toBe(message.id);
    expect(read.attachments).toHaveLength(1);
    expect(read.attachments[0]!.boundMessageId).toBe(message.id);

    // Hashes + totals STILL unchanged after the full round-trip.
    expect(bindingStateHash(ROOT_BRANCH)).toBe(hashOrig);
    expect(bindingStateHash(forked.id)).toBe(hashFork);
    expect({
      branches: totalBranches(),
      messages: countMessages(ROOT_BRANCH) + countMessages(forked.id),
      dice: totalRows(schema.diceRolls),
      atts: totalRows(schema.experienceAttachments),
    }).toEqual(totalsBefore);
  });

  // ─── L4 — clean delete (combined + cross-branch) ──────────────────────────

  test("L4 — deleting the combined message clears both bindings with no orphan; cross-branch isolation", async () => {
    const sessionId = await seedSession();
    const { message, attachmentId } = await combinedBindUserMessage(sessionId, "delete me", "req_l4");
    const forked = await forkWithBothHooks(message.id, "sibling");
    const forkedUser = (await messageStore.getMessages(forked.id)).find((m) => m.role === "user")!;

    // Sanity: both branches carry a combined binding before the delete.
    expect(countDiceBoundTo(message.id)).toBe(1);
    expect(countAttachmentsBoundTo(message.id)).toBe(1);
    expect(countDiceBoundTo(forkedUser.id)).toBe(1);
    expect(countAttachmentsBoundTo(forkedUser.id)).toBe(1);

    // Delete the ROOT branch's combined message (a plain row delete; the schema
    // FK ON DELETE clauses do the work — deleteMessage adds nothing on top).
    await messageStore.deleteMessage(message.id);

    // Experience attachment: schema onDelete:cascade → the row is GONE.
    expect(await experiences.getAttachmentById(attachmentId)).toBeNull();
    // Dice roll: schema onDelete:set null → the roll SURVIVES, returned to the
    // pending lane (boundMessageId cleared). It is NOT deleted, and it is NOT an
    // orphan — it references no message.
    // Dice roll: schema onDelete:set null → the roll SURVIVES, returned to the
    // pending lane (boundMessageId cleared). listPending is the canonical read
    // path (diceRolls has no branchId column; the branch link is via laneId →
    // dicePendingLanes.branchId). The roll is NOT deleted, and it is NOT an
    // orphan — it references no message.
    const pending = await diceStore.listPending(CHAT_ID, ROOT_BRANCH);
    const unconsumed = pending.normal.rolls.filter((r) => r.boundMessageId === null);
    expect(unconsumed).toHaveLength(1);
    // NO orphan: nothing references the deleted message id.
    expect(countDiceBoundTo(message.id)).toBe(0);
    expect(countAttachmentsBoundTo(message.id)).toBe(0);

    // Cross-branch isolation: the sibling's combined binding is untouched.
    expect(countDiceBoundTo(forkedUser.id)).toBe(1);
    expect(countAttachmentsBoundTo(forkedUser.id)).toBe(1);
    expect((await diceStore.getRollsForMessage(forkedUser.id))[0]!.boundMessageId).toBe(forkedUser.id);
    expect((await experiences.getAttachmentsForMessage(forkedUser.id))[0]!.boundMessageId).toBe(forkedUser.id);
  });

  // ─── L5a — rollback anchor (re-assert, not the full IR-51 matrix) ─────────

  test("L5a (lifecycle anchor) — a thrown experience-bind hook rolls back the message insert AND leaves the dice roll queued", async () => {
    const sessionId = await seedSession();
    const queued = await queueReport(sessionId);
    await seedPendingRoll("req_l5a");
    const before = countMessages(ROOT_BRANCH);

    // Dice hook is valid (pendingRevision 1); experience hook is stale (999) →
    // throws ExperienceBindError. The shared synchronous transaction rolls back
    // EVERYTHING: no message, no dice bind.
    expect(() =>
      messageStore.addMessageWithBind(userInput("doomed turn"), [
        (tx: DbTransaction, mid: string) => diceStore.bindActiveAndResetInTx(tx, CHAT_ID, ROOT_BRANCH, "normal", 1, mid),
        (tx: DbTransaction, mid: string) => experiences.verifyAndBindAttachmentInTx(tx, queued.id, 999, queued.sessionRevision, mid),
      ]),
    ).toThrow(ExperienceBindError);

    // No message inserted.
    expect(countMessages(ROOT_BRANCH)).toBe(before);
    // Dice roll survived, still pending (unconsumed) — not bound to anything.
    const pending = await diceStore.listPending(CHAT_ID, ROOT_BRANCH);
    expect(pending.normal.rolls.filter((r) => r.boundMessageId === null).length).toBe(1);
    // Attachment still queued, unbound.
    expect((await experiences.getQueuedAttachmentForSession(sessionId))?.boundMessageId).toBeNull();
  });

  // ─── L5b — fork rollback injection (experience fork-copy throws) ──────────

  test("L5b — a thrown experience fork-copy hook rolls back dice+experience copies AND forked messages/variants (new branch = 0 rows)", async () => {
    const sessionId = await seedSession();
    const { message } = await combinedBindUserMessage(sessionId, "rollback fork", "req_l5b");

    const before = {
      branches: totalBranches(),
      messages: totalRows(schema.messages),
      variants: totalRows(schema.messageVariants),
      dice: totalRows(schema.diceRolls),
      atts: totalRows(schema.experienceAttachments),
    };

    // Dice copy runs, experience copy runs, THEN the experience closure throws.
    // The whole synchronous fork transaction (branch + messages + variants +
    // dice copies + attachment copies) rolls back together. This throws in the
    // EXPERIENCE fork closure — a distinct injection point from IR-53, which
    // throws in the DICE fork closure before experience copy runs.
    await expect(
      chatStore.forkBranch(
        CHAT_ID, message.id, "doomed fork",
        (tx, msgIdMap) => diceStore.forkCopyRollsInTx(tx, msgIdMap),
        (tx, msgIdMap, newBranchId) => {
          experiences.forkCopyAttachmentsInTx(tx, msgIdMap, newBranchId);
          throw new Error("experience fork-copy boom");
        },
      ),
    ).rejects.toThrow("experience fork-copy boom");

    // No new branch was created (the fork fully rolled back) → new branch = 0 rows.
    expect(totalBranches()).toBe(before.branches);
    expect(totalRows(schema.messages)).toBe(before.messages);
    expect(totalRows(schema.messageVariants)).toBe(before.variants);
    expect(totalRows(schema.diceRolls)).toBe(before.dice);
    expect(totalRows(schema.experienceAttachments)).toBe(before.atts);
    // The source branch's combined binding is intact (not orphaned by the failed fork).
    expect(countDiceBoundTo(message.id)).toBe(1);
    expect(countAttachmentsBoundTo(message.id)).toBe(1);
  });
});
