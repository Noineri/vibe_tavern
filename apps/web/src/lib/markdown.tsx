import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownProps {
  text: string;
  className?: string;
}

const SCENE_META_RE = /^\[.+:.+\]$/;

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

type HastNode = HastText | HastElement;

function isText(node: HastNode): node is HastText {
  return node.type === "text" && typeof (node as HastText).value === "string";
}

function isElement(node: HastNode): node is HastElement {
  return node.type === "element";
}

// ─── Flatten + match + wrap ───

interface FlatSegment {
  /** Character offset where this segment starts in the flattened string. */
  start: number;
  /** Character offset where this segment ends (exclusive). */
  end: number;
  /** Index of the source child in the parent's children array. */
  childIndex: number;
  /** The source child node (may be shared across segments if a child is split). */
  node: HastNode;
}

/**
 * Flatten an element's children into a contiguous text + segment map.
 * Only text nodes contribute characters; element boundaries are invisible
 * to quote matching (so "hello *world*" is treated as "hello world").
 */
function flattenText(children: HastNode[]): { text: string; segments: FlatSegment[] } {
  let text = "";
  const segments: FlatSegment[] = [];

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (isText(child)) {
      const start = text.length;
      text += child.value;
      segments.push({ start, end: text.length, childIndex: i, node: child });
    }
    // Elements (em, strong, etc.) are recursed into for their text content,
    // but the element node itself stays in place — we only wrap the outer
    // children, never split an <em> in half.
    if (isElement(child)) {
      const start = text.length;
      const innerText = collectText(child);
      text += innerText;
      if (innerText.length > 0) {
        segments.push({ start, end: text.length, childIndex: i, node: child });
      }
    }
  }

  return { text, segments };
}

/** Recursively collect all text content from a node. */
function collectText(node: HastNode): string {
  if (isText(node)) return node.value;
  if (isElement(node)) return node.children.map(collectText).join("");
  return "";
}

const QUOTE_RE = /"[^"]*"/g;

/**
 * Given flat text + segments and a regex match, return the range of child
 * indices covered by the match. A match may span multiple segments (when
 * italic/bold/etc. breaks the quoted text).
 */
function matchToChildRange(
  matchStart: number,
  matchEnd: number,
  segments: FlatSegment[],
): { first: number; last: number } | null {
  let first = -1;
  let last = -1;

  for (const seg of segments) {
    // Segment overlaps with [matchStart, matchEnd)
    if (seg.end > matchStart && seg.start < matchEnd) {
      if (first === -1) first = seg.childIndex;
      last = seg.childIndex;
    }
  }

  return first !== -1 ? { first, last } : null;
}

/**
 * Process one element's children: find quoted ranges and wrap them.
 * Returns a new children array (or the original if no quotes found).
 */
function wrapQuotesInElement(element: HastElement): HastNode[] {
  const children = element.children;
  if (children.length === 0) return children;

  const { text, segments } = flattenText(children);
  if (text.length === 0 || segments.length === 0) return children;

  // Find all quote matches
  const ranges: Array<{ first: number; last: number }> = [];
  QUOTE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QUOTE_RE.exec(text)) !== null) {
    const range = matchToChildRange(match.index, match.index + match[0].length, segments);
    if (range) ranges.push(range);
  }

  if (ranges.length === 0) return children;

  // Build new children array, wrapping matched ranges in <span class="quoted-text">
  const result: HastNode[] = [];
  let i = 0;

  for (const range of ranges) {
    // Push children before this quoted range
    while (i < range.first) {
      result.push(children[i]);
      i++;
    }

    // Collect children in the quoted range
    const wrappedChildren: HastNode[] = [];
    while (i <= range.last) {
      wrappedChildren.push(children[i]);
      i++;
    }

    result.push({
      type: "element",
      tagName: "span",
      properties: { className: "quoted-text" },
      children: wrappedChildren,
    });
  }

  // Push remaining children
  while (i < children.length) {
    result.push(children[i]);
    i++;
  }

  return result;
}

/** Recursively walk the tree and apply quote wrapping to text-containing elements. */
function processNode(node: HastNode): void {
  if (!isElement(node)) return;

  // Only process elements that can contain inline text.
  // Skip <code>, <pre>, and our own <span class="quoted-text">.
  if (node.tagName === "code" || node.tagName === "pre") return;

  // Recurse into children first (depth-first)
  for (const child of node.children) {
    processNode(child);
  }

  // Then wrap quotes at this level
  const newChildren = wrapQuotesInElement(node);
  if (newChildren !== node.children) {
    node.children = newChildren;
  }
}

const rehypeQuotedText = () => (tree: HastNode) => processNode(tree);

// ─── Component overrides ───

const components: Record<string, React.ComponentType<{ children?: React.ReactNode; className?: string; node?: unknown } & Record<string, unknown>>> = {
  p({ children, ...props }) {
    const text = extractText(children);
    const lines = (typeof text === "string" ? text : "").split("\n").filter((l: string) => l.trim());
    const allMeta = lines.length > 0 && lines.every((l: string) => SCENE_META_RE.test(l.trim()));

    if (allMeta) {
      return <div className="scene-meta">{children}</div>;
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
        <code className="md-code-inline" {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className={className as string} {...props}>
        {children}
      </code>
    );
  },

  pre({ children, ...props }) {
    return (
      <pre className="md-pre" {...props}>
        {children}
      </pre>
    );
  },
};

function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (React.isValidElement(children) && (children.props as Record<string, unknown>).children) {
    return extractText((children.props as Record<string, unknown>).children as React.ReactNode);
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
        rehypePlugins={[rehypeQuotedText]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
};
