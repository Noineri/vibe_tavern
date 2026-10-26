/**
 * copilot-context pure helpers (CM-7 + CM-9) — meter fractions, urgency flag,
 * and digest-card ordering. Pure: no React/DOM, no store access.
 */
import { describe, expect, it } from "bun:test";
import type { ExperienceCopilotContextMetrics, ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { meterSegments, isMeterUrgent, orderMessagesWithDigests } from "./copilot-context.js";

function metrics(over: Partial<ExperienceCopilotContextMetrics> = {}): ExperienceCopilotContextMetrics {
  return {
    systemTokens: 1000,
    digestTokens: 0,
    historyTokens: 2000,
    attachedTokens: 0,
    totalTokens: 3000,
    budgetTokens: 10000,
    reserveTokens: 1000,
    source: "estimate",
    measuredAt: "2026-08-15T00:00:00.000Z",
    ...over,
  };
}

function msg(id: string, role: string, toolCallId: string | null = null): ExperienceCopilotMessageWire {
  return {
    id,
    threadId: "thread-1",
    role,
    content: `content-${id}`,
    toolCallsJson: null,
    toolCallId,
    reasoning: null,
    reasoningDurationMs: null,
    createdAt: "",
  };
}

describe("meterSegments", () => {
  it("returns segment fractions of the budget", () => {
    const s = meterSegments(metrics({ systemTokens: 2500, digestTokens: 1000, historyTokens: 500, reserveTokens: 2000, budgetTokens: 10000 }));
    expect(s).not.toBeNull();
    expect(s!.system).toBe(0.25);
    expect(s!.digest).toBe(0.1);
    expect(s!.history).toBe(0.05);
    expect(s!.reserve).toBe(0.2);
    expect(s!.usedTokens).toBe(4000);
  });

  it("clamps over-budget fractions to 1", () => {
    const s = meterSegments(metrics({ systemTokens: 15000, budgetTokens: 10000 }));
    expect(s!.system).toBe(1);
  });

  it("returns null when unmetered (budget 0 or no metrics)", () => {
    expect(meterSegments(null)).toBeNull();
    expect(meterSegments(metrics({ budgetTokens: 0 }))).toBeNull();
  });
});

describe("isMeterUrgent", () => {
  it("is urgent at >= 80% of budget (mirrors the backend threshold)", () => {
    expect(isMeterUrgent(metrics({ totalTokens: 8000, budgetTokens: 10000 }))).toBe(true);
    expect(isMeterUrgent(metrics({ totalTokens: 7999, budgetTokens: 10000 }))).toBe(false);
  });

  it("is never urgent when unmetered", () => {
    expect(isMeterUrgent(null)).toBe(false);
    expect(isMeterUrgent(metrics({ budgetTokens: 0, totalTokens: 999999 }))).toBe(false);
  });
});

describe("orderMessagesWithDigests", () => {
  it("passes a digest-free list through unchanged", () => {
    const ordered = orderMessagesWithDigests([
      msg("u1", "user"),
      msg("a1", "assistant"),
    ]);
    expect(ordered.map((e) => e.message.id)).toEqual(["u1", "a1"]);
    expect(ordered.every((e) => e.coveredCount === null)).toBe(true);
  });

  it("keeps the digest at its chronological slot — after the last pre-compaction row (AP-33)", () => {
    const ordered = orderMessagesWithDigests([
      msg("u1", "user"),
      msg("a1", "assistant"),
      msg("u2", "user"),
      msg("a2", "assistant"),
      msg("d1", "digest", "u2"),
    ]);
    // AP-33: NO move to the anchor — the digest stays where the backend
    // appended it (the compaction moment), after every row that existed then.
    expect(ordered.map((e) => e.message.id)).toEqual(["u1", "a1", "u2", "a2", "d1"]);
    // covers the two flow messages before the anchor (u1, a1).
    expect(ordered.find((e) => e.message.id === "d1")!.coveredCount).toBe(2);
  });

  it("a digest listed mid-flow stays at its slot (no move toward the anchor either)", () => {
    const ordered = orderMessagesWithDigests([
      msg("u1", "user"),
      msg("a1", "assistant"),
      msg("d1", "digest", "u2"),
      msg("u2", "user"),
      msg("a2", "assistant"),
    ]);
    expect(ordered.map((e) => e.message.id)).toEqual(["u1", "a1", "d1", "u2", "a2"]);
    // The count still comes from the anchors alone (flow before u2 = u1, a1).
    expect(ordered.find((e) => e.message.id === "d1")!.coveredCount).toBe(2);
  });

  it("derives successive-digest covered counts between consecutive anchors", () => {
    const ordered = orderMessagesWithDigests([
      msg("u1", "user"),
      msg("a1", "assistant"),
      msg("u2", "user"),
      msg("a2", "assistant"),
      msg("d1", "digest", "u2"),
      msg("u3", "user"),
      msg("a3", "assistant"),
      msg("d2", "digest", "a3"),
      msg("u4", "user"),
    ]);
    // AP-33: both digests keep their chronological slots (appended order).
    expect(ordered.map((e) => e.message.id)).toEqual([
      "u1", "a1", "u2", "a2", "d1", "u3", "a3", "d2", "u4",
    ]);
    expect(ordered.find((e) => e.message.id === "d1")!.coveredCount).toBe(2);
    // d2 covers the flow messages between u2's position and a3's position: u2, a2, u3.
    expect(ordered.find((e) => e.message.id === "d2")!.coveredCount).toBe(3);
  });

  it("a dangling anchor keeps the digest at its slot and counts the whole prefix", () => {
    const ordered = orderMessagesWithDigests([
      msg("u1", "user"),
      msg("a1", "assistant"),
      msg("d1", "digest", "deleted-anchor"),
    ]);
    // The digest stays where it sits (chronologically last here); the
    // dangling anchor degrades to the flow's end for the COUNT (both rows).
    expect(ordered.map((e) => e.message.id)).toEqual(["u1", "a1", "d1"]);
    expect(ordered.find((e) => e.message.id === "d1")!.coveredCount).toBe(2);
  });

  it("excludes tool-role messages from both flow and covered count", () => {
    const ordered = orderMessagesWithDigests([
      msg("u1", "user"),
      msg("t1", "tool"),
      msg("a1", "assistant"),
      msg("d1", "digest", "a1"),
    ]);
    // AP-33: the digest stays at its slot (after a1); tool rows drop out.
    expect(ordered.map((e) => e.message.id)).toEqual(["u1", "a1", "d1"]);
    expect(ordered.find((e) => e.message.id === "d1")!.coveredCount).toBe(1);
  });
});
