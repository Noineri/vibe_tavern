import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";

import { createDb, type AppDb } from "../src/db-connection.js";
import * as schema from "../src/db-schema.js";
import { MessageStore } from "../src/stores/message-store.js";
import { DiceRollStore, DiceBindError } from "../src/stores/dice-roll-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// DICE-B10 (DICE_SYSTEM_BACKEND_PLAN, Wave B4 unit 1): the atomic send-binding
// reasoning core. These tests pin the SAME boundary the user-turn commit uses —
// `MessageStore.addMessageWithDiceBind` sharing ONE synchronous bun:sqlite
// transaction with `DiceRollStore.bindActiveAndResetInTx`. They cover every
// self-check case in the unit's Required result, plus a characterization of the
// unchanged no-Dice `addMessage` path. The transaction mechanism is load-bearing:
// drizzle-orm 0.38.4 + bun-sqlite only rolls back SYNCHRONOUS transaction
// callbacks (an `await` inside suspends past the native commit), so a stale
// revision / unresolved-choose throw must roll the user-message insert back too.
//
// Note on awaits: the Dice roll CREATE/READ methods are async (declared with
// `await` inside), so they are awaited. The atomic commit itself —
// `addMessageWithDiceBind` + `bindActiveAndResetInTx` — is SYNCHRONOUS (no
// `await` inside; that is the whole point), so it is called without await.

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

/** Minimum FK parents: character → chat (two branches) so both MessageStore and
 *  DiceRollStore can operate. The bind is scoped per {chatId, branchId, mode}. */
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

/** A closure that binds the active-mode lane of {chatId, branchId} inside the
 *  caller's transaction — exactly what ChatApplicationService.appendUserMessage
 *  passes to addMessageWithDiceBind. */
function bindFor(
  dice: DiceRollStore,
  chatId: string,
  branchId: string,
  mode: "normal" | "immersive",
  pendingRevision: number,
) {
  return (tx: Parameters<Parameters<AppDb["transaction"]>[0]>[0], messageId: string) =>
    dice.bindActiveAndResetInTx(tx, chatId, branchId, mode, pendingRevision, messageId);
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

beforeEach(async () => {
  db = await createDb(":memory:");
  bootstrap(db);
  clockTick = 0;
  idCounters = new Map();
  messages = new MessageStore(db, { clock: testClock, idGenerator: testIdGen });
  dice = new DiceRollStore(db, { clock: testClock, idGenerator: testIdGen });
});

/** Count messages in a branch (sync, on the shared connection). */
function branchMessageCount(branchId: string): number {
  return db.select().from(schema.messages).where(eq(schema.messages.branchId, branchId)).all().length;
}

/** The rolls in a lane that are still PENDING (unbound). B7's listPending returns
 *  every roll in the lane row (bound + unbound); a bound roll is consumed and no
 *  longer pending, so the meaningful "pending" count is the unbound subset. */
function unboundRolls<T extends { boundMessageId: string | null }>(rolls: T[]): T[] {
  return rolls.filter((r) => r.boundMessageId === null);
}

// ─── Characterization: no-Dice addMessage is unchanged ───────────────────────

describe("DICE-B10 atomic send binding — characterization (no-Dice unchanged)", () => {
  test("addMessage (no dice) inserts message + variant and returns the message, no dice query", async () => {
    const before = await dice.listPending("chat_1", "brnch_1");
    expect(before.normal.rolls.length).toBe(0);

    const message = await messages.addMessage({
      chatId: "chat_1", branchId: "brnch_1",
      role: "user", authorType: "user", content: "hello no-dice",
    });

    expect(message.role).toBe("user");
    expect(message.content).toBe("hello no-dice");
    expect(message.state).toBe("complete");
    expect(branchMessageCount("brnch_1")).toBe(1);
    const variants = await messages.getVariants(message.id);
    expect(variants.length).toBe(1);
    expect(variants[0]!.isSelected).toBe(true);

    // No dice lane was created or touched by the no-Dice path.
    const after = await dice.listPending("chat_1", "brnch_1");
    expect(after.normal.revision).toBe(0);
    expect(after.normal.rolls.length).toBe(0);
  });

  test("addMessageWithDiceBind with a no-op bind (empty materialized lane) commits the message and binds nothing", async () => {
    // An empty active lane materialized at revision 0 (the dice panel opened but
    // the user rolled nothing this turn). The commit binds nothing but still
    // commits the message — the send must not be blocked by an empty lane.
    await dice.getOrCreateLane("chat_1", "brnch_1", "normal");
    const { message, boundCount } = messages.addMessageWithDiceBind(
      { chatId: "chat_1", branchId: "brnch_1", role: "user", authorType: "user", content: "empty dice turn" },
      bindFor(dice, "chat_1", "brnch_1", "normal", 0),
    );
    expect(boundCount).toBe(0);
    expect(message.content).toBe("empty dice turn");
    expect(branchMessageCount("brnch_1")).toBe(1);
    // Lane reset (revision 0 → 1).
    expect((await dice.listPending("chat_1", "brnch_1")).normal.revision).toBe(1);
  });
});

// ─── Atomic bind invariants ──────────────────────────────────────────────────

describe("DICE-B10 atomic send binding — invariants", () => {
  test("successful bind consumes the active lane once and binds rolls to the new message", async () => {
    await dice.createRoll({ chatId: "chat_1", branchId: "brnch_1", mode: "normal", ...rollInput({ requestId: "req_ok" }) });

    const { message, boundCount } = messages.addMessageWithDiceBind(
      { chatId: "chat_1", branchId: "brnch_1", role: "user", authorType: "user", content: "roll please" },
      bindFor(dice, "chat_1", "brnch_1", "normal", 1),
    );

    expect(boundCount).toBe(1);
    expect(branchMessageCount("brnch_1")).toBe(1);
    const bound = await dice.getRollsForMessage(message.id);
    expect(bound.length).toBe(1);
    expect(bound[0]!.boundMessageId).toBe(message.id);

    const pending = await dice.listPending("chat_1", "brnch_1");
    expect(unboundRolls(pending.normal.rolls).length).toBe(0); // the roll is now bound, not pending
    expect(pending.normal.revision).toBe(2); // incremented on reset

    // Consumed once: a second commit at the now-stale revision 1 fails.
    expect(() =>
      messages.addMessageWithDiceBind(
        { chatId: "chat_1", branchId: "brnch_1", role: "user", authorType: "user", content: "again" },
        bindFor(dice, "chat_1", "brnch_1", "normal", 1),
      ),
    ).toThrow(DiceBindError);
  });

  test("stale revision inserts NOTHING (no ghost message, roll stays pending)", async () => {
    await dice.createRoll({ chatId: "chat_1", branchId: "brnch_1", mode: "normal", ...rollInput({ requestId: "req_stale" }) });
    expect(branchMessageCount("brnch_1")).toBe(0);

    let threw: unknown;
    try {
      messages.addMessageWithDiceBind(
        { chatId: "chat_1", branchId: "brnch_1", role: "user", authorType: "user", content: "should not persist" },
        bindFor(dice, "chat_1", "brnch_1", "normal", 0),
      );
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(DiceBindError);
    expect((threw as DiceBindError).code).toBe("stale_revision");

    // The atomic guarantee: NOTHING was inserted.
    expect(branchMessageCount("brnch_1")).toBe(0);
    const pending = await dice.listPending("chat_1", "brnch_1");
    expect(pending.normal.rolls.length).toBe(1);
    expect(pending.normal.rolls[0]!.boundMessageId).toBeNull();
    expect(pending.normal.revision).toBe(1); // untouched by the failed commit
  });

  test("unresolved choose inserts NOTHING", async () => {
    await dice.createRoll({
      chatId: "chat_1", branchId: "brnch_1", mode: "immersive",
      ...rollInput({ requestId: "req_choose", mode: "immersive", policy: "choose", finalAttemptId: null }),
    });

    let threw: unknown;
    try {
      messages.addMessageWithDiceBind(
        { chatId: "chat_1", branchId: "brnch_1", role: "user", authorType: "user", content: "blocked" },
        bindFor(dice, "chat_1", "brnch_1", "immersive", 1),
      );
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(DiceBindError);
    expect((threw as DiceBindError).code).toBe("unresolved_choose");

    expect(branchMessageCount("brnch_1")).toBe(0);
    const pending = await dice.listPending("chat_1", "brnch_1");
    expect(pending.immersive.rolls.length).toBe(1);
    expect(pending.immersive.rolls[0]!.boundMessageId).toBeNull();
  });

  test("excluded (server-excluded) active rolls do not bind", async () => {
    const roll = await dice.createRoll({
      chatId: "chat_1", branchId: "brnch_1", mode: "immersive",
      ...rollInput({ requestId: "req_excl", mode: "immersive" }),
    });
    await dice.setIncluded(roll.id, false); // revision 1 → 2

    const { message, boundCount } = messages.addMessageWithDiceBind(
      { chatId: "chat_1", branchId: "brnch_1", role: "user", authorType: "user", content: "excluded roll" },
      bindFor(dice, "chat_1", "brnch_1", "immersive", 2),
    );

    expect(boundCount).toBe(0);
    expect(branchMessageCount("brnch_1")).toBe(1); // commit itself still succeeded
    expect((await dice.getRollsForMessage(message.id)).length).toBe(0);
  });

  test("inactive-mode lane is discarded and both lanes reset (revision++)", async () => {
    await dice.createRoll({ chatId: "chat_1", branchId: "brnch_1", mode: "normal", ...rollInput({ requestId: "req_n2" }) });
    await dice.createRoll({ chatId: "chat_1", branchId: "brnch_1", mode: "immersive", ...rollInput({ requestId: "req_i2", mode: "immersive" }) });

    const { message, boundCount } = messages.addMessageWithDiceBind(
      { chatId: "chat_1", branchId: "brnch_1", role: "user", authorType: "user", content: "normal commit" },
      bindFor(dice, "chat_1", "brnch_1", "normal", 1),
    );

    expect(boundCount).toBe(1);
    expect((await dice.getRollsForMessage(message.id)).length).toBe(1);

    const pending = await dice.listPending("chat_1", "brnch_1");
    expect(unboundRolls(pending.normal.rolls).length).toBe(0); // bound roll no longer pending
    expect(pending.immersive.rolls.length).toBe(0); // inactive lane discarded (rolls deleted)
    expect(pending.normal.revision).toBe(2); // both lanes reset
    expect(pending.immersive.revision).toBe(2);
  });

  test("captured script snapshot survives a bind (self-contained, no FK to scripts)", async () => {
    await dice.createRoll({
      chatId: "chat_1", branchId: "brnch_1", mode: "normal",
      ...rollInput({
        requestId: "req_snap",
        scriptRevision: 999,
        scriptLabel: "Original Label",
        checkLabel: "Original Check",
        notation: "2d6+3",
        attemptsJson: JSON.stringify([{ attemptId: "a1", faces: [4, 5], modifier: 3, subtotal: 9, total: 12 }]),
        finalJson: JSON.stringify({ total: 12, outcome: "success" }),
        resolution: "strict",
      }),
    });

    const { message } = messages.addMessageWithDiceBind(
      { chatId: "chat_1", branchId: "brnch_1", role: "user", authorType: "user", content: "snap" },
      bindFor(dice, "chat_1", "brnch_1", "normal", 1),
    );

    const bound = await dice.getRollsForMessage(message.id);
    expect(bound.length).toBe(1);
    const r = bound[0]!;
    // The bound snapshot is the roll-time capture — there is NO FK to scripts, so
    // a script rename/edit/disable/delete physically cannot rewrite these fields.
    expect(r.scriptRevision).toBe(999);
    expect(r.scriptLabel).toBe("Original Label");
    expect(r.checkLabel).toBe("Original Check");
    expect(r.notation).toBe("2d6+3");
    expect(r.resolution).toBe("strict");
    expect(r.boundMessageId).toBe(message.id);
    expect(JSON.parse(r.attemptsJson)[0].total).toBe(12);
    expect(JSON.parse(r.finalJson!).total).toBe(12);
  });

  test("actor/branch mismatch: a roll in another branch is NOT consumed by this commit", async () => {
    await dice.createRoll({ chatId: "chat_1", branchId: "brnch_1", mode: "normal", ...rollInput({ requestId: "req_b1" }) });
    // Materialize brnch_2's normal lane (revision 0) — the frontend contract
    // guarantees the active lane exists before a dice-commit send.
    await dice.getOrCreateLane("chat_1", "brnch_2", "normal");

    // Commit a message in brnch_2 — its lane is empty, revision 0.
    const { message, boundCount } = messages.addMessageWithDiceBind(
      { chatId: "chat_1", branchId: "brnch_2", role: "user", authorType: "user", content: "other branch" },
      bindFor(dice, "chat_1", "brnch_2", "normal", 0),
    );

    expect(boundCount).toBe(0);
    expect((await dice.getRollsForMessage(message.id)).length).toBe(0);
    const pendingB1 = await dice.listPending("chat_1", "brnch_1");
    expect(unboundRolls(pendingB1.normal.rolls).length).toBe(1); // brnch_1 roll untouched
    expect(pendingB1.normal.rolls[0]!.boundMessageId).toBeNull();
    expect(pendingB1.normal.revision).toBe(1); // not reset by a different branch's commit
  });

  test("the user message row is fully committed (variant + content + attachments) on a successful bind", async () => {
    await dice.createRoll({ chatId: "chat_1", branchId: "brnch_1", mode: "normal", ...rollInput({ requestId: "req_full" }) });

    const { message } = messages.addMessageWithDiceBind(
      {
        chatId: "chat_1", branchId: "brnch_1", role: "user", authorType: "user",
        content: "full commit", attachmentsJson: JSON.stringify([{ id: "a1" }]),
      },
      bindFor(dice, "chat_1", "brnch_1", "normal", 1),
    );

    expect(message.content).toBe("full commit");
    expect(message.role).toBe("user");
    const variants = await messages.getVariants(message.id);
    expect(variants.length).toBe(1);
    expect(variants[0]!.isSelected).toBe(true);
    const row = db.select().from(schema.messages).where(eq(schema.messages.id, message.id)).get();
    expect(row!.attachmentsJson).toBe(JSON.stringify([{ id: "a1" }]));
  });

  test("bindActiveAndReset (public async wrapper) still rejects stale revision (B7 contract preserved)", async () => {
    await dice.createRoll({ chatId: "chat_1", branchId: "brnch_1", mode: "normal", ...rollInput({ requestId: "req_async" }) });
    await expect(dice.bindActiveAndReset("chat_1", "brnch_1", "normal", 99, "msg_async")).rejects.toThrow(DiceBindError);
  });
});

// ─── Rollback mechanism (load-bearing) ───────────────────────────────────────

describe("DICE-B10 atomic send binding — rollback mechanism", () => {
  test("a bind throw rolls back the user-message insert (real transaction rollback, not a soft failure)", () => {
    // Force a synchronous throw inside the shared transaction. If drizzle/bun-sqlite
    // did NOT roll back synchronous-transaction throws, a ghost message row would
    // persist here — this is the exact failure mode the synchronous-transaction
    // design exists to prevent.
    expect(() =>
      messages.addMessageWithDiceBind(
        { chatId: "chat_1", branchId: "brnch_1", role: "user", authorType: "user", content: "rolled back" },
        () => {
          throw new Error("simulated bind failure");
        },
      ),
    ).toThrow("simulated bind failure");
    expect(branchMessageCount("brnch_1")).toBe(0);
    expect(db.select().from(schema.messageVariants).all().length).toBe(0);
  });
});
