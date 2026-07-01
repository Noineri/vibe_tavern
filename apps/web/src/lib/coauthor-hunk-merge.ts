/**
 * CA-12 — Hunk-level (granular) Apply support: pure diff algebra.
 *
 * The CA-11 reviewing overlay applies the turn's aggregated proposal WHOLESALE
 * (Variant A). CA-12 lets the user accept some proposed edits and reject others
 * at the hunk level (Variant B): "accept hunk 1+3, reject hunk 2 → only 1+3
 * land on canonical."
 *
 * A HUNK is a maximal run of consecutive non-context (add/remove) diff lines,
 * bounded by `same` (context) anchor lines. The user toggles each hunk on/off.
 * {@link mergeSelectedBody} reconstructs a hybrid document from the selection:
 * for a SELECTED hunk it takes the proposed (`add`) lines and drops the removed
 * ones; for a REJECTED hunk it keeps the original (`remove`) lines and drops the
 * proposed ones. Context (`same`) lines are always kept. The result is a body
 * that reflects exactly the selected subset of changes.
 *
 * Invariants (pinned by tests):
 *  - ALL hunks selected  → merged body === the PROPOSED body (the diff's
 *    `same` + `add` lines, in order).
 *  - NO hunks selected   → merged body === the CANONICAL body (the diff's
 *    `same` + `remove` lines, in order).
 *  - subset selected     → a coherent hybrid.
 *
 * Pure: no React, no I/O, no codecs. Operates only on the {@link TextDiffSummary}
 * shape produced by `buildLineDiff` (reused from the shared diff component).
 */
import type { TextDiffSummary } from "../components/shared/TextDiffPreview.js";

/** A maximal run of consecutive add/remove diff lines (a single change block). */
export interface DiffHunk {
  /** 0-based hunk id, in document order (stable for a given diff). */
  id: number;
  /** Inclusive start index into `diff.lines`. */
  start: number;
  /** Exclusive end index into `diff.lines`. */
  end: number;
  /** Number of `add` (proposed) lines in this hunk. */
  added: number;
  /** Number of `remove` (original) lines in this hunk. */
  removed: number;
}

/**
 * Group a line-diff's lines into hunks. A hunk is a maximal run of consecutive
 * non-`same` lines; `same` lines separate hunks (and are context anchors).
 * Returns hunks in document order with sequential ids. An all-`same` diff (no
 * changes) yields no hunks. A `tooLarge` diff (no lines) yields no hunks.
 */
export function groupHunks(diff: TextDiffSummary): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let i = 0;
  let id = 0;
  const lines = diff.lines;
  while (i < lines.length) {
    if (lines[i]!.kind === "same") {
      i++;
      continue;
    }
    const start = i;
    let added = 0;
    let removed = 0;
    while (i < lines.length && lines[i]!.kind !== "same") {
      if (lines[i]!.kind === "add") added++;
      else removed++;
      i++;
    }
    hunks.push({ id: id++, start, end: i, added, removed });
  }
  return hunks;
}

/**
 * Reconstruct a merged body from the diff + the set of SELECTED hunk ids.
 *
 * Walks the diff lines in order:
 *  - `same` (context)     → always kept.
 *  - `add` (proposed line) → kept iff its hunk is selected (else the proposal
 *    is dropped for this line).
 *  - `remove` (orig line)  → kept iff its hunk is NOT selected (a rejected hunk
 *    preserves the original; a selected hunk drops it in favor of the `add`s).
 *
 * `selectedHunkIds` defaults to "all selected" when omitted (CA-11 wholesale
 * behavior). Lines not belonging to any hunk (context) are unaffected by the
 * selection. The returned string has no trailing newline normalization — it is
 * a plain line join; callers that need canonical-body shape feed it through the
 * body codec (`pinBodyFields` / `applyBodyToDraft`).
 */
export function mergeSelectedBody(
  diff: TextDiffSummary,
  selectedHunkIds?: ReadonlySet<number>,
): string {
  const hunks = groupHunks(diff);
  // Map each diff line index → the hunk id it belongs to (or null for context).
  const lineHunk: (number | null)[] = diff.lines.map(() => null);
  for (const h of hunks) {
    for (let k = h.start; k < h.end; k++) lineHunk[k] = h.id;
  }
  // Default: all hunks selected (CA-11 wholesale parity).
  const selected = selectedHunkIds ?? new Set(hunks.map((h) => h.id));

  const out: string[] = [];
  for (let k = 0; k < diff.lines.length; k++) {
    const line = diff.lines[k]!;
    const hunkId = lineHunk[k];
    const isSelected = hunkId !== null && selected.has(hunkId);
    if (line.kind === "same") {
      out.push(line.text);
    } else if (line.kind === "add") {
      if (isSelected) out.push(line.text); // take the proposed line
      // rejected add → dropped (the change is not applied)
    } else {
      // remove (original line)
      if (!isSelected) out.push(line.text); // keep the original
      // accepted removal → dropped (replaced by the add)
    }
  }
  return out.join("\n");
}

/**
 * Convenience: the set of ALL hunk ids (the CA-11 wholesale selection). Useful
 * as the initial state for the selection before the user toggles anything.
 */
export function allHunkIds(hunks: readonly DiffHunk[]): Set<number> {
  return new Set(hunks.map((h) => h.id));
}
