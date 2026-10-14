import { beforeEach, describe, expect, it } from "bun:test";
import { useAgentReviewOutcomeStore } from "./agent-review-outcome-store.js";

beforeEach(() => useAgentReviewOutcomeStore.setState({ outcomesByThread: {} }));

describe("agent review outcome ledger", () => {
  it("isolates kind, thread, and target while retaining a completed outcome independently of rounds", () => {
    const store = useAgentReviewOutcomeStore.getState();
    const rules = { target: "rules" as const, roundId: "abc123", outcome: "applied" as const, hunks: { accepted: 2, rejected: 0, pending: 0 } };
    store.record("experience", "thread-a", rules);
    store.record("future", "thread-a", { ...rules, target: "visual", roundId: "def456" });
    expect(store.get("experience", "thread-a", "rules")).toEqual(rules);
    expect(store.get("experience", "thread-a", "visual")).toBeUndefined();
    expect(store.get("future", "thread-a", "visual")?.roundId).toBe("def456");
  });

  it("keeps the latest completed or cancelled result through remount-equivalent reads and later turns", () => {
    const store = useAgentReviewOutcomeStore.getState();
    store.record("experience", "thread-b", { target: "visual", roundId: "aaa111", outcome: "applied-partial", hunks: { accepted: 1, rejected: 0, pending: 2 } });
    store.record("experience", "thread-b", { target: "visual", roundId: "aaa111", outcome: "cancelled", hunks: { accepted: 1, rejected: 2, pending: 0 } });
    expect(useAgentReviewOutcomeStore.getState().get("experience", "thread-b", "visual")).toMatchObject({ outcome: "cancelled", roundId: "aaa111" });
    expect(useAgentReviewOutcomeStore.getState().get("experience", "thread-b", "rules")).toBeUndefined();
  });

  it("replaces applied hunk ids when a later content round reuses hunk numbers", () => {
    const store = useAgentReviewOutcomeStore.getState();
    store.record("experience", "thread-c", { target: "rules", roundId: "abc111", outcome: "applied", hunks: { accepted: 1, rejected: 0, pending: 0 } }, [0]);
    store.record("experience", "thread-c", { target: "rules", roundId: "def222", outcome: "awaiting", hunks: { accepted: 0, rejected: 0, pending: 1 } }, []);
    expect(useAgentReviewOutcomeStore.getState().outcomesByThread["thread-c"]!.rules!.appliedHunkIds).toEqual([]);
  });
});
