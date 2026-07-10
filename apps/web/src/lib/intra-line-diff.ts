/**
 * Intra-line (word-level) diff for GitHub-style highlighting inside the
 * Co-author diff view (`HunkSelectionDiff`). The line-level diff in
 * `buildLineDiff` tags each line add/remove/same; this module goes one level
 * deeper: within a hunk it PAIRS remove lines with add lines positionally and
 * runs jsdiff's `diffArrays` over `Intl.Segmenter` word-tokens to mark which substrings are SHARED (common) vs
 * CHANGED. The renderer colors the line with the dim background and stamps the
 * changed substrings with a stronger ("strong") highlight — exactly GitHub's
 * "word-diff" look.
 *
 * Pure: no React, no I/O. Word tokenization is delegated to `Intl.Segmenter`
 * (Unicode-aware, handles Cyrillic/Latin/CJK per-platform), so Russian prose —
 * the app ships Russian — is segmented per-word, not per-byte.
 */
import { diffArrays } from "diff";
import type { TextDiffLine } from "../components/shared/TextDiffPreview.js";

/** A contiguous run of text within a line, flagged shared vs changed. */
export interface LineSegment {
  text: string;
  /** true = shared between the paired old/new line (no highlight). */
  common: boolean;
}

/** Result of diffing one (old, new) line pair: per-side segments. */
export interface IntraLineDiff {
  oldSegments: LineSegment[];
  newSegments: LineSegment[];
}

/**
 * Skip intra-line diffing when old+new word-segments exceed this. Guards
 * against a pathological paste. 4000 combined (~2000 segments/side) covers
 * realistic greeting/paragraph sizes with huge headroom — a typical greeting
 * paragraph is ~200–300 segments/side.
 */
const MAX_INTRA_TOKENS = 4000;

/**
 * Unicode-aware word segmenter for Cyrillic/Latin prose. `granularity: "word"`
 * handles all scripts (Russian, English, CJK) per-platform — no custom regex
 * needed. Locale "ru" word-bounds both Cyrillic and Latin correctly.
 */
const WORD_SEGMENTER = new Intl.Segmenter("ru", { granularity: "word" });

function tokenize(text: string): string[] {
  return Array.from(WORD_SEGMENTER.segment(text), (s) => s.segment);
}

/**
 * Compute word-level segments for a paired (old, new) line by tokenizing both
 * with `Intl.Segmenter` and diffing the token arrays via jsdiff's `diffArrays`
 * (Myers). Returns null when intra-line diffing is not applicable — either
 * line empty, or the pair is too large — in which case the caller renders the
 * whole line as a plain change (no highlight), matching GitHub's treatment of
 * fully-new/removed lines.
 */
export function diffIntraLine(oldText: string, newText: string): IntraLineDiff | null {
  if (!oldText || !newText) return null;
  const oldTokens = tokenize(oldText);
  const newTokens = tokenize(newText);
  if (oldTokens.length === 0 || newTokens.length === 0) return null;
  if (oldTokens.length + newTokens.length > MAX_INTRA_TOKENS) return null;

  const changes = diffArrays(oldTokens, newTokens);
  const oldSegments: LineSegment[] = [];
  const newSegments: LineSegment[] = [];
  for (const change of changes) {
    const text = change.value.join("");
    if (change.added) {
      newSegments.push({ text, common: false });
    } else if (change.removed) {
      oldSegments.push({ text, common: false });
    } else {
      oldSegments.push({ text, common: true });
      newSegments.push({ text, common: true });
    }
  }
  return { oldSegments, newSegments };
}

/** A hunk line annotated with its intra-line segments (null = whole-line change). */
export interface AnnotatedHunkLine {
  line: TextDiffLine;
  /**
   * null when the line is unpaired (pure insertion/removal) or too large to
   * diff inline — render it as a whole-line change with no intra-line highlight.
   */
  segments: LineSegment[] | null;
}

/**
 * Pair remove/add lines within a hunk POSITIONALLY (1st remove ↔ 1st add, …)
 * and compute intra-line segments for each pair. Unpaired lines (a pure
 * insertion with no removed counterpart, or vice-versa) get `segments: null`,
 * so the renderer shows them as a whole-line change — exactly GitHub's look
 * for fully new/removed lines.
 *
 * `hunkLines` are the hunk's lines in original document order (a mix of `add`
 * and `remove`; context `same` lines, if any, pass through with `null`).
 */
export function annotateHunkLines(hunkLines: readonly TextDiffLine[]): AnnotatedHunkLine[] {
  const removeIdx: number[] = [];
  const addIdx: number[] = [];
  hunkLines.forEach((l, k) => {
    if (l.kind === "remove") removeIdx.push(k);
    else if (l.kind === "add") addIdx.push(k);
  });
  const paired = Math.min(removeIdx.length, addIdx.length);

  const segmentsByLine = new Map<number, LineSegment[]>();
  for (let p = 0; p < paired; p++) {
    const ri = removeIdx[p]!;
    const ai = addIdx[p]!;
    const d = diffIntraLine(hunkLines[ri]!.text, hunkLines[ai]!.text);
    if (d) {
      segmentsByLine.set(ri, d.oldSegments);
      segmentsByLine.set(ai, d.newSegments);
    }
  }

  return hunkLines.map((line, k) => ({
    line,
    segments: line.kind === "same" ? null : (segmentsByLine.get(k) ?? null),
  }));
}
