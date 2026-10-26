/**
 * Agent-only KaTeX math rendering (owner follow-up 2026-10-24, item 2).
 *
 * The `chat` and `plain` pipelines in `markdown.tsx` are byte-identical and never
 * load this module. Only the two agent variants (`agent-rp`, `agent-plain`) route
 * here — via `React.lazy`, so `remark-math` + `rehype-katex` + `katex` stay out of
 * the initial bundle and load on the first agent message containing a `$`.
 *
 * Three pieces:
 * 1. `escapeNonMathDollars` — the Pandoc dollar rule enforced on the source string
 *    BEFORE math parsing (`remark-math` tokenizes dollars during parsing, so no tree
 *    plugin could pre-empt it): an opening `$` must be followed by a non-space
 *    character, a closing `$` must be preceded by a non-space character and NOT
 *    followed by a digit. Dollars that cannot form a pair are backslash-escaped, so
 *    «It costs $5 and $10» and «$5,000 debt» stay literal text while `$v_y = -770$`
 *    still parses. Fenced/indented code, inline code spans and inline HTML tags are
 *    skipped (escapes do not round-trip there).
 * 2. `ensureKatexStylesheet` — injects the vendored same-origin KaTeX stylesheet
 *    (`public/katex/`, see `scripts/copy-katex-assets.ts`) once, on first math
 *    render. No CDN (local-first), and the CSS never enters the JS bundle (Bun
 *    inlines `url()` fonts as base64 into bundled CSS — ~1.4 MB — so a bundled CSS
 *    import is deliberately NOT used).
 * 3. `AgentMathMarkdown` (default export, the `React.lazy` target) — the agent
 *    pipeline plus math: `remark-math`, then `rehype-katex` with
 *    `errorColor: "inherit"` (an unparseable formula shows its source in the message
 *    color — never the KaTeX default red, never a thrown error), BEFORE
 *    `rehype-sanitize` with the agent-only schema extension below.
 *
 * Sanitization decision (named): agent-only schema extension. KaTeX emits MathML
 * (`math`, `semantics`, `annotation`, `mrow`, …) plus its `span`-based HTML twin —
 * both machine-generated from the parsed formula, not user HTML. The extension
 * allowlists exactly those tags/attributes (`agentSanitizeSchema`) and applies ONLY
 * to the two agent pipelines; the `chat`/`plain` schema is untouched.
 */
import React from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { PluggableList } from "unified";
import { APP_VERSION, isProd } from "../build-config.js";
import type { MarkdownComponentProps } from "./markdown.js";
import { rehypeQuotedText } from "./markdown.js";
import {
  preserveEscapedUnderscoreTags,
  rehypeRestoreEscapedUnderscoreTags,
  remarkUnderscoreCustomTags,
} from "./markdown-underscore-tags.js";

/** Same-origin vendored KaTeX stylesheet (cache-busted like the worker assets). */
export const KATEX_CSS_HREF = isProd
  ? `/katex/katex.min.css?v=${APP_VERSION}`
  : "/katex/katex.min.css";

let katexStylesheetInjected = false;

/** Inject the KaTeX stylesheet once; a missing file degrades to unstyled math text. */
export function ensureKatexStylesheet(): void {
  if (katexStylesheetInjected) return;
  katexStylesheetInjected = true;
  if (typeof document === "undefined") return;
  if (document.querySelector("link[data-katex-css]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = KATEX_CSS_HREF;
  link.dataset.katexCss = "true";
  document.head.appendChild(link);
}

/** Reset the stylesheet guard (tests only — the module is process-global). */
export function resetKatexStylesheetForTests(): void {
  katexStylesheetInjected = false;
  if (typeof document === "undefined") return;
  document.querySelector("link[data-katex-css]")?.remove();
}

// ─── Pandoc dollar rule (string level — remark-math tokenizes during parsing) ───

function isSpaceOrTab(ch: string | undefined): boolean {
  return ch === " " || ch === "\t";
}

function isLineBreak(ch: string | undefined): boolean {
  return ch === "\n" || ch === "\r";
}

function isBlank(ch: string | undefined): boolean {
  return ch === undefined || isSpaceOrTab(ch) || isLineBreak(ch);
}

/**
 * Consume `> ` blockquote markers; returns the content offset. Fence and indent
 * detection run on the remainder so quoted code blocks are skipped too.
 */
function contentStart(line: string): number {
  let i = 0;
  while (true) {
    let j = i;
    while (line[j] === " ") j += 1;
    if (line[j] !== ">") return i;
    i = j + 1;
    if (line[i] === " ") i += 1;
  }
}

function fenceRun(line: string, start: number): { fence: string; length: number } | null {
  let i = start;
  let spaces = 0;
  while (line[i] === " ") {
    spaces += 1;
    i += 1;
  }
  if (spaces > 3 || (line[i] !== "`" && line[i] !== "~")) return null;
  const fence = line[i]!;
  let j = i;
  while (line[j] === fence) j += 1;
  if (j - i < 3) return null;
  return { fence, length: j - i };
}

function isClosingFence(line: string, start: number, fence: string, length: number): boolean {
  const run = fenceRun(line, start);
  if (!run || run.fence !== fence || run.length < length) return false;
  // A closing fence carries no info string — only trailing whitespace.
  let k = start;
  while (line[k] === " ") k += 1;
  k += run.length;
  return line.slice(k).trim().length === 0;
}

/** Find the end (index past the closer) of the code span opened at `from`. */
function codeSpanEnd(source: string, from: number, run: number): number {
  let k = from;
  while (k < source.length) {
    if (source[k] === "`") {
      let j = k;
      while (source[j] === "`") j += 1;
      if (j - k === run) return j;
      k = j;
      continue;
    }
    k += 1;
  }
  return -1;
}

/**
 * Enforce the Pandoc dollar rule on a markdown source string.
 *
 * Returns the source with every `$` that cannot belong to a math pair escaped
 * (`\$`, which renders as a literal dollar), so `remark-math` only ever sees
 * qualifying pairs. `$$…$$` display pairs and single `$…$` pairs share one rule:
 * an opener must be followed by a non-space character (display openers also allow
 * a newline), a closer must be preceded by a non-space character and not followed
 * by a digit. An opener pairs with the next qualifying closer; anything unpaired
 * stays literal.
 *
 * Skipped verbatim: fenced code blocks, 4-space-indented lines (indented code or
 * deeply nested content — either way escaping there is wrong or unnecessary),
 * inline code spans, inline HTML tags, and already-escaped characters.
 */
export function escapeNonMathDollars(source: string): string {
  const out: string[] = [];
  let pendingInline: number | null = null;
  let pendingDisplay: number | null = null;
  let fence: { fence: string; length: number } | null = null;
  let i = 0;

  const clearPending = (): void => {
    if (pendingInline !== null) {
      out[pendingInline] = "\\$";
      pendingInline = null;
    }
    if (pendingDisplay !== null) {
      out[pendingDisplay] = "\\$\\$";
      pendingDisplay = null;
    }
  };

  while (i < source.length) {
    if (source[i] === "\n") {
      out.push("\n");
      i += 1;
      continue;
    }
    if (i === 0 || source[i - 1] === "\n") {
      const lineEnd = source.indexOf("\n", i);
      const line = lineEnd === -1 ? source.slice(i) : source.slice(i, lineEnd);
      const start = contentStart(line);
      if (fence !== null) {
        if (isClosingFence(line, start, fence.fence, fence.length)) fence = null;
        clearPending();
        out.push(line);
        i += line.length;
        continue;
      }
      const open = fenceRun(line, start);
      if (open !== null) {
        fence = open;
        clearPending();
        out.push(line);
        i += line.length;
        continue;
      }
      let s = start;
      while (line[s] === " ") s += 1;
      const indented = line[s] === "\t" || s - start >= 4;
      if (indented) {
        clearPending();
        out.push(line);
        i += line.length;
        continue;
      }
    }

    const ch = source[i]!;

    // Already-escaped characters stay as they are.
    if (ch === "\\" && i + 1 < source.length) {
      out.push(ch, source[i + 1]!);
      i += 2;
      continue;
    }

    // Inline code spans: copy verbatim (escapes do not round-trip there).
    if (ch === "`") {
      let j = i;
      while (source[j] === "`") j += 1;
      const end = codeSpanEnd(source, j, j - i);
      if (end === -1) {
        out.push(source.slice(i, j));
        i = j;
      } else {
        out.push(source.slice(i, end));
        i = end;
      }
      continue;
    }

    // Inline HTML tags: copy verbatim (an escape could corrupt attributes).
    if (ch === "<") {
      const next = source[i + 1];
      if (next !== undefined && /[A-Za-z/!?]/.test(next)) {
        const close = source.indexOf(">", i + 1);
        if (close !== -1) {
          out.push(source.slice(i, close + 1));
          i = close + 1;
          continue;
        }
      }
      out.push(ch);
      i += 1;
      continue;
    }

    // Display `$$` delimiters (a run of exactly two). Unlike the single-dollar
    // closer, both sides tolerate a newline — the canonical display form puts
    // the delimiters on their own lines (`$$\n…\n$$`). Only space/tab disqualify.
    if (ch === "$" && source[i + 1] === "$" && source[i + 2] !== "$" && source[i - 1] !== "$") {
      if (pendingDisplay !== null && !isSpaceOrTab(source[i - 1])) {
        pendingDisplay = null;
        if (pendingInline !== null) {
          out[pendingInline] = "\\$";
          pendingInline = null;
        }
        out.push("$$");
      } else if (pendingDisplay === null && source[i + 2] !== undefined && !isSpaceOrTab(source[i + 2])) {
        pendingDisplay = out.length;
        out.push("$$");
      } else {
        clearPending();
        out.push("\\$\\$");
      }
      i += 2;
      continue;
    }

    if (ch === "$") {
      const prev = source[i - 1];
      const next = source[i + 1];
      const canClose =
        pendingInline !== null &&
        !isBlank(prev) &&
        (next === undefined || next < "0" || next > "9");
      if (canClose) {
        pendingInline = null;
        out.push("$");
      } else if (!isBlank(next)) {
        // A new opener abandons a still-pending one (it stays escaped).
        if (pendingInline !== null) out[pendingInline] = "\\$";
        pendingInline = out.length;
        out.push("$");
      } else {
        out.push("\\$");
      }
      i += 1;
      continue;
    }

    out.push(ch);
    i += 1;
  }

  clearPending();
  return out.join("");
}

// ─── Agent-only sanitize schema extension ───

/**
 * MathML tags emitted by KaTeX (`math` wrapper, `semantics` + `annotation` for
 * the source, layout elements). KaTeX's HTML twin is plain `span`s, which the
 * base schema already allows (className/style are allowlisted globally below).
 */
// KaTeX draws rules the fonts cannot (fraction lines, surds, cancel strokes) as
// inline SVG — observed tags/attributes only (collected from real KaTeX output
// over a 25-sample battery during development; the sanitized tree was diffed
// against the unsanitized one until the diff was empty).
const KATEX_SVG_TAGS = [
  "svg",
  "path",
  "line",
] as const;

const KATEX_MATHML_TAGS = [
  "math",
  "semantics",
  "annotation",
  "mrow",
  "mi",
  "mn",
  "mo",
  "mtext",
  "mspace",
  "mover",
  "munder",
  "msub",
  "msup",
  "msubsup",
  "mfrac",
  "msqrt",
  "mroot",
  "mtable",
  "mtr",
  "mtd",
  "menclose",
  "mphantom",
  "mpadded",
  "mstyle",
  "merror",
] as const;

type SchemaAttributes = Record<string, Array<string | [string, ...Array<string>]>>;

export const agentSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), ...KATEX_MATHML_TAGS, ...KATEX_SVG_TAGS],
  attributes: {
    ...defaultSchema.attributes,
    // `className`/`style` ride the base extension (markdown.tsx); `aria-hidden`
    // marks KaTeX's visual HTML twin so screen readers use the MathML instead.
    "*": [...((defaultSchema.attributes?.["*"] ?? []) as string[]), "className", "style", "ariaHidden"],
    math: ["xmlns", "display"],
    annotation: ["encoding"],
    mi: ["mathvariant"],
    mo: ["mathvariant", "stretchy", "lspace", "rspace", "fence", "separator"],
    mn: ["mathvariant"],
    mtext: ["mathvariant"],
    mfrac: ["linethickness"],
    mspace: ["width", "height", "depth"],
    mpadded: ["width", "height", "depth", "lspace", "voffset"],
    menclose: ["notation"],
    mstyle: ["displaystyle", "scriptlevel", "mathcolor"],
    mtable: ["columnalign", "columnspacing", "rowspacing"],
    svg: ["xmlns", "width", "height", "viewBox", "preserveAspectRatio"],
    path: ["d"],
    line: ["x1", "x2", "y1", "y2", "strokeWidth"],
  } as SchemaAttributes,
};

// ─── Agent math pipelines (module scope — same memo contract as markdown.tsx) ───

const AGENT_MATH_REMARK_RP: PluggableList = [remarkGfm, remarkUnderscoreCustomTags, remarkMath];
const AGENT_MATH_REMARK_PLAIN: PluggableList = [remarkGfm, remarkMath];

const AGENT_MATH_REHYPE_RP: PluggableList = [
  rehypeRaw,
  [rehypeKatex, { errorColor: "inherit" }],
  [rehypeSanitize, agentSanitizeSchema],
  rehypeRestoreEscapedUnderscoreTags,
  rehypeQuotedText,
];
const AGENT_MATH_REHYPE_PLAIN: PluggableList = [
  rehypeRaw,
  [rehypeKatex, { errorColor: "inherit" }],
  [rehypeSanitize, agentSanitizeSchema],
];

// ─── Lazy component ───

interface AgentMathMarkdownProps {
  text: string;
  variant: "agent-rp" | "agent-plain";
  components: Record<string, React.ComponentType<MarkdownComponentProps>>;
}

/**
 * The `React.lazy` target for agent math rendering. Applies the underscore-tag
 * compatibility pre-pass (agent-rp parity with `markdown.tsx`), then the Pandoc
 * dollar rule, and renders with the math pipeline. The KaTeX stylesheet is
 * injected on first render. Renders the same single-`div` contract as `Markdown`:
 * the caller owns the wrapper, this returns the `ReactMarkdown` element only.
 */
export default function AgentMathMarkdown({ text, variant, components }: AgentMathMarkdownProps): React.JSX.Element {
  React.useEffect(ensureKatexStylesheet, []);
  const isRp = variant === "agent-rp";
  const prepared = escapeNonMathDollars(isRp ? preserveEscapedUnderscoreTags(text) : text);
  return (
    <ReactMarkdown
      remarkPlugins={isRp ? AGENT_MATH_REMARK_RP : AGENT_MATH_REMARK_PLAIN}
      rehypePlugins={isRp ? AGENT_MATH_REHYPE_RP : AGENT_MATH_REHYPE_PLAIN}
      components={components}
    >
      {prepared}
    </ReactMarkdown>
  );
}
