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

// ── Word-mode (inline) additions ──

export type TextDiffWordKind = "same" | "add" | "remove";

/**
 * A contiguous token-run within an inline (word-mode) diff. Consecutive
 * same-flag tokens from the underlying jsdiff output are joined into a
 * single `TextDiffWord` so the renderer shows readable runs, not per-token
 * noise.
 */
export interface TextDiffWord {
  kind: TextDiffWordKind;
  text: string;
}

export interface TextDiffWordSummary {
  words: TextDiffWord[];
  /** Non-whitespace token count — whitespace deltas render but don't bump the badge. */
  added: number;
  removed: number;
  tooLarge: boolean;
}

/** Component granularity. `"line"` is the default and is byte/behavior-identical to pre-word-mode. */
export type TextDiffGranularity = "line" | "word";

const MAX_INLINE_DIFF_LINES = 1600;

/**
 * Word-mode token budget: combined (old + new) `Intl.Segmenter` tokens.
 * Matches the limit in `lib/intra-line-diff.ts` (`MAX_INTRA_TOKENS`) so the
 * two word views stay consistent. 4000 combined (~2000/side) covers realistic
 * single-paragraph RP reply sizes — a typical greeting paragraph is ~200–300
 * tokens/side — with huge headroom. Past this, jsdiff's Myers becomes visibly
 * slow and inline highlighting loses readability; we mark the summary
 * `tooLarge` so the caller can fall back to a line diff (O(N) in lines, not
 * tokens) or render the tooLarge notice.
 */
const MAX_WORD_DIFF_TOKENS = 4000;

/**
 * Unicode-aware word segmenter (Cyrillic + Latin + CJK). Same locale and
 * granularity as `lib/intra-line-diff.ts` so the component-level word view
 * matches the Co-author hunk view. The `diff` library's `diffWords` is
 * intentionally NOT used: its word boundaries are English-biased and would
 * segment Russian/CJK prose per-byte, not per-word — this app ships Russian.
 */
const WORD_SEGMENTER = new Intl.Segmenter("ru", { granularity: "word" });

function tokenizeWords(text: string): string[] {
  return Array.from(WORD_SEGMENTER.segment(text), (s) => s.segment);
}

function isWhitespaceToken(token: string): boolean {
  // `Intl.Segmenter` "word" granularity emits pure-whitespace tokens between
  // word/punct tokens; those don't count as added/removed WORDS.
  return token.length > 0 && /^\s+$/.test(token);
}

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

/**
 * Inline word-level diff for a single-paragraph RP reply. Tokenizes both
 * inputs with `Intl.Segmenter` (Unicode-aware) and diffs the token arrays
 * via jsdiff's `diffArrays` (Myers). Consecutive same-flag tokens collapse
 * into one `TextDiffWord` so the renderer shows contiguous runs. Counts
 * (`added`/`removed`) reflect NON-whitespace tokens — whitespace-only
 * deltas still render inline for visual flow but don't bump the badge,
 * matching the user-meaningful "N words changed" reading.
 *
 * Past `MAX_WORD_DIFF_TOKENS` combined tokens, returns `tooLarge: true`
 * with empty `words`; the caller should then render a line diff or the
 * tooLarge notice.
 */
export function buildWordDiff(oldText: string, newText: string): TextDiffWordSummary {
  const oldTokens = tokenizeWords(oldText);
  const newTokens = tokenizeWords(newText);
  if (oldTokens.length + newTokens.length > MAX_WORD_DIFF_TOKENS) {
    return {
      words: [],
      added: Math.max(0, newTokens.length - oldTokens.length),
      removed: Math.max(0, oldTokens.length - newTokens.length),
      tooLarge: true,
    };
  }

  const changes = diffArrays(oldTokens, newTokens);
  const words: TextDiffWord[] = [];
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    const kind: TextDiffWordKind = change.added ? "add" : change.removed ? "remove" : "same";
    words.push({ kind, text: change.value.join("") });
    if (kind === "add") {
      added += change.value.filter((t) => !isWhitespaceToken(t)).length;
    } else if (kind === "remove") {
      removed += change.value.filter((t) => !isWhitespaceToken(t)).length;
    }
  }

  return { words, added, removed, tooLarge: false };
}

type TextDiffPreviewProps = {
  labels: { title: string; tooLarge: string; noChanges: string };
} & (
  | { granularity?: "line"; summary: TextDiffSummary }
  | { granularity: "word"; summary: TextDiffWordSummary }
);

export function TextDiffPreview(props: TextDiffPreviewProps) {
  // Access the discriminant via the props object BEFORE destructuring —
  // destructuring first breaks TS's narrowing of the summary union.
  if (props.summary.tooLarge) {
    const { labels } = props;
    return (
      <div className="rounded-md border border-border bg-bg" style={{ padding: 12, marginBottom: 12 }}>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{labels.title}</div>
        <div className="font-ui text-[12px] leading-relaxed text-t3">{labels.tooLarge}</div>
      </div>
    );
  }

  if (props.granularity === "word") {
    const { summary, labels } = props;
    const hasChanges = summary.words.some((w) => w.kind === "add" || w.kind === "remove");
    if (!hasChanges) {
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
        <p className="max-h-[280px] overflow-y-auto overflow-x-hidden rounded border border-border/60 bg-surface p-2 font-mono text-[11px] leading-[1.45] [overflow-wrap:anywhere]">
          {summary.words.map((word, idx) => (
            <span
              key={idx}
              className={cn(
                word.kind === "add" && "bg-success-dim text-success-text",
                word.kind === "remove" && "bg-danger-dim text-danger-text",
                word.kind === "same" && "text-t3/65",
              )}
            >
              {word.text || ""}
            </span>
          ))}
        </p>
      </div>
    );
  }

  const { summary, labels } = props;
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
