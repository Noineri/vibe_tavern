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
  it("returns empty string for no reports (absence no-op)", () => {
    expect(formatExperienceMessageBlock([])).toBe("");
  });

  it("formats a single report with header, authority preamble, summary, and events", () => {
    const block = formatExperienceMessageBlock([makeReport()]);
    expect(block).toBe(
      "[Experience report — Tic-Tac-Toe — authoritative]\n" +
        "The following experience events are resolved facts. Narrate them as part of the scene; do not alter them, repeat them as new moves, or replace them.\n" +
        "Round 3 — X to move\n" +
        "- move: X played center\n" +
        "- score: {\"x\":1,\"o\":0}\n" +
        "[End experience report]",
    );
  });

  it("always carries the authority preamble (narrate, do not alter/repeat/replace)", () => {
    const block = formatExperienceMessageBlock([makeReport()]);
    expect(block).toContain("authoritative");
    expect(block).toContain("resolved facts");
    expect(block).toContain("do not alter them, repeat them as new moves, or replace them");
  });

  it("omits the summary line when the report has no summary", () => {
    const block = formatExperienceMessageBlock([makeReport({ summary: undefined })]);
    expect(block).not.toContain("Round 3");
    // Header still present directly above the preamble.
    expect(block).toContain("[Experience report — Tic-Tac-Toe — authoritative]\nThe following experience events");
  });

  it("renders a string detail verbatim", () => {
    const block = formatExperienceMessageBlock([makeReport({ events: [{ type: "note", detail: "A bare string." }], summary: undefined })]);
    expect(block).toContain("- note: A bare string.");
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
    expect(block).toContain("[Experience report — Game A — authoritative]");
    expect(block).toContain("[Experience report — Game B — authoritative]");
    expect(block).toContain("[End experience report]\n\n[Experience report — Game B");
    expect(block.indexOf("Game A")).toBeLessThan(block.indexOf("Game B"));
  });

  it("never references hidden state — the snapshot carries no hidden field", () => {
    // Structural guarantee: ExperienceReportSnapshot has title/summary/events/kind/sessionRevision
    // and NOTHING else. The formatter reads only those. (The hidden checkpoint lives on the
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
