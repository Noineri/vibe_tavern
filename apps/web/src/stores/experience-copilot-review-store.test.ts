/**
 * Experience-copilot review ROUND store — unit contract (the mount-independent
 * half of CD-2).
 *
 * Pins: per-thread slice isolation; snapshot push/pop monotonic ids;
 * per-buffer accepted/dismissed set replacement; `ensureReviewKey` resetting a
 * buffer's sets ONLY on a real key change (a matching key is a no-op — the
 * remount-preservation contract); dangling capture/clear; resetRound.
 * The hook facade (edge detection, derived values) is pinned separately in
 * `use-copilot-review-state.test.ts`; the localStorage envelope is pinned in
 * `experience-copilot-draft.test.ts`.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import {
  EMPTY_REVIEW_ROUND,
  useCopilotReviewRoundStore,
} from "./experience-copilot-review-store.js";

beforeEach(() => {
  useCopilotReviewRoundStore.setState({ roundsByThread: {} });
});

describe("experience-copilot-review-round store", () => {
  it("starts empty and reads the shared frozen empty round for unknown threads", () => {
    expect(useCopilotReviewRoundStore.getState().roundsByThread).toEqual({});
    expect(useCopilotReviewRoundStore.getState().roundsByThread["nope"]).toBeUndefined();
  });

  it("pushes snapshots with monotonic per-thread ids and pops the last one", () => {
    const store = useCopilotReviewRoundStore.getState();
    store.pushSnapshot("t1", { rules: "r1", visual: "v1" });
    store.pushSnapshot("t1", { rules: "r2", visual: "v2" });

    const round = useCopilotReviewRoundStore.getState().roundsByThread["t1"]!;
    expect(round.snapshots.map((s) => s.id)).toEqual([1, 2]);
    expect(round.snapshots[1]).toMatchObject({ rules: "r2", visual: "v2" });
    expect(round.nextSnapshotId).toBe(3);

    const popped = useCopilotReviewRoundStore.getState().popSnapshot("t1");
    expect(popped).toMatchObject({ id: 2, rules: "r2", visual: "v2" });
    expect(useCopilotReviewRoundStore.getState().roundsByThread["t1"]!.snapshots).toHaveLength(1);
  });

  it("popSnapshot returns null on an empty stack without creating a slice", () => {
    expect(useCopilotReviewRoundStore.getState().popSnapshot("t1")).toBeNull();
    expect(useCopilotReviewRoundStore.getState().roundsByThread).toEqual({});
  });

  it("isolates threads completely (one script's round never leaks into another)", () => {
    const store = useCopilotReviewRoundStore.getState();
    store.pushSnapshot("t1", { rules: "r1", visual: "v1" });
    store.setAcceptedHunks("t2", "rules", [0, 1]);

    const t1 = useCopilotReviewRoundStore.getState().roundsByThread["t1"]!;
    const t2 = useCopilotReviewRoundStore.getState().roundsByThread["t2"]!;
    expect(t1.snapshots).toHaveLength(1);
    expect(t1.acceptedRules).toEqual([]);
    expect(t2.snapshots).toEqual([]);
    expect(t2.acceptedRules).toEqual([0, 1]);
  });

  it("replaces (not merges) accepted/dismissed sets per buffer", () => {
    const store = useCopilotReviewRoundStore.getState();
    store.setAcceptedHunks("t1", "rules", [0]);
    store.setAcceptedHunks("t1", "rules", [1, 2]);
    store.setDismissedHunks("t1", "visual", [5]);
    const round = useCopilotReviewRoundStore.getState().roundsByThread["t1"]!;
    expect(round.acceptedRules).toEqual([1, 2]);
    expect(round.acceptedVisual).toEqual([]);
    expect(round.dismissedVisual).toEqual([5]);
    expect(round.dismissedRules).toEqual([]);
  });

  it("ensureReviewKey resets the buffer's sets ONLY on a real key change", () => {
    const store = useCopilotReviewRoundStore.getState();
    store.ensureReviewKey("t1", "rules", "key-a");
    store.setAcceptedHunks("t1", "rules", [0]);
    store.setDismissedHunks("t1", "rules", [1]);

    // Same key (e.g. a remount with the same proposal): a NO-OP — the accept /
    // dismiss progress must survive. This is the remount-preservation contract.
    useCopilotReviewRoundStore.getState().ensureReviewKey("t1", "rules", "key-a");
    let round = useCopilotReviewRoundStore.getState().roundsByThread["t1"]!;
    expect(round.rulesKey).toBe("key-a");
    expect(round.acceptedRules).toEqual([0]);
    expect(round.dismissedRules).toEqual([1]);

    // A new proposal (different key) restarts the buffer's sets…
    useCopilotReviewRoundStore.getState().ensureReviewKey("t1", "rules", "key-b");
    round = useCopilotReviewRoundStore.getState().roundsByThread["t1"]!;
    expect(round.rulesKey).toBe("key-b");
    expect(round.acceptedRules).toEqual([]);
    expect(round.dismissedRules).toEqual([]);

    // …including the revert path's null key, and WITHOUT touching the OTHER buffer.
    store.setAcceptedHunks("t1", "visual", [7]);
    useCopilotReviewRoundStore.getState().ensureReviewKey("t1", "rules", null);
    round = useCopilotReviewRoundStore.getState().roundsByThread["t1"]!;
    expect(round.rulesKey).toBeNull();
    expect(round.acceptedVisual).toEqual([7]);
    expect(round.visualKey).toBeNull();
  });

  it("captures and clears the dangling proposal (CD-8)", () => {
    const store = useCopilotReviewRoundStore.getState();
    const capture = { rules: "R2", baseRules: "R1", baseVisual: "V1" };
    store.captureDangling("t1", capture);
    expect(useCopilotReviewRoundStore.getState().roundsByThread["t1"]!.dangling).toEqual(capture);

    useCopilotReviewRoundStore.getState().clearDangling("t1");
    expect(useCopilotReviewRoundStore.getState().roundsByThread["t1"]!.dangling).toBeNull();
    // The rest of the round survives the clear (revert clears only dangling).
    expect(useCopilotReviewRoundStore.getState().roundsByThread["t1"]!.snapshots).toEqual([]);
  });

  it("resetRound drops the whole thread slice and is a no-op for unknown threads", () => {
    const store = useCopilotReviewRoundStore.getState();
    store.pushSnapshot("t1", { rules: "r", visual: "v" });
    useCopilotReviewRoundStore.getState().resetRound("t1");
    expect(useCopilotReviewRoundStore.getState().roundsByThread).toEqual({});

    useCopilotReviewRoundStore.getState().resetRound("never");
    expect(useCopilotReviewRoundStore.getState().roundsByThread).toEqual({});
  });

  it("the frozen empty round carries the full default shape", () => {
    expect(EMPTY_REVIEW_ROUND).toEqual({
      snapshots: [],
      nextSnapshotId: 1,
      acceptedRules: [],
      acceptedVisual: [],
      dismissedRules: [],
      dismissedVisual: [],
      rulesKey: null,
      visualKey: null,
      dangling: null,
    });
  });
});
