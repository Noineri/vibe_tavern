/**
 * DICE-F2_dice_store — revision-aware per-chat+branch pending store.
 *
 * Pins the server-authoritative lane mirror at the store boundary: Normal
 * replace/remove/clear, Immersive include/choose with optimistic-flip →
 * confirm-or-rollback, stale-revision resync, two-scope isolation, requestId
 * reuse across an in-flight retry (idempotency), and the no-bound-data cache
 * rule. The seven network calls in `dice-api.js` are mocked via the
 * spread-real-then-override pattern (vitest `importOriginal`), keeping the
 * genuine `DiceApiError` class for the stale-revision path.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { brandId, type DiceRollId, type MessageId } from "@vibe-tavern/domain";
import type {
  DiceDefinitionsResponse,
  DiceLaneState,
  DicePendingState,
  DiceRollRequest,
  DiceRollSnapshot,
} from "../api/types.js";
import { DiceApiError } from "../api/dice-api.js";
import { useDiceStore, type DiceRollIntent } from "./dice-store.js";

// ── Mock the dice-api network layer (spread real, override the 7 calls) ──────

interface Impl {
  getDiceDefinitions: (chatId: string) => Promise<DiceDefinitionsResponse>;
  getDicePending: (chatId: string, branchId: string) => Promise<DicePendingState>;
  rollDice: (chatId: string, body: DiceRollRequest) => Promise<DiceRollSnapshot>;
  removeDiceRoll: (chatId: string, rollId: string) => Promise<void>;
  clearDiceLane: (chatId: string, branchId: string) => Promise<void>;
  setDiceRollIncluded: (chatId: string, rollId: string, included: boolean) => Promise<void>;
  chooseDiceAttempt: (chatId: string, rollId: string, attemptId: string) => Promise<void>;
}

let impl: Impl;
const rollCalls: Array<{ chatId: string; body: DiceRollRequest }> = [];

vi.mock("../api/dice-api.js", async (importOriginal) => {
  const real = await importOriginal() as typeof import("../api/dice-api.js");
  return {
    ...real,
    getDiceDefinitions: (chatId: string) => impl.getDiceDefinitions(chatId),
    getDicePending: (chatId: string, branchId: string) => impl.getDicePending(chatId, branchId),
    rollDice: (chatId: string, body: DiceRollRequest) => {
      rollCalls.push({ chatId, body });
      return impl.rollDice(chatId, body);
    },
    removeDiceRoll: (chatId: string, rollId: string) => impl.removeDiceRoll(chatId, rollId),
    clearDiceLane: (chatId: string, branchId: string) => impl.clearDiceLane(chatId, branchId),
    setDiceRollIncluded: (chatId: string, rollId: string, included: boolean) => impl.setDiceRollIncluded(chatId, rollId, included),
    chooseDiceAttempt: (chatId: string, rollId: string, attemptId: string) => impl.chooseDiceAttempt(chatId, rollId, attemptId),
  };
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const C1 = "c1";
const B1 = "b1";
const B2 = "b2";
const KEY_B1 = `${C1}|${B1}`;
const KEY_B2 = `${C1}|${B2}`;

let rollCounter = 0;
function makeRoll(overrides: Partial<DiceRollSnapshot> = {}): DiceRollSnapshot {
  rollCounter += 1;
  const n = rollCounter;
  return {
    rollId: brandId<DiceRollId>(`roll-${n}`),
    requestId: `req-${n}`,
    actor: { actorType: "character", actorId: "char-1", actorLabel: "Hero" },
    scriptId: "script-1",
    scriptLabel: "Fate Die",
    scriptRevision: 1,
    checkId: "check-1",
    checkLabel: "Luck",
    notation: "1d20",
    faceShape: "d20",
    resolution: "narrative",
    mode: "normal",
    included: true,
    finalAttemptId: null,
    attempts: [{ attemptId: "att-1", faces: [10], modifier: 0, subtotal: 10, total: 10 }],
    boundMessageId: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function lane(revision: number, rolls: DiceRollSnapshot[]): DiceLaneState {
  return { revision, rolls };
}

function makePending(normal: DiceLaneState, immersive: DiceLaneState): DicePendingState {
  return { normal, immersive };
}

function makeDefinitions(): DiceDefinitionsResponse {
  return {
    scripts: [
      {
        scriptId: "script-1",
        scriptLabel: "Fate Die",
        scriptRevision: 1,
        checks: [
          { id: "check-1", label: "Luck", notation: "1d20", actors: ["character", "persona"], resolution: "narrative", faceShape: "d20" },
        ],
      },
    ],
  };
}

function intent(overrides: Partial<DiceRollIntent> = {}): DiceRollIntent {
  return { scriptId: "script-1", checkId: "check-1", actorType: "character", actorId: "char-1", mode: "normal", ...overrides };
}

function scope(key: string) {
  return useDiceStore.getState().byScope[key];
}

function emptyPending(): DicePendingState {
  return makePending(lane(1, []), lane(1, []));
}

beforeEach(() => {
  useDiceStore.setState({ byScope: {}, activeScope: null });
  rollCalls.length = 0;
  impl = {
    getDiceDefinitions: async () => makeDefinitions(),
    getDicePending: async () => emptyPending(),
    rollDice: async (_chatId, body) => makeRoll({ requestId: body.requestId }),
    removeDiceRoll: async () => {},
    clearDiceLane: async () => {},
    setDiceRollIncluded: async () => {},
    chooseDiceAttempt: async () => {},
  };
});

// ── Definitions + rehydration ────────────────────────────────────────────────

describe("dice-store — definitions + scope rehydration", () => {
  test("loadDefinitions stores the enabled-script definitions for the scope", async () => {
    await useDiceStore.getState().loadDefinitions(C1, B1);
    expect(scope(KEY_B1)?.definitions?.scripts).toHaveLength(1);
    expect(scope(KEY_B1)?.definitions?.scripts[0].checks[0].id).toBe("check-1");
  });

  test("setScope records the active scope and rehydrates definitions + pending", async () => {
    let definitionsCalls = 0;
    let pendingCalls = 0;
    impl.getDiceDefinitions = async () => { definitionsCalls += 1; return makeDefinitions(); };
    impl.getDicePending = async () => { pendingCalls += 1; return emptyPending(); };
    useDiceStore.getState().setScope(C1, B1);
    // rehydrate is fire-and-forget; flush the microtask queue.
    await Promise.resolve();
    await Promise.resolve();
    expect(useDiceStore.getState().activeScope).toEqual({ chatId: C1, branchId: B1 });
    expect(definitionsCalls).toBe(1);
    expect(pendingCalls).toBe(1);
    expect(scope(KEY_B1)?.definitions).not.toBeNull();
    expect(scope(KEY_B1)?.lanes).not.toBeNull();
  });
});

// ── Roll + Normal replace ────────────────────────────────────────────────────

describe("dice-store — roll + Normal lane", () => {
  test("roll applies the refreshed server lane and returns the requestId", async () => {
    const rolled = makeRoll();
    impl.rollDice = async (_c, body) => makeRoll({ requestId: body.requestId });
    impl.getDicePending = async () => makePending(lane(2, [rolled]), lane(1, []));

    const requestId = await useDiceStore.getState().roll(C1, B1, intent());
    expect(requestId).toBe(rollCalls[0].body.requestId);
    expect(scope(KEY_B1)?.lanes?.normal.rolls.map((r) => r.rollId)).toEqual([rolled.rollId]);
    // In-flight key cleared on completion so a later re-roll mints a fresh id.
    expect(scope(KEY_B1)?.rollingRequestIds).toEqual({});
  });

  test("Normal replace: a second roll's refreshed lane holds only the new result", async () => {
    const first = makeRoll();
    const second = makeRoll();
    impl.getDicePending = async () => makePending(lane(2, [first]), lane(1, []));
    await useDiceStore.getState().roll(C1, B1, intent());
    expect(scope(KEY_B1)?.lanes?.normal.rolls.map((r) => r.rollId)).toEqual([first.rollId]);

    impl.getDicePending = async () => makePending(lane(3, [second]), lane(1, []));
    await useDiceStore.getState().roll(C1, B1, intent());
    // Server-authoritative: the lane shows the replacement, not an accumulation.
    expect(scope(KEY_B1)?.lanes?.normal.rolls.map((r) => r.rollId)).toEqual([second.rollId]);
    expect(scope(KEY_B1)?.lanes?.normal.revision).toBe(3);
  });

  test("requestId is reused across an in-flight retry of the same intent (no dup roll)", async () => {
    const resolvers: Array<(roll: DiceRollSnapshot) => void> = [];
    impl.rollDice = () => new Promise<DiceRollSnapshot>((res) => { resolvers.push(res); });

    const p1 = useDiceStore.getState().roll(C1, B1, intent());
    const p2 = useDiceStore.getState().roll(C1, B1, intent());
    // Both in-flight calls for the same intent share one idempotency key.
    expect(rollCalls).toHaveLength(2);
    expect(rollCalls[0].body.requestId).toBe(rollCalls[1].body.requestId);

    for (const resolve of resolvers) resolve(makeRoll());
    await Promise.all([p1, p2]);
  });

  test("a deliberate re-roll after completion mints a fresh requestId", async () => {
    impl.getDicePending = async () => emptyPending();
    await useDiceStore.getState().roll(C1, B1, intent());
    await useDiceStore.getState().roll(C1, B1, intent());
    expect(rollCalls).toHaveLength(2);
    expect(rollCalls[0].body.requestId).not.toBe(rollCalls[1].body.requestId);
  });
});

// ── Normal remove / clear ────────────────────────────────────────────────────

describe("dice-store — Normal remove + clear", () => {
  test("removeRoll drops the roll (optimistic) and confirms against the server", async () => {
    const keep = makeRoll();
    const drop = makeRoll();
    impl.getDicePending = async () => makePending(lane(2, [keep, drop]), lane(1, []));
    await useDiceStore.getState().refreshPending(C1, B1);
    expect(scope(KEY_B1)?.lanes?.normal.rolls).toHaveLength(2);

    impl.getDicePending = async () => makePending(lane(3, [keep]), lane(1, []));
    await useDiceStore.getState().removeRoll(C1, B1, drop.rollId);
    expect(scope(KEY_B1)?.lanes?.normal.rolls.map((r) => r.rollId)).toEqual([keep.rollId]);
    expect(scope(KEY_B1)?.lastError).toBeNull();
  });

  test("clearLane empties the Normal lane against the server", async () => {
    impl.getDicePending = async () => makePending(lane(2, [makeRoll(), makeRoll()]), lane(1, [makeRoll({ mode: "immersive" })]));
    await useDiceStore.getState().refreshPending(C1, B1);
    expect(scope(KEY_B1)?.lanes?.normal.rolls.length).toBeGreaterThan(0);

    const immersiveRolls = scope(KEY_B1)?.lanes?.immersive.rolls ?? [];
    impl.getDicePending = async () => makePending(lane(3, []), lane(1, immersiveRolls));
    await useDiceStore.getState().clearLane(C1, B1);
    // Normal cleared; Immersive untouched.
    expect(scope(KEY_B1)?.lanes?.normal.rolls).toEqual([]);
    expect(scope(KEY_B1)?.lanes?.immersive.rolls).toHaveLength(immersiveRolls.length);
  });
});

// ── Immersive include / choose (optimistic confirm + rollback) ───────────────

describe("dice-store — Immersive include/choose", () => {
  function seedImmersiveRoll(): DiceRollSnapshot {
    return makeRoll({
      mode: "immersive",
      included: true,
      attempts: [
        { attemptId: "att-1", faces: [5], modifier: 0, subtotal: 5, total: 5 },
        { attemptId: "att-2", faces: [9], modifier: 0, subtotal: 9, total: 9 },
      ],
    });
  }

  test("setIncluded confirms the server-persisted flip", async () => {
    const roll = seedImmersiveRoll();
    impl.getDicePending = async () => makePending(lane(1, []), lane(2, [roll]));
    await useDiceStore.getState().refreshPending(C1, B1);

    impl.getDicePending = async () => makePending(lane(1, []), lane(3, [{ ...roll, included: false }]));
    await useDiceStore.getState().setIncluded(C1, B1, roll.rollId, false);
    expect(scope(KEY_B1)?.lanes?.immersive.rolls[0].included).toBe(false);
    expect(scope(KEY_B1)?.lastError).toBeNull();
  });

  test("setIncluded rolls back the optimistic flip when the server rejects and resync fails", async () => {
    const roll = seedImmersiveRoll();
    impl.getDicePending = async () => makePending(lane(1, []), lane(2, [roll]));
    await useDiceStore.getState().refreshPending(C1, B1);

    impl.setDiceRollIncluded = async () => { throw new DiceApiError(404, "Roll not found", "roll_not_found"); };
    impl.getDicePending = async () => { throw new DiceApiError(500, "resync down"); };
    await useDiceStore.getState().setIncluded(C1, B1, roll.rollId, false);
    // Rollback: included reverts to the pre-mutation snapshot; the error surfaces.
    expect(scope(KEY_B1)?.lanes?.immersive.rolls[0].included).toBe(true);
    expect(scope(KEY_B1)?.lastError).toBe("Roll not found");
  });

  test("chooseAttempt finalizes the chosen attempt (optimistic) and confirms", async () => {
    const roll = seedImmersiveRoll();
    impl.getDicePending = async () => makePending(lane(1, []), lane(2, [roll]));
    await useDiceStore.getState().refreshPending(C1, B1);

    impl.getDicePending = async () =>
      makePending(lane(1, []), lane(3, [{
        ...roll,
        finalAttemptId: "att-2",
        attempts: roll.attempts.map((a) => ({ ...a, chosenFinal: a.attemptId === "att-2" })),
      }]));
    await useDiceStore.getState().chooseAttempt(C1, B1, roll.rollId, "att-2");
    expect(scope(KEY_B1)?.lanes?.immersive.rolls[0].finalAttemptId).toBe("att-2");
    expect(scope(KEY_B1)?.lastError).toBeNull();
  });

  test("chooseAttempt rolls back when the server rejects the choice", async () => {
    const roll = seedImmersiveRoll();
    impl.getDicePending = async () => makePending(lane(1, []), lane(2, [roll]));
    await useDiceStore.getState().refreshPending(C1, B1);

    impl.chooseDiceAttempt = async () => { throw new DiceApiError(422, "Attempt not found", "validation_error"); };
    impl.getDicePending = async () => { throw new DiceApiError(500, "resync down"); };
    await useDiceStore.getState().chooseAttempt(C1, B1, roll.rollId, "att-2");
    expect(scope(KEY_B1)?.lanes?.immersive.rolls[0].finalAttemptId).toBeNull();
    expect(scope(KEY_B1)?.lastError).toBe("Attempt not found");
  });
});

// ── Stale-revision resync ────────────────────────────────────────────────────

describe("dice-store — stale-revision refresh", () => {
  test("a stale-revision conflict resyncs the lane from the server and surfaces the error", async () => {
    const base = makeRoll();
    impl.getDicePending = async () => makePending(lane(1, []), lane(1, [base]));
    await useDiceStore.getState().refreshPending(C1, B1);
    expect(scope(KEY_B1)?.lanes?.immersive.revision).toBe(1);

    // Another tab moved the lane to revision 2; our mutation now conflicts.
    const moved = makeRoll({ included: false });
    impl.setDiceRollIncluded = async () => { throw new DiceApiError(409, "Lane revision changed", "stale_revision"); };
    impl.getDicePending = async () => makePending(lane(1, []), lane(2, [moved]));
    await useDiceStore.getState().setIncluded(C1, B1, base.rollId, false);

    // Server wins: the store reflects the new revision + the other tab's state.
    expect(scope(KEY_B1)?.lanes?.immersive.revision).toBe(2);
    expect(scope(KEY_B1)?.lanes?.immersive.rolls.map((r) => r.rollId)).toEqual([moved.rollId]);
    expect(scope(KEY_B1)?.lastError).toBe("Lane revision changed");
  });
});

// ── Two-scope isolation ──────────────────────────────────────────────────────

describe("dice-store — two-scope isolation", () => {
  test("lanes and mutations stay isolated per chat+branch key", async () => {
    const rollB1 = makeRoll();
    const rollB2 = makeRoll();
    impl.getDicePending = async (_c, branchId) =>
      branchId === B1 ? makePending(lane(1, [rollB1]), lane(1, [])) : makePending(lane(1, [rollB2]), lane(1, []));

    await useDiceStore.getState().refreshPending(C1, B1);
    await useDiceStore.getState().refreshPending(C1, B2);
    expect(scope(KEY_B1)?.lanes?.normal.rolls.map((r) => r.rollId)).toEqual([rollB1.rollId]);
    expect(scope(KEY_B2)?.lanes?.normal.rolls.map((r) => r.rollId)).toEqual([rollB2.rollId]);

    // Removing from B1 leaves B2 untouched.
    impl.getDicePending = async (_c, branchId) =>
      branchId === B1 ? makePending(lane(2, []), lane(1, [])) : makePending(lane(1, [rollB2]), lane(1, []));
    await useDiceStore.getState().removeRoll(C1, B1, rollB1.rollId);
    expect(scope(KEY_B1)?.lanes?.normal.rolls).toEqual([]);
    expect(scope(KEY_B2)?.lanes?.normal.rolls.map((r) => r.rollId)).toEqual([rollB2.rollId]);
  });
});

// ── No bound-data caching ────────────────────────────────────────────────────

describe("dice-store — no bound-data caching", () => {
  test("refreshPending drops rolls already bound to a message", async () => {
    const pending = makeRoll();
    const bound = makeRoll({ boundMessageId: brandId<MessageId>("msg-1") });
    impl.getDicePending = async () => makePending(lane(1, [pending, bound]), lane(1, []));
    await useDiceStore.getState().refreshPending(C1, B1);
    expect(scope(KEY_B1)?.lanes?.normal.rolls.map((r) => r.rollId)).toEqual([pending.rollId]);
  });
});
