/**
 * Block-memoized markdown for the agent streaming bubble (LAG-4, step 5 of
 * AGENT_SHELL_RENDER_LAG_REPORT).
 *
 * Supervisor-sanctioned shape (2026-10-29): ONE memoized prefix instance +
 * a re-parsing tail, chosen over per-block instances because N sibling
 * `.md-content` wrappers cannot reproduce the single-container spacing — the
 * global margin reset (`*{margin:0}` in styles.css) leaves inter-block
 * paragraphs to `.md-content p+p` alone, and every wrapper's first element
 * loses its top margin to `.md-content > *:first-child`. The completed
 * prefix renders byte-identically to today's single-`Markdown` render (it
 * IS that render, of the same bytes); only the single live seam needs the
 * paragraph gap restored (`.md-stream-tail-seam` in styles.css).
 *
 * The splitter is a PURE function over the accumulated live text: it finds
 * the LAST SAFE boundary — the start of the latest sealed blank-line run
 * that is not inside a continuing construct — and returns everything before
 * it as the completed PREFIX plus the open TAIL. While only the tail grows
 * the prefix string is BYTE-STABLE (the perf contract: the memoized prefix
 * instance bails, so the completed blocks never re-parse mid-stream — the
 * quadratic whole-text re-parse over a long reply is gone); the prefix
 * changes only when a block completes.
 *
 * Safety rules (a boundary never changes the parse — each side renders
 * through the same Markdown pipeline over its exact byte slice):
 * - fenced code: blank lines inside an open fence are fence content, never
 *   boundaries; a closed fence block completes like any block;
 * - lists: a blank line followed by another list marker or an indented
 *   (>=4 spaces) line CONTINUES the list (loose/nested runs stay whole);
 *   the list completes only when a following non-blank line is neither —
 *   cutting a list run would flip loose-vs-tight `<li>` rendering;
 * - indented code and raw HTML blocks (rehype-raw couples adjacent raw
 *   nodes) absorb their blank-line continuations the same conservative way;
 * - everything else (paragraphs, headings, quotes, hr, table-ish lines,
 *   closed fences) ends at a blank line — nothing continues them across one.
 *
 * The SETTLED message never renders through here: the list passes the
 * streaming flag only for the OPEN feed text entry and the no-feed fallback
 * bubble; once the turn settles the persisted row renders the normal
 * single-`Markdown` path, byte-identical to before this unit (AP-29).
 */
import { Fragment } from "react";
import { Markdown, VARIANT_DEFAULT_CLASS } from "../../../lib/markdown.js";

/** The resolved agent Markdown variants (AP-2) — `AgentMessageBlock` derives
 *  the pair from the host markup; the split path takes it pre-resolved so
 *  the variant mapping stays ONE derivation. */
export type AgentStreamingVariant = "agent-rp" | "agent-plain";

/** What the splitter tracks per block — only the constructs whose
 *  blank-line/continuation semantics differ. */
type BlockConstruct =
  | "paragraph"
  | "fence"
  | "list"
  | "indented"
  | "html"
  | "heading"
  | "hr"
  | "quote"
  | "table";

/** The pure split of the accumulated live text (see the module header). */
export interface LiveMarkdownSplit {
  /** Completed blocks plus their separators — byte-stable while only the
   *  tail grows; changes only when a block completes. */
  prefix: string;
  /** The open block(s) — everything from the last safe boundary on. */
  tail: string;
  /** The boundary sits between two paragraph blocks — the tail wrapper
   *  needs the `.md-content p+p` paragraph gap restored (styles.css). */
  seamAfterParagraph: boolean;
}

// ── Line classification (CommonMark core shapes; conservative by design —
// a wrong classification can only MISS a seam compensation or keep more
// blocks in the tail, never split an unsafe boundary) ─────────────────────

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const HR_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const LIST_MARKER_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const QUOTE_RE = /^ {0,3}>/;
const HTML_OPEN_RE = /^ {0,3}<[A-Za-z/!?]/;

/** Leading indent width in spaces (a tab counts as a full stop). */
function indentWidth(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === " ") i++;
  return i < line.length && line[i] === "\t" ? i + 4 : i;
}

function isBlankLine(line: string): boolean {
  return line.trim() === "";
}

function classifyLine(line: string): BlockConstruct {
  const fence = FENCE_OPEN_RE.exec(line);
  // A backtick fence's info string may not contain a backtick (CommonMark).
  if (fence !== null && !(fence[1]![0] === "`" && fence[2]!.includes("`"))) return "fence";
  if (HEADING_RE.test(line)) return "heading";
  if (HR_RE.test(line)) return "hr";
  if (LIST_MARKER_RE.test(line)) return "list";
  if (QUOTE_RE.test(line)) return "quote";
  if (HTML_OPEN_RE.test(line)) return "html";
  // Table-ish lines (any pipe) classify conservatively: no paragraph-gap
  // compensation fires for them, and blank lines still bound them.
  if (line.includes("|")) return "table";
  if (indentWidth(line) >= 4) return "indented";
  return "paragraph";
}

/** A closing fence: same marker char, a run at least as long, nothing else. */
function isCloseFence(line: string, marker: string, length: number): boolean {
  const run = /^ {0,3}(`+|~+)/.exec(line);
  if (run === null) return false;
  if (run[1]![0] !== marker) return false;
  if (run[1]!.length < length) return false;
  return line.slice(run[0]!.length).trim() === "";
}

/** Does `line` continue `construct` across the blank line(s) before it? */
function continuesAcrossBlank(construct: BlockConstruct, line: string): boolean {
  if (construct === "list") return LIST_MARKER_RE.test(line) || indentWidth(line) >= 4;
  if (construct === "indented") return indentWidth(line) >= 4;
  if (construct === "html") return HTML_OPEN_RE.test(line) || indentWidth(line) >= 4;
  return false;
}

/** Is `construct` provably complete when the text ends right after its
 *  terminating blank run? Lists, indented code and raw HTML may still grow. */
function completesAtEnd(construct: BlockConstruct): boolean {
  return construct !== "list" && construct !== "indented" && construct !== "html";
}

/** Does the tail open with a paragraph block? Conservative: only a plain
 *  unindented line (classification already routes pipes, fences, markers,
 *  headings, quotes, hr, html and indents elsewhere). */
function tailStartsLikeParagraph(tail: string): boolean {
  for (const line of tail.split("\n")) {
    if (isBlankLine(line)) continue;
    return classifyLine(line) === "paragraph";
  }
  return false;
}

/**
 * Split the accumulated live text into the completed prefix and the open
 * tail at the LAST SAFE boundary. Pure and monotone under append-only
 * growth: previously sealed boundaries never move, so the prefix string is
 * byte-stable while only the tail grows (the LAG-4 perf contract).
 */
export function splitLiveMarkdown(text: string): LiveMarkdownSplit {
  const lines = text.split("\n");
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  let construct: BlockConstruct | null = null;
  let fence: { marker: string; length: number } | null = null;
  /** The latest blank-line run: becomes the boundary when the next non-blank
   *  line does not continue the construct (or, for list/indented/html, is
   *  dropped — those may still grow). `construct` is the block BEFORE the
   *  run started (null = the document opens with blanks). */
  let pending: { offset: number; construct: BlockConstruct | null } | null = null;
  let boundary: { offset: number; construct: BlockConstruct | null } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence !== null) {
      // Fence content (blank or not) is never boundary material.
      if (isCloseFence(line, fence.marker, fence.length)) fence = null;
      continue;
    }
    if (isBlankLine(line)) {
      // Only a SEALED blank line seeds a boundary — the text's last line is
      // still open (it may yet grow into a non-blank line, unsealing it).
      if (i < lines.length - 1 && pending === null) {
        pending = { offset: offsets[i]!, construct };
      }
      continue;
    }
    const kind = classifyLine(line);
    if (pending !== null) {
      if (construct !== null && continuesAcrossBlank(construct, line)) {
        // The blank run belongs to the continuing construct — no boundary.
        pending = null;
      } else {
        boundary = pending;
        pending = null;
        construct = kind;
      }
    } else if (
      construct === null ||
      (kind !== "paragraph" && kind !== "table" && kind !== "indented")
    ) {
      // Document start, or an interrupting block start (fence/heading/hr/
      // list/quote/html — all can interrupt a paragraph, CommonMark)
      // switches the tracked construct. Plain, table-ish and indented lines
      // are lazy continuations of the open unit (an indented line after a
      // paragraph is still its text — indented code cannot interrupt).
      construct = kind;
    }
    if (kind === "fence") {
      const open = FENCE_OPEN_RE.exec(line)!;
      fence = { marker: open[1]![0]!, length: open[1]!.length };
    }
  }
  // A pending blank run at end-of-text completes the block before it unless
  // the construct may still continue across blanks (see the header rules).
  if (pending !== null && construct !== null && completesAtEnd(construct)) {
    boundary = pending;
  }

  const splitIndex = boundary?.offset ?? 0;
  const prefix = text.slice(0, splitIndex);
  const tail = text.slice(splitIndex);
  return {
    prefix,
    tail,
    seamAfterParagraph:
      boundary !== null &&
      boundary.construct === "paragraph" &&
      tailStartsLikeParagraph(tail),
  };
}

export interface AgentStreamingMarkdownProps {
  /** The accumulated live text — grows per flush (append-only within a turn). */
  text: string;
  /** The resolved agent variant (AP-2) — see `AgentStreamingVariant`. */
  variant: AgentStreamingVariant;
}

/**
 * The streaming bubble's body renderer (LAG-4): the byte-stable completed
 * PREFIX through one memoized `Markdown` (its React.memo bails on every
 * tail-growing flush — completed blocks never re-parse) plus the open TAIL
 * through a second instance (the only per-flush re-parse). `Markdown` wraps
 * every instance in its own `div.md-content…`, so the seam between the two
 * restores the paragraph gap with the ONE `.md-stream-tail-seam` class
 * (styles.css) when the boundary sits between two paragraph blocks; every
 * other pair keeps its natural margins through margin collapsing.
 */
export function AgentStreamingMarkdown({ text, variant }: AgentStreamingMarkdownProps) {
  const split = splitLiveMarkdown(text);
  return (
    <Fragment>
      <Markdown text={split.prefix} variant={variant} />
      <Markdown
        text={split.tail}
        variant={variant}
        className={split.seamAfterParagraph
          ? `${VARIANT_DEFAULT_CLASS[variant]} md-stream-tail-seam`
          : undefined}
      />
    </Fragment>
  );
}
