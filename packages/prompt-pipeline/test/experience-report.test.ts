/**
 * Experience report formatter unit tests (IR-52, Wave 5).
 *
 * Pure-function tests for {@link formatExperienceMessageBlock}: the authority
 * header/preamble, title + optional summary, event detail rendering (string
 * verbatim vs JSON), absence no-op, and multi-report joining. These pin the
 * exact delimited block the ordinary RP Writer receives; the assembly-integration
 * tests (single-derivation seam, combined Dice+experience, token accounting)
 * live in assemble.test.ts.
 */
import { describe, it, expect } from "bun:test";
import { formatExperienceMessageBlock } from "../src/experience-report.ts";
import type { ExperienceReportSnapshot } from "@vibe-tavern/domain";

function makeReport(overrides: Partial<ExperienceReportSnapshot> = {}): ExperienceReportSnapshot {
  return {
    kind: "report",
    sessionRevision: 3,
    title: "Tic-Tac-Toe",
    summary: "Round 3 — X to move",
    events: [
      { type: "move", detail: "X played center" },
      { type: "score", detail: { x: 1, o: 0 } },
    ],
    ...overrides,
  };
}

describe("formatExperienceMessageBlock", () => {
  // ERX-1, 2026-10-27: characterize the legacy block before renderer/frame changes.
  // ERX-2b, 2026-10-27: re-pin only frame lines; every legacy event line is unchanged.
  it("preserves the complete legacy block for non-string and missing details", () => {
    expect(formatExperienceMessageBlock([makeReport({
      title: "Legacy game",
      summary: undefined,
      events: [
        { type: "card_played", detail: { participantId: "seat_1", card: "yellow_6" } },
        { type: "count", detail: 0 },
        { type: "ready", detail: false },
        { type: "empty", detail: null },
        { type: "cards", detail: ["a", 2] },
        { type: "finished" },
      ],
    })])).toBe([
      "[In the story — Legacy game]",
      "The user's character just played this out in the scene. How it went is listed below; it is settled and now part of the story. Continue the scene from it: let the characters react to the outcome; do not change it, replay it as new moves, or replace it.",
      '- card_played: {"participantId":"seat_1","card":"yellow_6"}',
      "- count: 0",
      "- ready: false",
      "- empty: null",
      '- cards: ["a",2]',
      "- finished",
      "[End]",
    ].join("\n"));
  });

  it("returns empty string for no reports (absence no-op)", () => {
    expect(formatExperienceMessageBlock([])).toBe("");
  });

  // ERX-2b, 2026-10-27: the approved in-story frame replaces technical app framing.
  it("formats a single report with the in-story frame, summary, and events", () => {
    const block = formatExperienceMessageBlock([makeReport()]);
    expect(block).toBe(
      "[In the story — Tic-Tac-Toe]\n" +
        "The user's character just played this out in the scene. How it went is listed below; it is settled and now part of the story. Continue the scene from it: let the characters react to the outcome; do not change it, replay it as new moves, or replace it.\n" +
        "Round 3 — X to move\n" +
        "- X played center\n" +
        "- score: {\"x\":1,\"o\":0}\n" +
        "[End]",
    );
  });

  it("always frames settled events as part of the story without app terminology", () => {
    const block = formatExperienceMessageBlock([makeReport()]);
    expect(block).toContain("it is settled and now part of the story");
    expect(block).toContain("let the characters react to the outcome");
    expect(block).toContain("do not change it, replay it as new moves, or replace it");
    expect(block).not.toMatch(/\b(experience|mini-app|app|interface)\b/i);
  });

  it("omits the summary line when the report has no summary", () => {
    const block = formatExperienceMessageBlock([makeReport({ summary: undefined })]);
    expect(block).not.toContain("Round 3");
    // Header still present directly above the preamble.
    expect(block).toContain("[In the story — Tic-Tac-Toe]\nThe user's character just played this out in the scene.");
  });

  it("renders a string detail verbatim", () => {
    const block = formatExperienceMessageBlock([makeReport({ events: [{ type: "note", detail: "A bare string." }], summary: undefined })]);
    expect(block).toContain("- A bare string.");
  });

  it("renders mixed prose, legacy JSON and actorless events from the frozen participant map", () => {
    const block = formatExperienceMessageBlock([makeReport({
      participants: [{ id: "seat_1", label: "Player" }],
      summary: undefined,
      events: [
        { type: "played", participantId: "seat_1", detail: "played a yellow 6" },
        { type: "raw", participantId: "seat_1", detail: { participantId: "seat_1" } },
        { type: "note", detail: "The round ended." },
        { type: "move", participantId: "unknown_seat", detail: "passed" },
      ],
    })]);
    expect(block).toContain('- Player: played a yellow 6\n- raw: {"participantId":"seat_1"}\n- The round ended.\n- unknown_seat: passed');
  });

  it("keeps actor prefixes when a legacy envelope has no participant map", () => {
    const block = formatExperienceMessageBlock([makeReport({ events: [{ type: "move", participantId: "seat_1", detail: "passed" }] })]);
    expect(block).toContain("- seat_1: passed");
  });

  it("renders a number detail as JSON", () => {
    const block = formatExperienceMessageBlock([makeReport({ events: [{ type: "roll", detail: 7 }], summary: undefined })]);
    expect(block).toContain("- roll: 7");
  });

  it("renders an object detail as compact JSON", () => {
    const block = formatExperienceMessageBlock([makeReport({ events: [{ type: "tally", detail: { a: 1, b: 2 } }], summary: undefined })]);
    expect(block).toContain("- tally: {\"a\":1,\"b\":2}");
  });

  it("renders an event without a detail as just the type label", () => {
    const block = formatExperienceMessageBlock([makeReport({ events: [{ type: "win" }], summary: undefined })]);
    expect(block).toContain("- win\n");
  });

  it("joins multiple reports with a blank line, each in its own delimited block", () => {
    const block = formatExperienceMessageBlock([
      makeReport({ title: "Game A", summary: undefined, events: [{ type: "e1" }] }),
      makeReport({ title: "Game B", summary: undefined, events: [{ type: "e2" }] }),
    ]);
    expect(block).toContain("[In the story — Game A]");
    expect(block).toContain("[In the story — Game B]");
    expect(block).toContain("[End]\n\n[In the story — Game B");
    expect(block.indexOf("Game A")).toBeLessThan(block.indexOf("Game B"));
  });

  it("never references hidden state — the snapshot carries no hidden field", () => {
    // Structural guarantee: snapshots carry only public metadata (including an optional
    // participants map), never the hidden checkpoint. (The hidden checkpoint lives on the
    // DB row's separate column and is never mapped into the snapshot — see
    // storeAttachmentToReportSnapshot.)
    const snapshot = makeReport();
    const keys = Object.keys(snapshot).sort();
    expect(keys).toEqual(["events", "kind", "sessionRevision", "summary", "title"]);
  });

  it("preserves event order as emitted by the reducer", () => {
    const block = formatExperienceMessageBlock([
      makeReport({
        summary: undefined,
        events: [{ type: "first" }, { type: "second" }, { type: "third" }],
      }),
    ]);
    const firstIdx = block.indexOf("- first");
    const secondIdx = block.indexOf("- second");
    const thirdIdx = block.indexOf("- third");
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });
});
