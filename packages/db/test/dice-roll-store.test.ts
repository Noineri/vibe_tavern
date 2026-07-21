import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { createDb, type AppDb } from "../src/db-connection.js";
import { DiceRollStore, DiceBindError } from "../src/stores/dice-roll-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// ─── Test setup ─────────────────────────────────────────────────────────────

const fixedClock: StoreClock = { now: () => "2026-07-21T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = {
  next: (prefix) => `${prefix}_test_${++counter}`,
};

function resetCounter() {
  counter = 0;
  msgPosition = 0;
}

async function setupDb(): Promise<AppDb> {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-diceroll-test-"));
  return createDb(join(dataRoot, "test.db"));
}

/**
 * Insert FK parents: character, persona, chat, branch, and a message.
 * Dice rolls reference chats, branches, and optionally messages.
 */
async function seedParents(db: AppDb) {
  await db.run(
    sql`INSERT INTO characters (id, name, created_at, updated_at) VALUES ('char_1', 'Hero', '2026-01-01', '2026-01-01')`,
  );
  await db.run(
    sql`INSERT INTO personas (id, name, description, default_for_new_chats, has_file_on_disk, created_at, updated_at) VALUES ('persona_1', 'Player', '', 0, 0, '2026-01-01', '2026-01-01')`,
  );
  await db.run(
    sql`INSERT INTO chats (id, character_id, active_branch_id, title, created_at, updated_at) VALUES ('chat_1', 'char_1', 'branch_1', 'Test Chat', '2026-01-01', '2026-01-01')`,
  );
  await db.run(
    sql`INSERT INTO chat_branches (id, chat_id, label, created_at) VALUES ('branch_1', 'chat_1', 'Main', '2026-01-01')`,
  );
}

let msgPosition = 0;
async function seedMessage(db: AppDb, msgId: string) {
  await db.run(
    sql`INSERT INTO messages (id, chat_id, branch_id, role, author_type, position, content, state, created_at, updated_at) VALUES (${msgId}, 'chat_1', 'branch_1', 'user', 'user', ${msgPosition++}, 'Hello', 'complete', '2026-01-01', '2026-01-01')`,
  );
}

function makeRoll(overrides: Record<string, unknown> = {}) {
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("DiceRollStore", () => {
  let db: AppDb;
  let store: DiceRollStore;

  beforeEach(async () => {
    resetCounter();
    db = await setupDb();
    await seedParents(db);
    store = new DiceRollStore(db, { clock: fixedClock, idGenerator: idGen });
  });

  // ─── Lane operations ────────────────────────────────────────────────────

  describe("getOrCreateLane", () => {
    test("creates a new lane with revision 0", async () => {
      const lane = await store.getOrCreateLane("chat_1", "branch_1", "normal");
      expect(lane.chatId).toBe("chat_1");
      expect(lane.branchId).toBe("branch_1");
      expect(lane.mode).toBe("normal");
      expect(lane.revision).toBe(0);
      expect(lane.createdAt).toBe("2026-07-21T00:00:00.000Z");
    });

    test("returns the same lane on second call (durable)", async () => {
      const lane1 = await store.getOrCreateLane("chat_1", "branch_1", "normal");
      const lane2 = await store.getOrCreateLane("chat_1", "branch_1", "normal");
      expect(lane2.id).toBe(lane1.id);
      expect(lane2.revision).toBe(lane1.revision);
    });

    test("empty lane retains/increases revision", async () => {
      const lane = await store.getOrCreateLane("chat_1", "branch_1", "immersive");
      expect(lane.revision).toBe(0);
      // Lane persists even without rolls.
      const lane2 = await store.getOrCreateLane("chat_1", "branch_1", "immersive");
      expect(lane2.revision).toBe(0);
    });
  });

  // ─── Roll creation + idempotency ────────────────────────────────────────

  describe("createRoll", () => {
    test("creates a roll and bumps lane revision", async () => {
      const roll = await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        ...makeRoll(),
      });
      expect(roll.actorType).toBe("persona");
      expect(roll.actorLabel).toBe("Player");
      expect(roll.boundMessageId).toBeNull();
      expect(roll.included).toBe(true);

      // Lane revision should be 1 (bumped from 0).
      const lane = await store.getOrCreateLane("chat_1", "branch_1", "normal");
      expect(lane.revision).toBe(1);
    });

    test("idempotent on requestId — duplicate returns existing", async () => {
      const roll1 = await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        ...makeRoll({ requestId: "req_dup" }),
      });
      const roll2 = await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        ...makeRoll({ requestId: "req_dup" }),
      });
      expect(roll2.id).toBe(roll1.id);
      // Lane revision should only be 1 (not 2), since the second call was a no-op.
      const lane = await store.getOrCreateLane("chat_1", "branch_1", "normal");
      expect(lane.revision).toBe(1);
    });

    test("different requestIds create separate rolls", async () => {
      const roll1 = await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        ...makeRoll({ requestId: "req_a" }),
      });
      const roll2 = await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        ...makeRoll({ requestId: "req_b" }),
      });
      expect(roll2.id).not.toBe(roll1.id);
      const lane = await store.getOrCreateLane("chat_1", "branch_1", "normal");
      expect(lane.revision).toBe(2);
    });
  });

  // ─── Normal mode ────────────────────────────────────────────────────────

  describe("Normal mode: replace/remove/clear", () => {
    test("replaceNormalPending replaces same actor+check", async () => {
      await store.replaceNormalPending({
        chatId: "chat_1",
        branchId: "branch_1",
        ...makeRoll({ requestId: "req_1" }),
      });
      // Second roll for same actor+check — should replace.
      const roll2 = await store.replaceNormalPending({
        chatId: "chat_1",
        branchId: "branch_1",
        ...makeRoll({ requestId: "req_2" }),
      });
      const lane = await store.getOrCreateLane("chat_1", "branch_1", "normal");
      const rolls = (await store.listPending("chat_1", "branch_1")).normal.rolls;
      expect(rolls.length).toBe(1);
      expect(rolls[0]!.id).toBe(roll2.id);
      // Revision: create(1) + delete(no bump) + create(2) = 2
      expect(lane.revision).toBe(2);
    });

    test("replaceNormalPending does NOT replace different check", async () => {
      await store.replaceNormalPending({
        chatId: "chat_1",
        branchId: "branch_1",
        ...makeRoll({ requestId: "req_1", checkId: "check_a" }),
      });
      await store.replaceNormalPending({
        chatId: "chat_1",
        branchId: "branch_1",
        ...makeRoll({ requestId: "req_2", checkId: "check_b" }),
      });
      const rolls = (await store.listPending("chat_1", "branch_1")).normal.rolls;
      expect(rolls.length).toBe(2);
    });

    test("removeRoll removes a specific roll", async () => {
      const roll = await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        ...makeRoll({ requestId: "req_rem" }),
      });
      await store.removeRoll(roll.id);
      const rolls = (await store.listPending("chat_1", "branch_1")).normal.rolls;
      expect(rolls.length).toBe(0);
    });

    test("clearNormalLane removes all unbound normal rolls", async () => {
      await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        ...makeRoll({ requestId: "req_1" }),
      });
      await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        ...makeRoll({ requestId: "req_2", checkId: "check_b" }),
      });
      await store.clearNormalLane("chat_1", "branch_1");
      const rolls = (await store.listPending("chat_1", "branch_1")).normal.rolls;
      expect(rolls.length).toBe(0);
    });
  });

  // ─── Immersive mode ─────────────────────────────────────────────────────

  describe("Immersive mode: compare-and-append, conflict", () => {
    test("compareAndAppendAttempt creates new roll when no existingRollId", async () => {
      const lane = await store.getOrCreateLane("chat_1", "branch_1", "immersive");
      const result = await store.compareAndAppendAttempt({
        chatId: "chat_1",
        branchId: "branch_1",
        expectedRevision: 0,
        requestId: "req_imm_1",
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
        newAttemptJson: JSON.stringify({
          attemptId: "attempt_1",
          faces: [1, 0, -1, 1],
          modifier: 0,
          subtotal: 1,
          total: 1,
        }),
        finalJson: null,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.roll.mode).toBe("immersive");
        const attempts = JSON.parse(result.roll.attemptsJson);
        expect(attempts.length).toBe(1);
      }
    });

    test("compareAndAppendAttempt rejects on stale revision", async () => {
      const lane = await store.getOrCreateLane("chat_1", "branch_1", "immersive");
      // Bump revision by creating a roll.
      await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        mode: "immersive",
        requestId: "req_bump",
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
        attemptsJson: JSON.stringify([
          { attemptId: "attempt_1", faces: [1], modifier: 0, subtotal: 1, total: 1 },
        ]),
        finalJson: null,
      });
      // Now try with stale revision (0, but lane is at 1).
      const result = await store.compareAndAppendAttempt({
        chatId: "chat_1",
        branchId: "branch_1",
        expectedRevision: 0, // stale!
        requestId: "req_new",
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
        newAttemptJson: JSON.stringify({
          attemptId: "attempt_2",
          faces: [0, 1, -1, 0],
          modifier: 0,
          subtotal: 0,
          total: 0,
        }),
        finalJson: null,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.conflict).toBe("stale_revision");
      }
    });

    test("compareAndAppendAttempt appends to existing roll", async () => {
      const roll = await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        mode: "immersive",
        requestId: "req_base",
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
        attemptsJson: JSON.stringify([
          { attemptId: "attempt_1", faces: [1], modifier: 0, subtotal: 1, total: 1 },
        ]),
        finalJson: null,
      });
      const result = await store.compareAndAppendAttempt({
        chatId: "chat_1",
        branchId: "branch_1",
        expectedRevision: 1, // current after create
        requestId: "req_base",
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
        existingRollId: roll.id,
        newAttemptJson: JSON.stringify({
          attemptId: "attempt_2",
          faces: [-1, 0, 1, 1],
          modifier: 0,
          subtotal: 1,
          total: 1,
          grantReason: "Second chance",
        }),
        finalJson: null,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const attempts = JSON.parse(result.roll.attemptsJson);
        expect(attempts.length).toBe(2);
        expect(attempts[1].grantReason).toBe("Second chance");
      }
    });
  });

  // ─── Include/exclude and choose ─────────────────────────────────────────

  describe("setIncluded + chooseFinalAttempt", () => {
    test("setIncluded toggles included state and bumps revision", async () => {
      const roll = await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        mode: "immersive",
        ...makeRoll({ requestId: "req_inc", mode: "immersive" }),
      });
      expect(roll.included).toBe(true);
      await store.setIncluded(roll.id, false);
      const updated = await store.getRollById(roll.id);
      expect(updated!.included).toBe(false);
      // Lane revision bumped.
      const lane = await store.getOrCreateLane("chat_1", "branch_1", "immersive");
      expect(lane.revision).toBe(2); // create(1) + setIncluded(2)
    });

    test("chooseFinalAttempt sets finalAttemptId and marks attempt", async () => {
      const roll = await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        mode: "immersive",
        ...makeRoll({
          requestId: "req_choose",
          mode: "immersive",
          attemptsJson: JSON.stringify([
            { attemptId: "a1", faces: [1], modifier: 0, subtotal: 1, total: 1 },
            { attemptId: "a2", faces: [2], modifier: 0, subtotal: 2, total: 2 },
          ]),
        }),
      });
      await store.chooseFinalAttempt(roll.id, "a2");
      const updated = await store.getRollById(roll.id);
      expect(updated!.finalAttemptId).toBe("a2");
      const attempts = JSON.parse(updated!.attemptsJson);
      expect(attempts[0].chosenFinal).toBe(false);
      expect(attempts[1].chosenFinal).toBe(true);
    });
  });

  // ─── listPending ────────────────────────────────────────────────────────

  describe("listPending", () => {
    test("returns both lanes with rolls", async () => {
      await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        mode: "normal",
        ...makeRoll({ requestId: "req_n1", mode: "normal" }),
      });
      await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        mode: "immersive",
        ...makeRoll({ requestId: "req_i1", mode: "immersive" }),
      });
      const pending = await store.listPending("chat_1", "branch_1");
      expect(pending.normal.rolls.length).toBe(1);
      expect(pending.immersive.rolls.length).toBe(1);
      expect(pending.normal.rolls[0]!.mode).toBe("normal");
      expect(pending.immersive.rolls[0]!.mode).toBe("immersive");
    });
  });

  // ─── Actor isolation ────────────────────────────────────────────────────

  describe("actor isolation", () => {
    test("rolls for different actors are isolated", async () => {
      await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        ...makeRoll({ requestId: "req_p1", actorType: "persona", actorId: "persona_1" }),
      });
      await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        ...makeRoll({ requestId: "req_c1", actorType: "character", actorId: "char_1" }),
      });
      const rolls = (await store.listPending("chat_1", "branch_1")).normal.rolls;
      expect(rolls.length).toBe(2);
      expect(rolls.some((r) => r.actorId === "persona_1")).toBe(true);
      expect(rolls.some((r) => r.actorId === "char_1")).toBe(true);
    });

    test("rolls for different branches are isolated", async () => {
      await db.run(
        sql`INSERT INTO chat_branches (id, chat_id, label, created_at) VALUES ('branch_2', 'chat_1', 'Branch 2', '2026-01-01')`,
      );
      await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        ...makeRoll({ requestId: "req_b1" }),
      });
      await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_2",
        ...makeRoll({ requestId: "req_b2" }),
      });
      const pending1 = await store.listPending("chat_1", "branch_1");
      const pending2 = await store.listPending("chat_1", "branch_2");
      expect(pending1.normal.rolls.length).toBe(1);
      expect(pending2.normal.rolls.length).toBe(1);
    });
  });

  // ─── bindActiveAndReset ─────────────────────────────────────────────────

  describe("bindActiveAndReset", () => {
    test("binds included active-mode rolls and resets both lanes", async () => {
      await seedMessage(db, "msg_1");
      // Create normal and immersive rolls.
      await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        mode: "normal",
        ...makeRoll({ requestId: "req_n", mode: "normal" }),
      });
      await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        mode: "immersive",
        ...makeRoll({ requestId: "req_i", mode: "immersive" }),
      });

      // Bind normal mode with revision 1 (after create).
      const bound = await store.bindActiveAndReset("chat_1", "branch_1", "normal", 1, "msg_1");
      expect(bound).toBe(1);

      // The normal roll is bound to msg_1 — read via the historical path
      // (getRollsForMessage). listPending excludes bound rolls by design
      // (a consumed roll is no longer pending; the next turn starts empty).
      const boundRolls = await store.getRollsForMessage("msg_1");
      expect(boundRolls.length).toBe(1);
      expect(boundRolls[0]!.boundMessageId).toBe("msg_1");
      expect((await store.listPending("chat_1", "branch_1")).normal.rolls.length).toBe(0);

      // Immersive lane's unbound roll should be discarded.
      const iRolls = (await store.listPending("chat_1", "branch_1")).immersive.rolls;
      expect(iRolls.length).toBe(0);

      // Both lanes should have revision incremented (normal: 1→2, immersive: 1→2).
      const normalLane = await store.getOrCreateLane("chat_1", "branch_1", "normal");
      const immersiveLane = await store.getOrCreateLane("chat_1", "branch_1", "immersive");
      expect(normalLane.revision).toBe(2);
      expect(immersiveLane.revision).toBe(2);
    });

    test("rejects on stale revision", async () => {
      await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        mode: "normal",
        ...makeRoll({ requestId: "req_stale", mode: "normal" }),
      });
      // Try binding with wrong revision.
      try {
        await store.bindActiveAndReset("chat_1", "branch_1", "normal", 99, "msg_x");
        expect(true).toBe(false); // should not reach
      } catch (e) {
        expect(e).toBeInstanceOf(DiceBindError);
        expect((e as DiceBindError).code).toBe("stale_revision");
      }
    });

    test("rejects unresolved choose policy", async () => {
      await seedMessage(db, "msg_choose");
      await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        mode: "immersive",
        ...makeRoll({
          requestId: "req_choose_bind",
          mode: "immersive",
          policy: "choose",
          finalAttemptId: null, // unresolved
        }),
      });
      try {
        await store.bindActiveAndReset("chat_1", "branch_1", "immersive", 1, "msg_choose");
        expect(true).toBe(false);
      } catch (e) {
        expect(e).toBeInstanceOf(DiceBindError);
        expect((e as DiceBindError).code).toBe("unresolved_choose");
      }
    });

    test("excluded rolls are not bound", async () => {
      await seedMessage(db, "msg_excl");
      const roll = await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        mode: "immersive",
        ...makeRoll({ requestId: "req_excl", mode: "immersive" }),
      });
      await store.setIncluded(roll.id, false);
      const bound = await store.bindActiveAndReset("chat_1", "branch_1", "immersive", 2, "msg_excl");
      expect(bound).toBe(0);
    });
  });

  // ─── rollbackRelease ────────────────────────────────────────────────────

  describe("rollbackRelease", () => {
    test("releases bindings when message is rolled back", async () => {
      await seedMessage(db, "msg_rb");
      const roll = await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        mode: "normal",
        ...makeRoll({ requestId: "req_rb", mode: "normal" }),
      });
      await store.bindActiveAndReset("chat_1", "branch_1", "normal", 1, "msg_rb");
      // Verify bound.
      const r = await store.getRollById(roll.id);
      expect(r!.boundMessageId).toBe("msg_rb");

      // Rollback.
      await store.rollbackRelease("msg_rb");
      const r2 = await store.getRollById(roll.id);
      expect(r2!.boundMessageId).toBeNull();
    });
  });

  // ─── deleteRollsWithMessage ─────────────────────────────────────────────

  describe("deleteRollsWithMessage", () => {
    test("deletes all rolls bound to a message", async () => {
      await seedMessage(db, "msg_del");
      await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        mode: "normal",
        ...makeRoll({ requestId: "req_del1", mode: "normal" }),
      });
      await store.bindActiveAndReset("chat_1", "branch_1", "normal", 1, "msg_del");
      await store.deleteRollsWithMessage("msg_del");
      const rolls = await store.getRollsForMessage("msg_del");
      expect(rolls.length).toBe(0);
    });
  });

  // ─── forkCopyRolls ──────────────────────────────────────────────────────

  describe("forkCopyRolls", () => {
    test("copies all rolls from one message to another", async () => {
      await seedMessage(db, "msg_src");
      await seedMessage(db, "msg_dst");
      await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        mode: "normal",
        ...makeRoll({ requestId: "req_fork1", mode: "normal" }),
      });
      await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        mode: "normal",
        ...makeRoll({ requestId: "req_fork2", mode: "normal", checkId: "check_b" }),
      });
      await store.bindActiveAndReset("chat_1", "branch_1", "normal", 2, "msg_src");

      await store.forkCopyRolls("msg_src", "msg_dst");
      const dstRolls = await store.getRollsForMessage("msg_dst");
      expect(dstRolls.length).toBe(2);
      // Copied rolls have new ids.
      expect(dstRolls[0]!.boundMessageId).toBe("msg_dst");
      expect(dstRolls[1]!.boundMessageId).toBe("msg_dst");
    });
  });

  // ─── No-cascade (script delete keeps rolls) ─────────────────────────────

  describe("no-cascade: script delete keeps rolls", () => {
    test("rolls survive when their script_id no longer exists in scripts table", async () => {
      // Create a script row so we can reference it, then delete it.
      await db.run(
        sql`INSERT INTO scripts (id, name, code, script_kind, scope_type, created_at, updated_at) VALUES ('script_vanish', 'Vanishing Script', 'code', 'dice', 'global', '2026-01-01', '2026-01-01')`,
      );
      await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        mode: "normal",
        ...makeRoll({
          requestId: "req_nocascade",
         scriptId: "script_vanish",
          scriptLabel: "Vanishing Script",
          mode: "normal",
        }),
      });
      // Delete the script (simulates user deleting a dice script).
      await db.run(sql`DELETE FROM scripts WHERE id = 'script_vanish'`);
      // Roll should still exist with its snapshot.
      const rolls = (await store.listPending("chat_1", "branch_1")).normal.rolls;
      expect(rolls.length).toBe(1);
      expect(rolls[0]!.scriptId).toBe("script_vanish");
      expect(rolls[0]!.scriptLabel).toBe("Vanishing Script");
    });
  });

  // ─── getRollsForMessages (batch read) ───────────────────────────────────

  describe("getRollsForMessages", () => {
    test("batch reads rolls for multiple messages", async () => {
      await seedMessage(db, "msg_b1");
      await seedMessage(db, "msg_b2");

      // Roll for msg_b1. createRoll bumps revision to 1.
      await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        mode: "normal",
        ...makeRoll({ requestId: "req_b1", mode: "normal" }),
      });
      await store.bindActiveAndReset("chat_1", "branch_1", "normal", 1, "msg_b1");
      // After bind: revision is 2.

      // Roll for msg_b2. createRoll bumps revision to 3.
      await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        mode: "normal",
        ...makeRoll({ requestId: "req_b2", mode: "normal", checkId: "check_b" }),
      });
      await store.bindActiveAndReset("chat_1", "branch_1", "normal", 3, "msg_b2");

      const map = await store.getRollsForMessages(["msg_b1", "msg_b2"]);
      expect(map.get("msg_b1")!.length).toBe(1);
      expect(map.get("msg_b2")!.length).toBe(1);
    });
  });

  // ─── Legacy DB applies cleanly ──────────────────────────────────────────

  describe("legacy DB", () => {
    test("fresh DB has empty lanes and no rolls", async () => {
      const pending = await store.listPending("chat_1", "branch_1");
      expect(pending.normal.rolls.length).toBe(0);
      expect(pending.immersive.rolls.length).toBe(0);
      // Both lanes created with revision 0.
      expect(pending.normal.revision).toBe(0);
      expect(pending.immersive.revision).toBe(0);
    });
  });

  // ─── Revision monotonicity ──────────────────────────────────────────────

  describe("revision monotonicity", () => {
    test("every pending mutation increments revision", async () => {
      // Create → revision 1.
      const roll = await store.createRoll({
        chatId: "chat_1",
        branchId: "branch_1",
        mode: "immersive",
        ...makeRoll({ requestId: "req_mono", mode: "immersive" }),
      });
      let lane = await store.getOrCreateLane("chat_1", "branch_1", "immersive");
      expect(lane.revision).toBe(1);

      // setIncluded → revision 2.
      await store.setIncluded(roll.id, false);
      lane = await store.getOrCreateLane("chat_1", "branch_1", "immersive");
      expect(lane.revision).toBe(2);

      // setIncluded back → revision 3.
      await store.setIncluded(roll.id, true);
      lane = await store.getOrCreateLane("chat_1", "branch_1", "immersive");
      expect(lane.revision).toBe(3);

      // chooseFinalAttempt → revision 4.
      await store.chooseFinalAttempt(roll.id, "attempt_1");
      lane = await store.getOrCreateLane("chat_1", "branch_1", "immersive");
      expect(lane.revision).toBe(4);
    });
  });
});
