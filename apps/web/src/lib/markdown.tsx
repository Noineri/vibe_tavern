import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownProps {
  text: string;
  className?: string;
}

const SCENE_META_BLOCK_RE = /\[[^\]\n]*?:[^\]\n]*?\]/g;

// ─── Rehype plugin: wrap "quoted text" in <span class="quoted-text"> ───
//
// The naive per-text-node approach fails when markdown inline markup
// (emphasis, bold, etc.) splits a quoted passage across AST nodes:
//
//   "Your shorts," he said. "You're *grieving fast fashion.*"
//
// After remark parsing the second quote becomes:
//   text:"You're "  →  em:[text:"grieving fast fashion."]  →  text:""""
//
// The closing " is in a different text node than the opening ", so a
// simple regex per node misses it.
//
// Strategy: for each element that can contain inline text, flatten its
// children into a contiguous text string, find "..." matches with their
// character offsets, then walk the flat segment list and wrap affected
// children in <span class="quoted-text">.

// ─── HAST type helpers (minimal, avoids @types/hast dep) ───

interface HastText {
  type: "text";
  value: string;
}

interface HastElement {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
}

interface HastRoot {
  type: "root";
  children: HastNode[];
}

type HastNode = HastText | HastElement | HastRoot;

function isText(node: HastNode): node is HastText {
  return node.type === "text" && typeof (node as HastText).value === "string";
}

function isElement(node: HastNode): node is HastElement {
  return node.type === "element";
}

function isRoot(node: HastNode): node is HastRoot {
  return node.type === "root";
}

// ─── Flatten + match + exact wrapping ───

const INLINE_TAGS = new Set(["a", "del", "em", "span", "strong", "sub", "sup"]);
const QUOTE_RE = /"[^"]*"|\u201C[^\u201D]*\u201D|\u00AB[^\u00BB]*\u00BB/g;

interface TextRange {
  start: number;
  end: number;
}

/** Recursively collect all visible inline text content from a node. */
function collectText(node: HastNode): string {
  if (isText(node)) return node.value;
  if (isElement(node) || isRoot(node)) return node.children.map(collectText).join("");
  return "";
}

function hasQuotedTextClass(node: HastElement): boolean {
  const className = node.properties?.className;
  if (typeof className === "string") return className.split(/\s+/).includes("quoted-text");
  if (Array.isArray(className)) return className.includes("quoted-text");
  return false;
}

function canFlattenChild(child: HastNode): boolean {
  if (isText(child)) return true;
  if (!isElement(child)) return false;
  if (!INLINE_TAGS.has(child.tagName) || child.tagName === "code") return false;
  return child.children.every(canFlattenChild);
}

function canWrapInlineQuotes(element: HastElement): boolean {
  if (element.tagName === "code" || element.tagName === "pre" || hasQuotedTextClass(element)) return false;
  return element.children.some(canFlattenChild);
}

function findQuotedRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  QUOTE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QUOTE_RE.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function cloneElementWithChildren(node: HastElement, children: HastNode[]): HastElement {
  return { ...node, children };
}

function sliceTextNode(node: HastText, nodeStart: number, from: number, to: number): HastText | null {
  const start = Math.max(0, from - nodeStart);
  const end = Math.min(node.value.length, to - nodeStart);
  if (start >= end) return null;
  return { type: "text", value: node.value.slice(start, end) };
}

/**
 * Return the exact node fragment covered by [from, to) in the flattened text.
 * Text nodes are split; inline elements are cloned with sliced children.
 */
function sliceNode(node: HastNode, nodeStart: number, from: number, to: number): HastNode | null {
  const nodeTextLength = collectText(node).length;
  const nodeEnd = nodeStart + nodeTextLength;
  if (nodeTextLength === 0 || nodeEnd <= from || nodeStart >= to) return null;

  if (isText(node)) return sliceTextNode(node, nodeStart, from, to);

  if (isElement(node)) {
    if (from <= nodeStart && nodeEnd <= to) return node;

    const children = sliceChildren(node.children, from, to, nodeStart);
    return children.length > 0 ? cloneElementWithChildren(node, children) : null;
  }

  return null;
}

function sliceChildren(children: HastNode[], from: number, to: number, baseOffset = 0): HastNode[] {
  const result: HastNode[] = [];
  let offset = baseOffset;

  for (const child of children) {
    const childLength = collectText(child).length;
    const sliced = sliceNode(child, offset, from, to);
    if (sliced) result.push(sliced);
    offset += childLength;
    if (offset >= to) break;
  }

  return result;
}

function wrapQuoteRun(children: HastNode[]): HastNode[] {
  const text = children.map(collectText).join("");
  if (text.length === 0) return children;

  const ranges = findQuotedRanges(text);
  if (ranges.length === 0) return children;

  const result: HastNode[] = [];
  let cursor = 0;

  for (const range of ranges) {
    result.push(...sliceChildren(children, cursor, range.start));

    const quotedChildren = sliceChildren(children, range.start, range.end);
    if (quotedChildren.length > 0) {
      result.push({
        type: "element",
        tagName: "span",
        properties: { className: ["quoted-text"] },
        children: quotedChildren,
      });
    }

    cursor = range.end;
  }

  result.push(...sliceChildren(children, cursor, text.length));
  return result;
}

/**
 * Process one inline element's children: find quoted ranges in flattened text
 * and wrap only the exact quoted characters in <span class="quoted-text">.
 *
 * Non-flattenable children such as inline <code> are treated as barriers so
 * quotes outside code still highlight, while quotes inside code stay untouched.
 */
function wrapQuotesInElement(element: HastElement): HastNode[] {
  const children = element.children;
  if (children.length === 0 || !canWrapInlineQuotes(element)) return children;

  const result: HastNode[] = [];
  let run: HastNode[] = [];
  let changed = false;

  const flushRun = () => {
    if (run.length === 0) return;
    const wrapped = wrapQuoteRun(run);
    if (wrapped !== run) changed = true;
    result.push(...wrapped);
    run = [];
  };

  for (const child of children) {
    if (canFlattenChild(child)) {
      run.push(child);
    } else {
      flushRun();
      result.push(child);
    }
  }

  flushRun();
  return changed ? result : children;
}

/** Recursively walk the tree and apply quote wrapping to text-containing elements. */
function processNode(node: HastNode): void {
  if (isRoot(node)) {
    for (const child of node.children) processNode(child);
    return;
  }

  if (!isElement(node)) return;

  if (node.tagName === "code" || node.tagName === "pre" || hasQuotedTextClass(node)) return;

  const newChildren = wrapQuotesInElement(node);
  if (newChildren !== node.children) node.children = newChildren;

  for (const child of node.children) processNode(child);
}

const rehypeQuotedText = () => (tree: HastNode) => processNode(tree);

// ─── Rehype plugin: System Banner ───

const BRACKET_RE = /\[([^\]\n]+)\]/g;

function hasSystemBannerClass(node: HastElement): boolean {
  const className = node.properties?.className;
  if (typeof className === "string") return className.split(/\s+/).includes("system-banner");
  if (Array.isArray(className)) return className.includes("system-banner");
  return false;
}

function canWrapSystemBanner(element: HastElement): boolean {
  if (element.tagName === "code" || element.tagName === "pre" || hasSystemBannerClass(element)) return false;
  return element.children.some(canFlattenChild);
}

function findBracketRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  BRACKET_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BRACKET_RE.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function wrapBracketRun(children: HastNode[]): HastNode[] {
  const text = children.map(collectText).join("");
  if (text.length === 0) return children;

  const ranges = findBracketRanges(text);
  if (ranges.length === 0) return children;

  const result: HastNode[] = [];
  let cursor = 0;

  for (const range of ranges) {
    result.push(...sliceChildren(children, cursor, range.start));

    const innerChildren = sliceChildren(children, range.start + 1, range.end - 1);
    if (innerChildren.length > 0) {
      result.push({
        type: "element",
        tagName: "span",
        properties: { className: ["system-banner"] },
        children: innerChildren,
      });
    }

    cursor = range.end;
  }

  result.push(...sliceChildren(children, cursor, text.length));
  return result;
}

function wrapBannersInElement(element: HastElement): HastNode[] {
  const children = element.children;
  if (children.length === 0 || !canWrapSystemBanner(element)) return children;

  const result: HastNode[] = [];
  let run: HastNode[] = [];
  let changed = false;

  const flushRun = () => {
    if (run.length === 0) return;
    const wrapped = wrapBracketRun(run);
    if (wrapped !== run) changed = true;
    result.push(...wrapped);
    run = [];
  };

  for (const child of children) {
    if (canFlattenChild(child)) {
      run.push(child);
    } else {
      flushRun();
      result.push(child);
    }
  }

  flushRun();
  return changed ? result : children;
}

function processBannerNode(node: HastNode): void {
  if (isRoot(node)) {
    for (const child of node.children) processBannerNode(child);
    return;
  }

  if (!isElement(node)) return;

  if (node.tagName === "code" || node.tagName === "pre" || hasSystemBannerClass(node)) return;

  const newChildren = wrapBannersInElement(node);
  if (newChildren !== node.children) node.children = newChildren;

  for (const child of node.children) processBannerNode(child);
}

const rehypeSystemBanner = () => (tree: HastNode) => processBannerNode(tree);

// ─── CodeBlock: fenced code with copy button ───
//
// Wraps <pre> + <code> produced by react-markdown. Responsibilities:
//  1. Shows a "Copy" button that writes the block's text to the clipboard.
//  2. For `text`, `plain`, or unlabeled blocks applies white-space:pre-wrap
//     so long lines wrap instead of scrolling horizontally.
//     Real language blocks keep overflow-x:auto (preserves code indentation).

const WRAP_LANGS = new Set(["text", "plain", "txt", ""]);

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);

  // Extract language from the child <code> className ("language-python" → "python").
  let lang = "";
  React.Children.forEach(children, (child) => {
    if (React.isValidElement(child) && child.type === "code") {
      const cls = (child.props as Record<string, unknown>).className as string | undefined;
      lang = cls?.replace(/^language-/, "") ?? "";
    }
  });

  const isWrap = WRAP_LANGS.has(lang);

  function handleCopy() {
    const text = extractText(children);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => {/* silent — clipboard unavailable */});
  }

  return (
    <div className="md-pre-wrap">
      <button
        type="button"
        className={`md-copy-btn${copied ? " md-copy-btn--ok" : ""}`}
        onClick={handleCopy}
        aria-label="Copy code"
      >
        {copied ? (
          // Checkmark
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <polyline points="2.5 8 6.5 12 13.5 4" />
          </svg>
        ) : (
          // Copy icon
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="1" width="9" height="11" rx="1.5" />
            <path d="M2 5H1.5A1.5 1.5 0 0 0 0 6.5v8A1.5 1.5 0 0 0 1.5 16h7A1.5 1.5 0 0 0 10 14.5V14" />
          </svg>
        )}
      </button>
      <pre className={`md-pre${isWrap ? " md-pre--wrap" : ""}`}>
        {children}
      </pre>
    </div>
  );
}

// ─── Component overrides ───

const components: Record<string, React.ComponentType<{ children?: React.ReactNode; className?: string; node?: unknown } & Record<string, unknown>>> = {
  p({ children, ...props }) {
    const text = extractText(children);
    const content = (typeof text === "string" ? text : "").trim();
    const blocks = content.match(SCENE_META_BLOCK_RE);
    const allMeta = Boolean(blocks?.length) && content.replace(SCENE_META_BLOCK_RE, "").trim().length === 0;

    if (allMeta && blocks) {
      return <div className="scene-meta">{blocks.join("\n")}</div>;
    }

    return <p {...props}>{children}</p>;
  },

  hr() {
    return <hr className="msg-hr" />;
  },

  ul({ children, ...props }) {
    return (
      <ul className="md-list" {...props}>
        {children}
      </ul>
    );
  },

  ol({ children, ...props }) {
    return (
      <ol className="md-list md-list-ordered" {...props}>
        {children}
      </ol>
    );
  },

  li({ children, ...props }) {
    return (
      <li className="md-list-item" {...props}>
        {children}
      </li>
    );
  },

  blockquote({ children, ...props }) {
    return (
      <blockquote className="md-blockquote" {...props}>
        {children}
      </blockquote>
    );
  },

  code({ className, children, ...props }) {
    if (!className) {
      return (
        <span className="md-code-inline" {...props}>
          {children}
        </span>
      );
    }
    return (
      <code className={className as string} {...props}>
        {children}
      </code>
    );
  },

  pre({ children }) {
    return <CodeBlock>{children}</CodeBlock>;
  },

  // Headings
  h1: ({ children, ...props }) => <h1 className="md-h1" {...props}>{children}</h1>,
  h2: ({ children, ...props }) => <h2 className="md-h2" {...props}>{children}</h2>,
  h3: ({ children, ...props }) => <h3 className="md-h3" {...props}>{children}</h3>,
  h4: ({ children, ...props }) => <h4 className="md-h4" {...props}>{children}</h4>,
  h5: ({ children, ...props }) => <h5 className="md-h5" {...props}>{children}</h5>,
  h6: ({ children, ...props }) => <h6 className="md-h6" {...props}>{children}</h6>,

  // Tables
  table: ({ children, ...props }) => (
    <div className="md-table-wrap">
      <table className="md-table" {...props}>{children}</table>
    </div>
  ),
  thead: ({ children, ...props }) => <thead className="md-thead" {...props}>{children}</thead>,
  tbody: ({ children, ...props }) => <tbody className="md-tbody" {...props}>{children}</tbody>,
  tr: ({ children, ...props }) => <tr className="md-tr" {...props}>{children}</tr>,
  th: ({ children, ...props }) => <th className="md-th" {...props}>{children}</th>,
  td: ({ children, ...props }) => <td className="md-td" {...props}>{children}</td>,
};

function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (React.isValidElement(children)) {
    if (children.type === "br") return "\n";
    if ((children.props as Record<string, unknown>).children) {
      return extractText((children.props as Record<string, unknown>).children as React.ReactNode);
    }
  }
  return "";
}

// ─── Public API ───

export const Markdown: React.FC<MarkdownProps> = ({ text, className }) => {
  if (!text) return null;

  return (
    <div className={className || "md-content"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeQuotedText, rehypeSystemBanner]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
};
