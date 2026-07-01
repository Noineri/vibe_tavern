/**
 * CA-12 — Hunk-level (granular) selection diff for the co-author reviewing overlay.
 *
 * Replaces the wholesale `TextDiffPreview` inside the CA-11 reviewing overlay:
 * instead of one read-only diff dump, each change HUNK (a maximal run of
 * consecutive add/remove lines) is its own selectable block with a toggle.
 * The user accepts some hunks and rejects others; {@link onToggleHunk} reports
 * the selection, and the parent rebuilds the Apply request from the merged body
 * (`coauthor-hunk-merge.ts` + `buildPartialApplyRequest`).
 *
 * Visual model:
 *  - Context (`same`) lines render dimmed between hunks (unchanged scaffolding).
 *  - A SELECTED hunk renders its add/remove lines in full diff color (the change
 *    WILL be applied).
 *  - A REJECTED hunk renders the same lines muted (opacity-50) so the user sees
 *    exactly what they are skipping; its toggle is unchecked.
 *  - A header strip offers Select-all / None and shows the live count
 *    ("Applying X of Y").
 *
 * `TextDiffPreview` itself is untouched — it stays the read-only diff for the
 * AI-assistant modal. This component is co-author-reviewing-specific.
 */
import { useMemo } from "react";
import { cn } from "../../lib/cn.js";
import type { TextDiffSummary } from "../shared/TextDiffPreview.js";
import { groupHunks, type DiffHunk } from "../../lib/coauthor-hunk-merge.js";

interface HunkSelectionDiffLabels {
  /** Header title for the diff area. */
  title: string;
  /** "too large to diff" fallback. */
  tooLarge: string;
  /** "no changes" fallback. */
  noChanges: string;
  /** Toggle to select every hunk. */
  selectAll: string;
  /** Toggle to deselect every hunk. */
  selectNone: string;
  /** Live count, `{selected}` and `{total}` interpolated. */
  applyingCount: string;
  /** Per-hunk label, `{n}` = 1-based hunk number. */
  hunkN: string;
  /** Marker shown on a rejected hunk (won't apply). */
  skipped: string;
}

interface HunkSelectionDiffProps {
  diff: TextDiffSummary;
  hunks: DiffHunk[];
  selectedIds: Set<number>;
  onToggleHunk: (id: number) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  labels: HunkSelectionDiffLabels;
}

/** One render segment: either a context run or a hunk. */
type Segment =
  | { type: "context"; lines: { text: string }[] }
  | { type: "hunk"; hunk: DiffHunk; lines: TextDiffSummary["lines"] };

/** Segment the flat diff lines into context runs + hunk blocks. */
function segmentDiff(diff: TextDiffSummary, hunks: DiffHunk[]): Segment[] {
  const segments: Segment[] = [];
  // Mark which line indices belong to a hunk.
  const hunkLine = new Set<number>();
  for (const h of hunks) for (let k = h.start; k < h.end; k++) hunkLine.add(k);
  let i = 0;
  const lines = diff.lines;
  while (i < lines.length) {
    if (hunkLine.has(i)) {
      const h = hunks.find((h) => i >= h.start && i < h.end)!;
      segments.push({ type: "hunk", hunk: h, lines: lines.slice(h.start, h.end) });
      i = h.end;
    } else {
      const start = i;
      while (i < lines.length && !hunkLine.has(i)) i++;
      segments.push({ type: "context", lines: lines.slice(start, i).map((l) => ({ text: l.text })) });
    }
  }
  return segments;
}

export function HunkSelectionDiff({
  diff,
  hunks,
  selectedIds,
  onToggleHunk,
  onSelectAll,
  onSelectNone,
  labels,
}: HunkSelectionDiffProps) {
  const segments = useMemo(() => segmentDiff(diff, hunks), [diff, hunks]);
  const total = hunks.length;
  const selectedCount = hunks.filter((h) => selectedIds.has(h.id)).length;
  const allSelected = total > 0 && selectedCount === total;
  const noneSelected = selectedCount === 0;

  if (diff.tooLarge) {
    return (
      <div className="rounded-md border border-border bg-bg" style={{ padding: 12 }}>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{labels.title}</div>
        <div className="font-ui text-[12px] leading-relaxed text-t3">{labels.tooLarge}</div>
      </div>
    );
  }
  if (total === 0) {
    return (
      <div className="rounded-md border border-border bg-bg" style={{ padding: 12 }}>
        <div className="font-ui text-[12px] text-t3">{labels.noChanges}</div>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-bg" style={{ padding: 12 }}>
      {/* Header: title + count + select-all/none. */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{labels.title}</div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] tabular-nums text-t2">
            {labels.applyingCount.replace("{selected}", String(selectedCount)).replace("{total}", String(total))}
          </span>
          <button
            type="button"
            className="rounded border border-border/60 px-1.5 py-0.5 font-ui text-[10px] text-t3 transition-colors hover:bg-s2 disabled:opacity-40"
            disabled={allSelected}
            onClick={onSelectAll}
          >
            {labels.selectAll}
          </button>
          <button
            type="button"
            className="rounded border border-border/60 px-1.5 py-0.5 font-ui text-[10px] text-t3 transition-colors hover:bg-s2 disabled:opacity-40"
            disabled={noneSelected}
            onClick={onSelectNone}
          >
            {labels.selectNone}
          </button>
        </div>
      </div>

      <pre className="max-h-[280px] overflow-y-auto overflow-x-hidden rounded border border-border/60 bg-surface p-2 font-mono text-[11px] leading-[1.45]">
        {segments.map((seg, si) => {
          if (seg.type === "context") {
            return (
              <div key={`ctx-${si}`}>
                {seg.lines.map((l, li) => (
                  <div key={li} className="whitespace-pre-wrap break-words px-2 text-t3/45 [overflow-wrap:anywhere]">
                    <span className="select-none pr-2 text-t3/40"> </span>
                    {l.text || " "}
                  </div>
                ))}
              </div>
            );
          }
          // Hunk block.
          const hunk = seg.hunk;
          const selected = selectedIds.has(hunk.id);
          return (
            <div
              key={`hunk-${hunk.id}`}
              className={cn(
                "my-1 overflow-hidden rounded border",
                selected ? "border-border bg-surface" : "border-border/40 bg-surface/40 opacity-55",
              )}
            >
              {/* Hunk header: toggle + label + counts + (skipped marker). */}
              <div className="flex items-center justify-between gap-2 border-b border-border/50 bg-bg/60 px-2 py-1">
                <label className="flex min-w-0 cursor-pointer select-none items-center gap-1.5">
                  <input
                    type="checkbox"
                    className="accent-[var(--accent)]"
                    checked={selected}
                    onChange={() => onToggleHunk(hunk.id)}
                  />
                  <span className="font-ui text-[10px] font-medium text-t2">
                    {labels.hunkN.replace("{n}", String(hunk.id + 1))}
                  </span>
                </label>
                <div className="flex items-center gap-2">
                  {!selected && (
                    <span className="font-ui text-[10px] italic text-t4">{labels.skipped}</span>
                  )}
                  <span className="font-mono text-[10px] tabular-nums">
                    <span className="text-success-text">+{hunk.added}</span>{" "}
                    <span className="text-danger-text">-{hunk.removed}</span>
                  </span>
                </div>
              </div>
              {/* Hunk lines (colored when selected; muted via the wrapper opacity when not). */}
              {seg.lines.map((line, li) => (
                <div
                  key={li}
                  className={cn(
                    "min-w-0 whitespace-pre-wrap break-words px-2 [overflow-wrap:anywhere]",
                    line.kind === "add" && "bg-success-dim text-success-text",
                    line.kind === "remove" && "bg-danger-dim text-danger-text",
                  )}
                >
                  <span className="select-none pr-2 text-t3/50">
                    {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
                  </span>
                  {line.text || " "}
                </div>
              ))}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
