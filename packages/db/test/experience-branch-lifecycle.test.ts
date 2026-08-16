import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";

import { createDb, type AppDb } from "../src/db-connection.js";
import type { DbTransaction } from "../src/db-connection.js";
import * as schema from "../src/db-schema.js";
import { ChatStore } from "../src/stores/chat-store.js";
import { MessageStore } from "../src/stores/message-store.js";
import { DiceRollStore } from "../src/stores/dice-roll-store.js";
import { ExperienceStore } from "../src/stores/experience-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// IR-53 (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 5 unit 3): the branch-fork →
// bound-experience-attachment lifecycle boundary — the direct analogue of
// chat-store-fork-dice.test.ts (DICE-B12). These tests pin ChatStore.forkBranch
// sharing ONE synchronous bun:sqlite transaction with
// ExperienceStore.forkCopyAttachmentsInTx (the IR-21 *InTx(tx) fork-copy core)
// so the attachment copy is atomic with the message/variant/trace copy and rolls
// back together with it. Only attachments bound to a COPIED message
// (position <= fork point) move — later unsent state never moves. The immutable
// snapshot (events, hidden checkpoint, source hashes, queue revision) is
// preserved verbatim. Message deletion cascades the bound attachment (schema);
// a queued (unbound) attachment survives.
//
// The forkBranch callbacks are SYNCHRONOUS (no `async`/`await` inside): that is
// the load-bearing mechanism (drizzle-orm 0.38.4 + bun:sqlite commits at the end
// of the callback's synchronous prefix), shared with the Dice path.

// ─── Test helpers ───────────────────────────────────────────────────────────

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
    return `${prefix}_b13_${String(n).padStart(4, "0")}`;
  },
};

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
    activeBranchId: "brnch_1", promptPresetId: null,
    title: "Experience fork chat", summary: "", messageHistoryLimit: 0,
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
  db.insert(schema.chatBranches).values({
    id: "brnch_1", chatId: "chat_1", parentBranchId: null,
    forkedFromMessageId: null, label: "main", createdAt: FIXED_NOW,
  }).run();
});

/** Create an active session on brnch_1 and return its id. */
async function seedSession(): Promise<string> {
  const created = await experiences.createSession(baseSession());
  if (!created.ok) throw new Error("setup createSession failed");
  return created.session.id;
}

/** Queue+bind a report attachment onto a NEW user message (one session may have
 *  several bound reports at successive queue revisions). */
async function userMessageWithBoundAttachment(
  sessionId: string,
  content: string,
  queueRevision: number,
  reportOverrides: { publicEventsJson?: string; hiddenStateCheckpointJson?: string; sessionRevision?: number } = {},
): Promise<{ messageId: string; attachmentId: string }> {
  const queued = await experiences.queueAttachment({
    chatId: "chat_1",
    branchId: "brnch_1",
    sessionId,
    sessionRevision: reportOverrides.sessionRevision ?? 2,
    queueRevision,
    kind: "report",
    publicEventsJson: reportOverrides.publicEventsJson ?? JSON.stringify({
      title: "Tic-Tac-Toe",
      summary: "Round 1",
      events: [{ type: "move", detail: "X played center" }],
    }),
    hiddenStateCheckpointJson: reportOverrides.hiddenStateCheckpointJson ?? '{"board":["X","","","","","","","",""]}',
    rulesSourceHash: "abc123",
  });

  const { message } = messageStore.addMessageWithBind(
    { chatId: "chat_1", branchId: "brnch_1", role: "user", authorType: "user", content },
    [(tx: DbTransaction, messageId: string) =>
      experiences.verifyAndBindAttachmentInTx(tx, queued.id, queued.queueRevision, queued.sessionRevision, messageId)],
  );
  return { messageId: message.id, attachmentId: queued.id };
}

// ─── Fork lifecycle ─────────────────────────────────────────────────────────

describe("ChatStore.forkBranch — bound experience attachment clone (IR-53)", () => {
  test("fork clones a bound attachment onto the forked user message", async () => {
    const sessionId = await seedSession();
    const { messageId: userId, attachmentId } = await userMessageWithBoundAttachment(sessionId, "I move.", 1);
    // Assistant reply after the user message (also copied, carries no attachment).
    const assistant = await messageStore.addMessage({
      chatId: "chat_1", branchId: "brnch_1", role: "assistant", authorType: "assistant", content: "Noted.",
    });

    const forked = await chatStore.forkBranch(
      "chat_1",
      assistant.id,
      "experience fork",
      undefined,
      (tx, msgIdMap, newBranchId) => experiences.forkCopyAttachmentsInTx(tx, msgIdMap, newBranchId),
    );

    const forkedMessages = await messageStore.getMessages(forked.id);
    expect(forkedMessages.length).toBe(2);
    const forkedUser = forkedMessages.find((m) => m.role === "user")!;
    expect(forkedUser).toBeDefined();

    // Exactly one attachment, bound to the FORKED user message (new id), not the source.
    const forkedAttachments = await experiences.getAttachmentsForMessage(forkedUser.id);
    expect(forkedAttachments).toHaveLength(1);
    expect(forkedAttachments[0]!.id).not.toBe(attachmentId); // fresh id
    expect(forkedAttachments[0]!.boundMessageId).toBe(forkedUser.id);
    // The source attachment is untouched (still bound to the original message).
    const sourceAttachments = await experiences.getAttachmentsForMessage(userId);
    expect(sourceAttachments).toHaveLength(1);
    expect(sourceAttachments[0]!.id).toBe(attachmentId);
  });

  test("fork preserves the immutable snapshot verbatim (events, hidden checkpoint, hashes, revisions)", async () => {
    const sessionId = await seedSession();
    const { messageId: userId } = await userMessageWithBoundAttachment(sessionId, "move", 4, {
      publicEventsJson: JSON.stringify({ title: "Durak", summary: "trump set", events: [{ type: "deal", detail: { n: 6 } }] }),
      hiddenStateCheckpointJson: '{"deck":["6H","7H"],"trump":"AH"}',
      sessionRevision: 9,
    });

    const forked = await chatStore.forkBranch(
      "chat_1", userId, "snapshot fork",
      undefined,
      (tx, msgIdMap, newBranchId) => experiences.forkCopyAttachmentsInTx(tx, msgIdMap, newBranchId),
    );
    const forkedUser = (await messageStore.getMessages(forked.id)).find((m) => m.role === "user")!;
    const forkedAtt = (await experiences.getAttachmentsForMessage(forkedUser.id))[0]!;
    const sourceAtt = (await experiences.getAttachmentsForMessage(userId))[0]!;

    // Immutable snapshot fields are byte-identical to the source.
    expect(forkedAtt.publicEventsJson).toBe(sourceAtt.publicEventsJson);
    expect(forkedAtt.hiddenStateCheckpointJson).toBe(sourceAtt.hiddenStateCheckpointJson);
    expect(forkedAtt.rulesSourceHash).toBe(sourceAtt.rulesSourceHash);
    expect(forkedAtt.visualSourceHash).toBe(sourceAtt.visualSourceHash);
    expect(forkedAtt.kind).toBe(sourceAtt.kind);
    expect(forkedAtt.queueRevision).toBe(sourceAtt.queueRevision);
    expect(forkedAtt.sessionRevision).toBe(sourceAtt.sessionRevision);
    expect(forkedAtt.sessionId).toBe(sourceAtt.sessionId); // historical reference preserved
  });

  test("later unsent state: an attachment bound AFTER the fork point is NOT copied", async () => {
    // Two user messages, each with a bound attachment (same session, successive
    // queue revisions). Fork from the FIRST.
    const sessionId = await seedSession();
    const first = await userMessageWithBoundAttachment(sessionId, "move one", 1);
    await messageStore.addMessage({
      chatId: "chat_1", branchId: "brnch_1", role: "assistant", authorType: "assistant", content: "reply one",
    });
    const second = await userMessageWithBoundAttachment(sessionId, "move two", 2);

    const forked = await chatStore.forkBranch(
      "chat_1", first.messageId, "partial fork",
      undefined,
      (tx, msgIdMap, newBranchId) => experiences.forkCopyAttachmentsInTx(tx, msgIdMap, newBranchId),
    );

    const forkedMessages = await messageStore.getMessages(forked.id);
    // Only the first user message was copied (position <= fork point).
    expect(forkedMessages.length).toBe(1);
    expect(forkedMessages[0]!.role).toBe("user");

    // The forked branch has exactly ONE attachment (from the first message).
    const allForked = db.select()
      .from(schema.experienceAttachments)
      .where(eq(schema.experienceAttachments.branchId, forked.id))
      .all();
    expect(allForked).toHaveLength(1);
    expect(allForked[0]!.boundMessageId).toBe(forkedMessages[0]!.id);
  });

  test("fork with no bound attachment is a no-op for the experience copy", async () => {
    const user = await messageStore.addMessage({
      chatId: "chat_1", branchId: "brnch_1", role: "user", authorType: "user", content: "no game here",
    });
    const forked = await chatStore.forkBranch(
      "chat_1", user.id, "no-op fork",
      undefined,
      (tx, msgIdMap, newBranchId) => experiences.forkCopyAttachmentsInTx(tx, msgIdMap, newBranchId),
    );
    const forkedUser = (await messageStore.getMessages(forked.id))[0];
    const forkedAttachments = await experiences.getAttachmentsForMessage(forkedUser.id);
    expect(forkedAttachments).toHaveLength(0);
  });

  test("combined Dice + Experience fork clones BOTH atomically in one transaction", async () => {
    const sessionId = await seedSession();
    const { messageId: userId, attachmentId } = await userMessageWithBoundAttachment(sessionId, "move + roll", 1);
    // Also bind a dice roll to the same user message.
    await diceStore.createRoll({ chatId: "chat_1", branchId: "brnch_1", mode: "normal", ...rollInput({ requestId: "req_combo" }) });
    // Re-bind the roll onto the existing user message via a direct bind call.
    await diceStore.bindActiveAndReset("chat_1", "brnch_1", "normal", 1, userId);

    const forked = await chatStore.forkBranch(
      "chat_1", userId, "combined fork",
      (tx, msgIdMap) => diceStore.forkCopyRollsInTx(tx, msgIdMap),
      (tx, msgIdMap, newBranchId) => experiences.forkCopyAttachmentsInTx(tx, msgIdMap, newBranchId),
    );

    const forkedUser = (await messageStore.getMessages(forked.id)).find((m) => m.role === "user")!;
    // BOTH the dice roll and the experience attachment are cloned onto the forked message.
    const forkedRolls = await diceStore.getRollsForMessage(forkedUser.id);
    expect(forkedRolls).toHaveLength(1);
    const forkedAttachments = await experiences.getAttachmentsForMessage(forkedUser.id);
    expect(forkedAttachments).toHaveLength(1);
    expect(forkedAttachments[0]!.id).not.toBe(attachmentId);
  });

  test("fork rollback: a callback throw rolls back BOTH dice + experience copies (no orphans)", async () => {
    const sessionId = await seedSession();
    const { messageId: userId } = await userMessageWithBoundAttachment(sessionId, "rollback me", 1);
    await diceStore.createRoll({ chatId: "chat_1", branchId: "brnch_1", mode: "normal", ...rollInput({ requestId: "req_rb" }) });
    await diceStore.bindActiveAndReset("chat_1", "brnch_1", "normal", 1, userId);

    const sourceRollCount = (await diceStore.getRollsForMessage(userId)).length;
    const sourceAttCount = (await experiences.getAttachmentsForMessage(userId)).length;

    // A callback that copies then throws — the whole synchronous fork transaction
    // (messages + dice + experience) must roll back together.
    await expect(
      chatStore.forkBranch(
        "chat_1", userId, "rollback fork",
        (tx, msgIdMap) => {
          diceStore.forkCopyRollsInTx(tx, msgIdMap);
          throw new Error("combined fork boom");
        },
        (tx, msgIdMap, newBranchId) => experiences.forkCopyAttachmentsInTx(tx, msgIdMap, newBranchId),
      ),
    ).rejects.toThrow("combined fork boom");

    // No new branch was created (the fork fully rolled back).
    const branches = await chatStore.getBranches("chat_1");
    expect(branches.length).toBe(1);
    // No orphan dice rolls or attachments leak onto a non-existent branch.
    const allRolls = db.select().from(schema.diceRolls).all();
    expect(allRolls.length).toBe(sourceRollCount);
    const allAttachments = db.select().from(schema.experienceAttachments).all();
    expect(allAttachments.length).toBe(sourceAttCount);
  });
});

// ─── Message deletion lifecycle ─────────────────────────────────────────────

describe("Message deletion — attachment cascade (IR-53)", () => {
  test("deleting a message cascades its bound attachment (schema onDelete:cascade)", async () => {
    const sessionId = await seedSession();
    const { messageId, attachmentId } = await userMessageWithBoundAttachment(sessionId, "delete me", 1);

    // The attachment exists and is bound.
    expect(await experiences.getAttachmentById(attachmentId)).not.toBeNull();

    await messageStore.deleteMessage(messageId);

    // The bound attachment was cascade-deleted with the message.
    expect(await experiences.getAttachmentById(attachmentId)).toBeNull();
  });

  test("a queued (unbound) attachment survives an unrelated message delete", async () => {
    const created = await experiences.createSession(baseSession());
    if (!created.ok) throw new Error("setup createSession failed");
    const queued = await experiences.queueAttachment({
      chatId: "chat_1", branchId: "brnch_1", sessionId: created.session.id,
      sessionRevision: 2, queueRevision: 1, kind: "report",
      publicEventsJson: JSON.stringify({ title: "T", events: [] }),
      hiddenStateCheckpointJson: "{}", rulesSourceHash: "abc123",
    });
    // A separate user message with no binding.
    const unrelated = await messageStore.addMessage({
      chatId: "chat_1", branchId: "brnch_1", role: "user", authorType: "user", content: "unrelated",
    });

    await messageStore.deleteMessage(unrelated.id);

    // The queued attachment is untouched (it was never bound to the deleted message).
    const surviving = await experiences.getAttachmentById(queued.id);
    expect(surviving).not.toBeNull();
    expect(surviving!.boundMessageId).toBeNull();
  });
});
