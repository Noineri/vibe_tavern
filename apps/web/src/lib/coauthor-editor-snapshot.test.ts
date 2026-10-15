/**
 * RO-5 pure snapshot/ledger tests.
 * L1: repo-relative imports only; no process globals; synchronous deterministic
 * assertions; no platform assumptions; no mocks/shared-worker ordering; every
 * assertion reads the final invariant directly.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";

import {
  buildCoauthorAppliedReview,
  buildCoauthorAwaitingReview,
  buildCoauthorRejectedReview,
  clearCoauthorEditorSnapshotStateForTests,
  publishCoauthorPendingReview,
  readCoauthorEditorState,
  registerCoauthorEditor,
  resolveCoauthorReview,
  restoreCoauthorEditorSnapshotStateForTests,
  snapshotCoauthorEditorSnapshotStateForTests,
  type CoauthorReviewInput,
} from "./coauthor-editor-snapshot.js";

const input: CoauthorReviewInput = {
  card: {
    base: "base",
    proposed: "proposed",
    hunkIds: [0, 1],
    selectedHunkIds: new Set([1]),
    hasProposal: true,
  },
  lore: {
    identity: "lore proposal",
    offeredIds: ["book:a", "entry:a", "entry:b"],
    selectedIds: new Set(["book:a", "entry:a"]),
  },
  tracker: { identity: "tracker proposal", selected: false },
};

const originalSnapshotState = snapshotCoauthorEditorSnapshotStateForTests();

afterEach(() => {
  clearCoauthorEditorSnapshotStateForTests();
});

afterAll(() => {
  restoreCoauthorEditorSnapshotStateForTests(originalSnapshotState);
});

describe("coauthor editor snapshot", () => {
  it("keeps selection awaiting until the actual Apply result resolves all three targets", () => {
    const awaiting = buildCoauthorAwaitingReview(input).targets;
    expect(awaiting).toEqual([
      expect.objectContaining({ target: "card", outcome: "awaiting", hunks: { accepted: 0, rejected: 1, pending: 1 } }),
      expect.objectContaining({ target: "lore", outcome: "awaiting", items: { offered: 3, selected: 2, applied: 0 } }),
      expect.objectContaining({ target: "tracker_template", outcome: "awaiting", selected: false }),
    ]);

    const applied = buildCoauthorAppliedReview(input, { cardApplied: true, loreApplied: false, trackerApplied: false }).targets;
    expect(applied).toEqual([
      expect.objectContaining({ target: "card", outcome: "applied-partial", hunks: { accepted: 1, rejected: 1, pending: 0 } }),
      expect.objectContaining({ target: "lore", outcome: "rejected", items: { offered: 3, selected: 2, applied: 0 } }),
      expect.objectContaining({ target: "tracker_template", outcome: "rejected", selected: false }),
    ]);
  });

  it("treats a frontmatter-only card proposal as one wholesale applied change", () => {
    const frontmatterOnly: CoauthorReviewInput = {
      card: { base: "body", proposed: "body\u0000name: New", hunkIds: [], selectedHunkIds: new Set(), hasProposal: true },
    };
    expect(buildCoauthorAppliedReview(frontmatterOnly, { cardApplied: true, loreApplied: false, trackerApplied: false }).targets[0]).toEqual(
      expect.objectContaining({ target: "card", outcome: "applied", hunks: { accepted: 1, rejected: 0, pending: 0 } }),
    );
  });

  it("records full rejection without inventing application", () => {
    const rejected = buildCoauthorRejectedReview(input).targets;
    expect(rejected.every((target) => target.outcome === "rejected")).toBe(true);
    expect(rejected[0]?.hunks).toEqual({ accepted: 0, rejected: 2, pending: 0 });
    expect(rejected[1]?.items).toEqual({ offered: 3, selected: 2, applied: 0 });
  });

  it("reads current editor values and retains resolved outcomes after pending review clears", () => {
    let body = "first body";
    const unregister = registerCoauthorEditor("chat-a", "character-a", () => ({ name: "", body, greetings: ["", "alt"], cardClean: false }));
    publishCoauthorPendingReview("chat-a", "character-a", buildCoauthorAwaitingReview(input));
    body = "edited after registration";
    expect(readCoauthorEditorState("chat-a", "character-a")).toMatchObject({ card: { name: "", body: "edited after registration", greetings: ["", "alt"], cardClean: false } });

    resolveCoauthorReview("chat-a", "character-a", buildCoauthorAppliedReview(input, { cardApplied: true, loreApplied: true, trackerApplied: false }));
    const state = readCoauthorEditorState("chat-a", "character-a");
    expect(state?.review.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "card", outcome: "applied-partial" }),
      expect.objectContaining({ target: "lore", outcome: "applied-partial" }),
      expect.objectContaining({ target: "tracker_template", outcome: "rejected" }),
    ]));
    unregister();
    expect(readCoauthorEditorState("chat-a", "character-a")).toBeUndefined();
  });

  it("isolates chat and character registrations", () => {
    registerCoauthorEditor("chat-a", "character-a", () => ({ name: "A", body: "A", greetings: [], cardClean: true }));
    registerCoauthorEditor("chat-b", "character-b", () => ({ name: "B", body: "B", greetings: [], cardClean: true }));
    expect(readCoauthorEditorState("chat-a", "character-a")?.card.name).toBe("A");
    expect(readCoauthorEditorState("chat-b", "character-b")?.card.name).toBe("B");
    expect(readCoauthorEditorState("chat-c", "character-c")).toBeUndefined();
  });
});
