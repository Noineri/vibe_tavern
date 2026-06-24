import { describe, expect, test } from "bun:test";
import { EditorState, Transaction, type Text } from "@codemirror/state";
import { lockedHeadings, changeTouchesHeading, LOCKED_HEADING_RE } from "./vibe-md-locked-headings.js";

/**
 * VTF-11 — locked headings UX guardrail.
 *
 * The changeFilter blocks user input/delete transactions that touch an H1
 * heading line, while letting programmatic writes (sync, no userEvent) pass
 * through. These tests cover the range math edge cases (newlines before/after
 * a heading, last-line append) and the user-event gating, without needing a DOM
 * — `EditorState.update` runs the changeFilter facet directly.
 *
 * Positions are derived from the CM6 line model via helpers below, never
 * hand-counted: `line.to` is the position of the line's newline terminator
 * (NOT one past it), and the last content char is at `line.to - 1`.
 */

const DOC = "# PERSONALITY\nBody line one.\nBody line two.\n# SCENARIO\nScenario body.\n";

/** The CM6 document, for line-position lookups. */
const docText = (): Text => EditorState.create({ doc: DOC }).doc;

/** Offset of the line `n`'s trailing newline (1-indexed line number). */
const nlAt = (n: number): number => docText().line(n).to;

/** Offset of the first char of line `n` (1-indexed). */
const lineStart = (n: number): number => docText().line(n).from;

function makeState(): EditorState {
  return EditorState.create({ doc: DOC, extensions: lockedHeadings() });
}

/** Dispatch a user-input transaction inserting at `pos`; return resulting doc. */
function typeInput(state: EditorState, pos: number, text: string): string {
  return state
    .update({ changes: { from: pos, to: pos, insert: text }, annotations: Transaction.userEvent.of("input.type") })
    .state.doc.toString();
}

/** Dispatch a user-delete transaction over [from,to]; return resulting doc. */
function deleteInput(state: EditorState, from: number, to: number): string {
  return state
    .update({ changes: { from, to }, annotations: Transaction.userEvent.of("delete.backward") })
    .state.doc.toString();
}

/** Dispatch a programmatic replace (no userEvent annotation); return doc. */
function programmaticReplace(state: EditorState, from: number, to: number, text: string): string {
  return state.update({ changes: { from, to, insert: text } }).state.doc.toString();
}

describe("LOCKED_HEADING_RE", () => {
  test("matches canonical H1 body headings", () => {
    expect(LOCKED_HEADING_RE.test("# PERSONALITY")).toBe(true);
    expect(LOCKED_HEADING_RE.test("# SCENARIO")).toBe(true);
    expect(LOCKED_HEADING_RE.test("# EXAMPLES")).toBe(true);
  });
  test("rejects non-headings", () => {
    expect(LOCKED_HEADING_RE.test("## PERSONALITY")).toBe(false); // H2
    expect(LOCKED_HEADING_RE.test("#PERSONALITY")).toBe(false); // no space after #
    expect(LOCKED_HEADING_RE.test("# ")).toBe(false); // empty heading
    expect(LOCKED_HEADING_RE.test("Body line.")).toBe(false);
  });
});

describe("changeTouchesHeading (pure range math)", () => {
  const lines = docText;

  test("insert inside a heading line overlaps", () => {
    expect(changeTouchesHeading(lines(), 5, 5)).toBe(true); // mid "# PERSONALITY"
  });
  test("insert in the body does not overlap", () => {
    expect(changeTouchesHeading(lines(), lineStart(2) + 2, lineStart(2) + 2)).toBe(false);
  });
  test("deleting the heading's leading '#' touches it", () => {
    expect(changeTouchesHeading(lines(), 0, 1)).toBe(true);
  });
  test("deleting the newline AFTER a heading is blocked (would merge heading into next line)", () => {
    // The newline after "# PERSONALITY" sits AT line.to of line 1.
    expect(changeTouchesHeading(lines(), nlAt(1), nlAt(1) + 1)).toBe(true);
  });
  test("deleting the newline BEFORE a heading is blocked (would merge prev line into heading)", () => {
    // "# SCENARIO" is line 4; the newline before it is line 3's terminator.
    expect(changeTouchesHeading(lines(), nlAt(3), nlAt(3) + 1)).toBe(true);
  });
  test("deleting entirely within the body does not overlap", () => {
    const s = lineStart(2);
    expect(changeTouchesHeading(lines(), s + 1, s + 3)).toBe(false);
  });
});

describe("changeFilter via EditorState.update", () => {
  test("blocks typing inside a heading line", () => {
    expect(typeInput(makeState(), 5, "X")).toBe(DOC); // unchanged
  });
  test("blocks deleting the heading's '#'", () => {
    expect(deleteInput(makeState(), 0, 1)).toBe(DOC); // unchanged
  });
  test("blocks deleting the whole heading line + its newline", () => {
    expect(deleteInput(makeState(), 0, nlAt(1) + 1)).toBe(DOC); // unchanged
  });
  test("blocks deleting the newline after a heading", () => {
    expect(deleteInput(makeState(), nlAt(1), nlAt(1) + 1)).toBe(DOC); // unchanged
  });
  test("blocks line-split (inserting \\n) inside a heading", () => {
    expect(typeInput(makeState(), 2, "\n")).toBe(DOC); // unchanged
  });
  test("allows typing in the body", () => {
    const pos = lineStart(2); // first char of "Body line one."
    expect(typeInput(makeState(), pos, "X")).toBe(DOC.slice(0, pos) + "X" + DOC.slice(pos));
  });
  test("allows deleting in the body", () => {
    const pos = lineStart(2); // 'B'
    expect(deleteInput(makeState(), pos, pos + 1)).toBe(DOC.slice(0, pos) + DOC.slice(pos + 1));
  });
  test("lets programmatic writes through (no userEvent) on a body range", () => {
    // Sync-style writes carry no input/delete annotation → never gated.
    const s = lineStart(2);
    const end = nlAt(2) + 1; // "Body line one.\n"
    const replacement = "Rewritten body.\n";
    const expected = DOC.slice(0, s) + replacement + DOC.slice(end);
    expect(programmaticReplace(makeState(), s, end, replacement)).toBe(expected);
  });
  test("lets programmatic write replace a heading wholesale (sync owns Threat 2)", () => {
    const rewritten = "# PERSONALITY\n# SCENARIO\nScenario body.\n";
    expect(programmaticReplace(makeState(), 0, DOC.length, rewritten)).toBe(rewritten);
  });
  test("undo/redo events are not blocked (no heading mutation can enter history anyway)", () => {
    const result = makeState().update({ annotations: Transaction.userEvent.of("undo") }).state;
    expect(result.doc.toString()).toBe(DOC);
  });
});
