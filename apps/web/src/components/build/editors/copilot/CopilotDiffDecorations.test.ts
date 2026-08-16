/**
 * CopilotDiffDecorations — pure spec computation for the editor inline diff
 * (CD-5). Pins the mapping from a line diff (document = the PROPOSED buffer)
 * to decoration specs: add-line green positions, one hunk-header per unaccepted
 * hunk (ghost removal texts + button anchor), accepted hunks producing nothing,
 * and the EOF-tail anchoring for hunks whose changes sit at the document end.
 */
import { describe, expect, it } from "bun:test";
import { buildLineDiff, type TextDiffSummary } from "../../../shared/TextDiffPreview.js";
import { computeDiffDecorationSpecs, type CopilotDiffSpec } from "./CopilotDiffDecorations.js";
import { groupHunks, allHunkIds } from "../../../../lib/coauthor-hunk-merge.js";

type HunkHeaderSpec = Extract<CopilotDiffSpec, { type: "hunk-header" }>;
type AddDeltaSpec = Extract<CopilotDiffSpec, { type: "add-delta" }>;

function spec(input: { base: string; proposed: string }): {
  diff: TextDiffSummary;
  specs: ReturnType<typeof computeDiffDecorationSpecs>;
} {
  const diff = buildLineDiff(input.base, input.proposed);
  return { diff, specs: computeDiffDecorationSpecs(diff) };
}

describe("computeDiffDecorationSpecs", () => {
  it("highlights added lines and anchors one header per hunk above its first line", () => {
    const { specs } = spec({
      base: "a\nb\nc",
      proposed: "a\nB1\nB2\nc",
    });
    // Document = proposed: lines a(0) B1(1) B2(2) c(3). Hunk covers doc lines 1-2.
    expect(specs).toEqual([
      { type: "hunk-header", line: 1, hunkId: 0, removedTexts: ["b"], removedSegments: [[{ text: "b", common: false }]] },
      { type: "add-line", line: 1 },
      { type: "add-delta", line: 1, from: 0, to: 2 },
      { type: "add-line", line: 2 },
    ]);
  });

  it("renders a pure-deletion hunk as a header with ghost lines and no add-lines", () => {
    const { specs } = spec({
      base: "a\nb\nc",
      proposed: "a\nc",
    });
    expect(specs).toEqual([{ type: "hunk-header", line: 1, hunkId: 0, removedTexts: ["b"], removedSegments: [null] }]);
  });

  it("separates two hunks into two headers with correct anchors", () => {
    const { specs } = spec({
      base: "a\nb\nc\nd",
      proposed: "A\nb\nC\nd",
    });
    // Doc: A(0) b(1) C(2) d(3). Hunk0 = A at 0 (removes a); hunk1 = C at 2 (removes c).
    expect(specs).toEqual([
      { type: "hunk-header", line: 0, hunkId: 0, removedTexts: ["a"], removedSegments: [[{ text: "a", common: false }]] },
      { type: "add-line", line: 0 },
      { type: "add-delta", line: 0, from: 0, to: 1 },
      { type: "hunk-header", line: 2, hunkId: 1, removedTexts: ["c"], removedSegments: [[{ text: "c", common: false }]] },
      { type: "add-line", line: 2 },
      { type: "add-delta", line: 2, from: 0, to: 1 },
    ]);
  });

  it("produces nothing for accepted hunks", () => {
    const { diff } = spec({ base: "a\nb\nc", proposed: "a\nB\nc" });
    const hunks = groupHunks(diff);
    const accepted = allHunkIds(hunks);
    expect(computeDiffDecorationSpecs(diff, hunks, accepted)).toEqual([]);
  });

  it("keeps only the unaccepted hunk when a sibling is accepted", () => {
    const { diff } = spec({ base: "a\nb\nc\nd", proposed: "A\nb\nC\nd" });
    const hunks = groupHunks(diff);
    expect(computeDiffDecorationSpecs(diff, hunks, new Set([0]))).toEqual([
      { type: "hunk-header", line: 2, hunkId: 1, removedTexts: ["c"], removedSegments: [[{ text: "c", common: false }]] },
      { type: "add-line", line: 2 },
      { type: "add-delta", line: 2, from: 0, to: 1 },
    ]);
  });

  it("anchors a tail hunk past EOF when the change sits at the document end", () => {
    const { specs } = spec({
      base: "a\nb",
      proposed: "a\nb\nTAIL",
    });
    // Doc: a(0) b(1) TAIL(2) — the hunk's adds ARE at EOF; header anchors above
    // the first add line (2), still a valid document line.
    expect(specs).toEqual([
      { type: "hunk-header", line: 2, hunkId: 0, removedTexts: [], removedSegments: [] },
      { type: "add-line", line: 2 },
    ]);
  });

  it("anchors a pure-deletion tail hunk past the last document line", () => {
    const { diff } = spec({ base: "a\nb\ntrailing", proposed: "a\nb" });
    // Doc has 2 lines; the removal of "trailing" belongs past EOF (line 2).
    expect(computeDiffDecorationSpecs(diff)).toEqual([
      { type: "hunk-header", line: 2, hunkId: 0, removedTexts: ["trailing"], removedSegments: [null] },
    ]);
  });

  it("emits nothing for a tooLarge diff or an identical buffer", () => {
    expect(computeDiffDecorationSpecs({ lines: [], added: 1, removed: 1, tooLarge: true })).toEqual([]);
    expect(computeDiffDecorationSpecs(buildLineDiff("same\nsame", "same\nsame"))).toEqual([]);
  });

  it("marks only the changed word inside a paired line (word-delta)", () => {
    const { specs } = spec({ base: "const a = 1;", proposed: "const a = 2;" });

    const header = specs.find((s) => s.type === "hunk-header") as HunkHeaderSpec | undefined;
    expect(header).toBeDefined();
    expect(header!.removedTexts).toEqual(["const a = 1;"]);
    // The removed line carries at least one !common segment (the changed word).
    const segs = header!.removedSegments[0];
    expect(segs).not.toBeNull();
    expect(segs!.some((s) => !s.common && s.text === "1")).toBe(true);

    // Exactly ONE add-delta marks the changed run — the new word "2".
    const deltas = specs.filter((s) => s.type === "add-delta") as AddDeltaSpec[];
    expect(deltas).toHaveLength(1);
    expect("const a = 2;".slice(deltas[0]!.from, deltas[0]!.to)).toBe("2");
  });

  it("emits no add-delta for a pure insertion (no remove counterpart)", () => {
    const { specs } = spec({ base: "a", proposed: "a\nNEW LINE" });
    expect(specs.filter((s) => s.type === "add-delta")).toEqual([]);
    const header = specs.find((s) => s.type === "hunk-header") as HunkHeaderSpec | undefined;
    expect(header?.removedTexts).toEqual([]);
    expect(header?.removedSegments).toEqual([]);
  });
});
