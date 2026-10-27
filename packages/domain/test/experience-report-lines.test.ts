import { describe, expect, it } from "bun:test";
import type { ExperiencePublicReport, ExperienceReportEvent, ExperienceReportSnapshot } from "../src/entities.js";
import { renderExperienceEventLine } from "../src/experience-report-lines.js";

const participants = Object.freeze([
  Object.freeze({ id: "seat_1", label: "Player" }),
  Object.freeze({ id: "seat_2", label: "Companion" }),
]);

describe("renderExperienceEventLine", () => {
  it("prefixes string details with the matching frozen participant label", () => {
    expect(renderExperienceEventLine({ type: "card_played", participantId: "seat_2", detail: "played a yellow 6" }, participants))
      .toBe("Companion: played a yellow 6");
  });

  it("falls back to the participant id when the roster is missing or has no match", () => {
    const event = { type: "move", participantId: "seat_3", detail: "passed" };
    expect(renderExperienceEventLine(event)).toBe("seat_3: passed");
    expect(renderExperienceEventLine(event, [])).toBe("seat_3: passed");
    expect(renderExperienceEventLine(event, participants)).toBe("seat_3: passed");
  });

  it("renders actorless string details without a type label or inferred actor", () => {
    expect(renderExperienceEventLine({ type: "start", detail: "Two players started a new match." }, participants))
      .toBe("Two players started a new match.");
    expect(renderExperienceEventLine({ type: "note", detail: "" })).toBe("");
  });

  it("preserves detail and participant label whitespace verbatim", () => {
    expect(renderExperienceEventLine({ type: "note", participantId: "p", detail: "  passed\nthen waited  " }, [{ id: "p", label: " A " }]))
      .toBe(" A :   passed\nthen waited  ");
    expect(renderExperienceEventLine({ type: "note", participantId: "p", detail: "" }, [{ id: "p", label: "" }]))
      .toBe(": ");
  });

  it.each([
    [{ type: "card_played", detail: { participantId: "seat_1", card: "yellow_6" } }, 'card_played: {"participantId":"seat_1","card":"yellow_6"}'],
    [{ type: "count", detail: 0 }, "count: 0"],
    [{ type: "ready", detail: false }, "ready: false"],
    [{ type: "empty", detail: null }, "empty: null"],
    [{ type: "cards", detail: ["a", 2] }, 'cards: ["a",2]'],
    [{ type: "finished" }, "finished"],
    [{ type: "finished", detail: undefined }, "finished"],
  ] satisfies ReadonlyArray<readonly [ExperienceReportEvent, string]>)("keeps legacy raw event bytes: %j", (event, expected) => {
    expect(renderExperienceEventLine(event)).toBe(expected);
    expect(renderExperienceEventLine({ ...event, participantId: "seat_2" }, participants)).toBe(expected);
  });

  it("reads report/snapshot participant maps without mutating frozen inputs", () => {
    const event = Object.freeze({ type: "move", participantId: "seat_1", detail: "passed" });
    const report: ExperiencePublicReport = Object.freeze({ title: "Game", participants, events: Object.freeze([event]) });
    const snapshot: ExperienceReportSnapshot = { ...report, kind: "report", sessionRevision: 1 };
    expect(renderExperienceEventLine(report.events[0], report.participants)).toBe("Player: passed");
    expect(renderExperienceEventLine(snapshot.events[0], snapshot.participants)).toBe("Player: passed");
    expect(event).toEqual({ type: "move", participantId: "seat_1", detail: "passed" });
    expect(participants).toEqual([{ id: "seat_1", label: "Player" }, { id: "seat_2", label: "Companion" }]);
  });
});
