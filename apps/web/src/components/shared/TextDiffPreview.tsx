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

  const dp = Array.from({ length: oldLines.length + 1 }, () => new Array<number>(newLines.length + 1).fill(0));
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const lines: TextDiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ kind: "same", text: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ kind: "remove", text: oldLines[i++] });
      removed++;
    } else {
      lines.push({ kind: "add", text: newLines[j++] });
      added++;
    }
  }
  while (i < oldLines.length) {
    lines.push({ kind: "remove", text: oldLines[i++] });
    removed++;
  }
  while (j < newLines.length) {
    lines.push({ kind: "add", text: newLines[j++] });
    added++;
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
