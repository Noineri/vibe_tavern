/**
 * Intra-line (word-level) diff for GitHub-style highlighting inside the
 * Co-author diff view (`HunkSelectionDiff`). The line-level diff in
 * `buildLineDiff` tags each line add/remove/same; this module goes one level
 * deeper: within a hunk it PAIRS remove lines with add lines positionally and
 * runs a token-level LCS to mark which substrings are SHARED (common) vs
 * CHANGED. The renderer colors the line with the dim background and stamps the
 * changed substrings with a stronger ("strong") highlight — exactly GitHub's
 * "word-diff" look.
 *
 * Pure: no React, no I/O. The LCS shape mirrors `buildLineDiff` but operates
 * over tokens (letter / digit / whitespace / "other" runs) instead of lines.
 * Unicode-aware (`u` flag) so Cyrillic prose — the app ships Russian — is
 * tokenized per-word, not per-byte.
 */
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
 * Skip intra-line diffing when old+new tokens exceed this. Guards against a
 * pathological paste triggering a large O(n·m) LCS allocation. 4000 combined
 * (~2000 tokens/side ≈ a 1500-word single-line field) keeps the DP well under
 * ~20ms and covers realistic greeting/paragraph sizes with huge headroom — a
 * typical greeting paragraph is ~200–300 tokens/side.
 */
const MAX_INTRA_TOKENS = 4000;

/**
 * Tokenize into: whitespace runs, letter runs, digit runs, and "other"
 * (punctuation/symbol) runs. `[\w]` is ASCII-only without `u`, so we use the
 * Unicode properties `\p{L}` / `\p{N}` to keep Cyrillic/accented text wordwise.
 */
function tokenize(text: string): string[] {
  return text.match(/\s+|\p{L}+|\p{N}+|[^\s\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Compute word-level segments for a paired (old, new) line. Returns null when
 * intra-line diffing is not applicable — either line empty, or the pair is too
 * large — in which case the caller renders the whole line as a plain change
 * (no highlight), matching GitHub's treatment of fully-new/removed lines.
 */
export function diffIntraLine(oldText: string, newText: string): IntraLineDiff | null {
  if (!oldText || !newText) return null;
  const oldTokens = tokenize(oldText);
  const newTokens = tokenize(newText);
  if (oldTokens.length === 0 || newTokens.length === 0) return null;
  if (oldTokens.length + newTokens.length > MAX_INTRA_TOKENS) return null;

  const n = oldTokens.length;
  const m = newTokens.length;
  // LCS DP, token-indexed (same shape as buildLineDiff).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldTokens[i] === newTokens[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Walk the DP, classifying each token as common (shared) or changed.
  const oldCommon = new Array<boolean>(n).fill(false);
  const newCommon = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldTokens[i] === newTokens[j]) {
      oldCommon[i] = true;
      newCommon[j] = true;
      i++;
      j++;
    } else if (dp[i + 1]![j] >= dp[i]![j + 1]) {
      i++; // old token removed on the new side
    } else {
      j++; // new token added on the new side
    }
  }

  return {
    oldSegments: collapse(oldTokens, oldCommon),
    newSegments: collapse(newTokens, newCommon),
  };
}

/** Collapse consecutive tokens sharing the same common-flag into one segment. */
function collapse(tokens: string[], common: boolean[]): LineSegment[] {
  const segs: LineSegment[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const flag = common[k]!;
    const last = segs[segs.length - 1];
    if (last && last.common === flag) {
      last.text += tokens[k]!;
    } else {
      segs.push({ text: tokens[k]!, common: flag });
    }
  }
  return segs;
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
