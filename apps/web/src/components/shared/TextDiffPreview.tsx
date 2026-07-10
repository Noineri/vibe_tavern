import { diffArrays } from "diff";
import { cn } from "../../lib/cn.js";

export type TextDiffLineKind = "same" | "add" | "remove";

export interface TextDiffLine {
  kind: TextDiffLineKind;
  text: string;
}

export interface TextDiffSummary {
  lines: TextDiffLine[];
  added: number;
  removed: number;
  tooLarge: boolean;
}

const MAX_INLINE_DIFF_LINES = 1600;

export function buildLineDiff(oldText: string, newText: string): TextDiffSummary {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  if (oldLines.length + newLines.length > MAX_INLINE_DIFF_LINES) {
    return {
      lines: [],
      added: Math.max(0, newLines.length - oldLines.length),
      removed: Math.max(0, oldLines.length - newLines.length),
      tooLarge: true,
    };
  }

  const changes = diffArrays(oldLines, newLines);
  const lines: TextDiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    const kind: TextDiffLineKind = change.added ? "add" : change.removed ? "remove" : "same";
    for (const text of change.value) {
      lines.push({ kind, text });
      if (kind === "add") added++;
      else if (kind === "remove") removed++;
    }
  }

  return { lines, added, removed, tooLarge: false };
}

export function TextDiffPreview({
  summary,
  labels,
}: {
  summary: TextDiffSummary;
  labels: { title: string; tooLarge: string; noChanges: string };
}) {
  if (summary.tooLarge) {
    return (
      <div className="rounded-md border border-border bg-bg" style={{ padding: 12, marginBottom: 12 }}>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{labels.title}</div>
        <div className="font-ui text-[12px] leading-relaxed text-t3">{labels.tooLarge}</div>
      </div>
    );
  }

  if (summary.added === 0 && summary.removed === 0) {
    return (
      <div className="rounded-md border border-border bg-bg" style={{ padding: 12, marginBottom: 12 }}>
        <div className="font-ui text-[12px] text-t3">{labels.noChanges}</div>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-bg" style={{ padding: 12, marginBottom: 12 }}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{labels.title}</div>
        <div className="font-mono text-[11px] tabular-nums">
          <span className="text-success-text">+{summary.added}</span>{" "}
          <span className="text-danger-text">-{summary.removed}</span>
        </div>
      </div>
      <pre className="max-h-[280px] overflow-y-auto overflow-x-hidden rounded border border-border/60 bg-surface p-2 font-mono text-[11px] leading-[1.45]">
        {summary.lines.map((line, idx) => (
          <div
            key={idx}
            className={cn(
              "min-w-0 whitespace-pre-wrap break-words px-2 [overflow-wrap:anywhere]",
              line.kind === "add" && "bg-success-dim text-success-text",
              line.kind === "remove" && "bg-danger-dim text-danger-text",
              line.kind === "same" && "text-t3/65",
            )}
          >
            <span className="select-none pr-2 text-t3/50">{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}</span>{line.text || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}
