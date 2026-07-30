/**
 * DICE-F9_pending_continuity — active-generation capture of the bound Dice
 * bundle, pinned at the store boundary.
 *
 * The pending-continuity invariant: `startGeneration` snapshots the active
 * lane's included rolls into `pendingDiceRolls` (frozen, immune to later lane
 * refreshes) so the pending-user shell can render them until the committed
 * message's own `diceRolls` lands — the badge neither flickers nor duplicates
 * across the pending→committed transition. finish/abort clear the bundle.
 *
 * This mirrors the lane selection in `readDiceSendState` (use-chat-controller)
 * but asserts the captured rolls themselves, not a commit intent. The
 * capture is `pendingContent`-independent (it always reads the active lane),
 * which is what makes attachment-only sends bind Dice exactly like prose.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { brandId, type DiceRollId, type DiceRollSnapshot } from "@vibe-tavern/domain";
import type { AppSnapshot } from "../api/types.js";
import { useChatStore } from "./chat-store.js";
import { useSnapshotStore } from "./snapshot-store.js";
import { useDiceStore } from "./dice-store.js";

const C1 = "c1";
const B1 = "b1";
const KEY = `${C1}|${B1}`;

let n = 0;
function makeRoll(overrides: Partial<DiceRollSnapshot> = {}): DiceRollSnapshot {
  n += 1;
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

function seedSnapshot(opts: { diceEnabled?: boolean; diceMode?: "normal" | "immersive" } = {}): void {
  useSnapshotStore.setState({
    activeChat: {
      id: C1,
      insightsConfig: {
        objectiveEnabled: false,
        trackerEnabled: false,
        diceEnabled: opts.diceEnabled ?? true,
        diceMode: opts.diceMode ?? "normal",
      },
    } as unknown as AppSnapshot["activeChat"],
    activeBranch: { id: B1, chatId: C1, label: "main" } as unknown as AppSnapshot["activeBranch"],
  });
}

function seedLane(rolls: DiceRollSnapshot[], mode: "normal" | "immersive" = "normal"): void {
  useDiceStore.setState({
    byScope: {
      [KEY]: {
        definitions: null,
        lanes: {
          normal: { revision: 5, rolls: mode === "normal" ? rolls : [] },
          immersive: { revision: 5, rolls: mode === "immersive" ? rolls : [] },
        },
        rollingRequestIds: {},
        lastError: null,
      },
    },
  });
}

beforeEach(() => {
  useChatStore.setState({ generations: {} });
  useSnapshotStore.setState({ activeChat: null, activeBranch: null });
  useDiceStore.setState({ byScope: {}, activeScope: null });
});

describe("DICE-F9 chat-store pendingDiceRolls capture", () => {
  test("startGeneration captures the active normal lane's included rolls only", () => {
    const inc1 = makeRoll({ rollId: brandId<DiceRollId>("r-inc-1") });
    const inc2 = makeRoll({ rollId: brandId<DiceRollId>("r-inc-2") });
    const excluded = makeRoll({ rollId: brandId<DiceRollId>("r-excl"), included: false });
    seedSnapshot({ diceEnabled: true, diceMode: "normal" });
    seedLane([inc1, excluded, inc2], "normal");

    useChatStore.getState().startGeneration(C1, "hello", [], null);

    const gen = useChatStore.getState().generations[C1]!;
    expect(gen.pendingDiceRolls.map((r) => String(r.rollId))).toEqual(["r-inc-1", "r-inc-2"]);
  });

  test("captured bundle is frozen — a later lane refresh (server binds rolls) does not mutate it", () => {
    const inc = makeRoll({ rollId: brandId<DiceRollId>("r-inc") });
    seedSnapshot({ diceEnabled: true });
    seedLane([inc], "normal");

    useChatStore.getState().startGeneration(C1, "hi", [], null);
    const captured = useChatStore.getState().generations[C1]!.pendingDiceRolls;

    // Server binds the roll → a refreshPending would drop it from the lane.
    seedLane([], "normal");

    const after = useChatStore.getState().generations[C1]!.pendingDiceRolls;
    expect(after).toBe(captured);
    expect(after.map((r) => String(r.rollId))).toEqual(["r-inc"]);
  });

  test("capture is pendingContent-independent — attachment-only send (empty content) binds Dice like prose", () => {
    const inc = makeRoll({ rollId: brandId<DiceRollId>("r-att") });
    seedSnapshot({ diceEnabled: true });
    seedLane([inc], "normal");

    // Empty draft, attachments present — a real user send, not regenerate.
    useChatStore.getState().startGeneration(C1, "", [{ id: "a1", assetId: "as1", type: "image", name: "f.png", mimeType: "image/png", sizeBytes: 1 }], null);

    expect(useChatStore.getState().generations[C1]!.pendingDiceRolls.map((r) => String(r.rollId))).toEqual(["r-att"]);
  });

  test("captures [] when Dice is disabled (no-Dice send is inert)", () => {
    seedSnapshot({ diceEnabled: false });
    seedLane([makeRoll()], "normal");
    useChatStore.getState().startGeneration(C1, "hi", [], null);
    expect(useChatStore.getState().generations[C1]!.pendingDiceRolls).toEqual([]);
  });

  test("captures [] when the active lane is absent (definitions/pending not loaded yet)", () => {
    seedSnapshot({ diceEnabled: true });
    // No lane seeded.
    useChatStore.getState().startGeneration(C1, "hi", [], null);
    expect(useChatStore.getState().generations[C1]!.pendingDiceRolls).toEqual([]);
  });

  test("captures [] when the lane has rolls but none are included", () => {
    seedSnapshot({ diceEnabled: true });
    seedLane([makeRoll({ included: false }), makeRoll({ included: false })], "normal");
    useChatStore.getState().startGeneration(C1, "hi", [], null);
    expect(useChatStore.getState().generations[C1]!.pendingDiceRolls).toEqual([]);
  });

  test("captures the immersive lane rolls when diceMode is immersive", () => {
    const inc = makeRoll({ rollId: brandId<DiceRollId>("r-imm") });
    seedSnapshot({ diceEnabled: true, diceMode: "immersive" });
    seedLane([inc], "immersive");
    useChatStore.getState().startGeneration(C1, "hi", [], null);
    expect(useChatStore.getState().generations[C1]!.pendingDiceRolls.map((r) => String(r.rollId))).toEqual(["r-imm"]);
  });

  test("finishGeneration clears the captured bundle (pending→committed handoff)", () => {
    seedSnapshot({ diceEnabled: true });
    seedLane([makeRoll()], "normal");
    useChatStore.getState().startGeneration(C1, "hi", [], null);
    expect(useChatStore.getState().generations[C1]!.pendingDiceRolls).toHaveLength(1);

    useChatStore.getState().finishGeneration(C1);

    expect(useChatStore.getState().generations[C1]!.pendingDiceRolls).toEqual([]);
  });

  test("abortGeneration clears the captured bundle (cancelled/rolled-back send)", () => {
    seedSnapshot({ diceEnabled: true });
    seedLane([makeRoll()], "normal");
    useChatStore.getState().startGeneration(C1, "hi", [], null);
    expect(useChatStore.getState().generations[C1]!.pendingDiceRolls).toHaveLength(1);

    useChatStore.getState().abortGeneration(C1);

    expect(useChatStore.getState().generations[C1]!.pendingDiceRolls).toEqual([]);
  });

  test("each chat keeps its own captured bundle (per-chat generation isolation)", () => {
    const inc = makeRoll({ rollId: brandId<DiceRollId>("r-c1") });
    seedSnapshot({ diceEnabled: true });
    seedLane([inc], "normal");

    useChatStore.getState().startGeneration(C1, "hi", [], null);
    // A second chat (no snapshot/dice lane for it) starts a generation too.
    useChatStore.getState().startGeneration("c2", "other", [], null);

    expect(useChatStore.getState().generations[C1]!.pendingDiceRolls.map((r) => String(r.rollId))).toEqual(["r-c1"]);
    expect(useChatStore.getState().generations["c2"]!.pendingDiceRolls).toEqual([]);
  });
});
