import { describe, expect, test } from "bun:test";
import {
  agentReviewSnapshotSchema,
  reviewOutcomeSchema,
  reviewTargetRecordSchema,
} from "../src/index.js";

describe("agentReviewSnapshotSchema", () => {
  test("preserves every target and outcome through the public barrel", () => {
    const payload = {
      targets: [
        { target: "rules" as const, roundId: "a1", outcome: "awaiting" as const },
        { target: "visual" as const, roundId: "b2", outcome: "applied" as const },
        { target: "card" as const, roundId: "c3", outcome: "applied-partial" as const },
        { target: "lore" as const, roundId: "d4", outcome: "rejected" as const },
        { target: "tracker_template" as const, roundId: "e5", outcome: "cancelled" as const },
        { target: "rules" as const, roundId: "f6", outcome: "superseded" as const, supersededByRound: "a7" },
      ],
    };

    expect(agentReviewSnapshotSchema.parse(payload)).toEqual(payload);
  });

  test("keeps an explicit empty snapshot distinct from an absent request field", () => {
    expect(agentReviewSnapshotSchema.parse({ targets: [] })).toEqual({ targets: [] });
  });

  test("accepts the inclusive hex round id boundary", () => {
    expect(reviewTargetRecordSchema.parse({
      target: "rules",
      roundId: "aBcD0123eF456789",
      outcome: "applied",
      supersededByRound: "0123456789abcdef",
    })).toMatchObject({ roundId: "aBcD0123eF456789", supersededByRound: "0123456789abcdef" });
  });

  test("rejects invalid round identities", () => {
    for (const roundId of ["", "0123456789abcdef0", "not-hex", "abc-def"]) {
      expect(reviewTargetRecordSchema.safeParse({
        target: "rules",
        roundId,
        outcome: "awaiting",
      }).success).toBe(false);
    }
    expect(reviewTargetRecordSchema.safeParse({
      target: "rules",
      roundId: "abcdef",
      outcome: "superseded",
      supersededByRound: "not-hex",
    }).success).toBe(false);
  });

  test("requires nonnegative integer counters while preserving optional metadata", () => {
    const payload = {
      target: "lore" as const,
      roundId: "abcdef",
      outcome: "awaiting" as const,
      hunks: { accepted: 0, rejected: 1, pending: 2 },
      items: { offered: 3, selected: 1, applied: 0 },
      selected: true,
    };
    expect(reviewTargetRecordSchema.parse(payload)).toEqual(payload);

    for (const counts of [
      { accepted: -1, rejected: 0, pending: 0 },
      { accepted: 0.5, rejected: 0, pending: 0 },
    ]) {
      expect(reviewTargetRecordSchema.safeParse({ ...payload, hunks: counts }).success).toBe(false);
    }
    expect(reviewTargetRecordSchema.safeParse({
      ...payload,
      items: { offered: 1, selected: -1, applied: 0 },
    }).success).toBe(false);
  });

  test("exports every approved outcome", () => {
    for (const outcome of ["awaiting", "applied", "applied-partial", "rejected", "cancelled", "superseded"] as const) {
      expect(reviewOutcomeSchema.parse(outcome)).toBe(outcome);
    }
  });
});
