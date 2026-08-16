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

  it("moves the digest to sit immediately before its anchor message", () => {
    const ordered = orderMessagesWithDigests([
      msg("u1", "user"),
      msg("a1", "assistant"),
      msg("u2", "user"),
      msg("a2", "assistant"),
      msg("d1", "digest", "u2"),
    ]);
    expect(ordered.map((e) => e.message.id)).toEqual(["u1", "a1", "d1", "u2", "a2"]);
    // covers the two flow messages before the anchor (u1, a1).
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
    expect(ordered.map((e) => e.message.id)).toEqual([
      "u1", "a1", "d1", "u2", "a2", "u3", "d2", "a3", "u4",
    ]);
    expect(ordered.find((e) => e.message.id === "d1")!.coveredCount).toBe(2);
    // d2 covers the flow messages between u2's position and a3's position: u2, a2, u3.
    expect(ordered.find((e) => e.message.id === "d2")!.coveredCount).toBe(3);
  });

  it("dangling anchor degrades to end-of-list placement (never wrong-side)", () => {
    const ordered = orderMessagesWithDigests([
      msg("u1", "user"),
      msg("a1", "assistant"),
      msg("d1", "digest", "deleted-anchor"),
    ]);
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
    expect(ordered.map((e) => e.message.id)).toEqual(["u1", "d1", "a1"]);
    expect(ordered.find((e) => e.message.id === "d1")!.coveredCount).toBe(1);
  });
});
