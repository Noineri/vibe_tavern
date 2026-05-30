import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownProps {
  text: string;
  className?: string;
}

const SCENE_META_RE = /^\[.+:.+\]$/;

// ─── Rehype plugin: wrap "quoted text" in <span class="quoted-text"> ───

const QUOTE_RE = /("[^"]*")/g;

function splitQuoted(value: string): any[] {
  const result: any[] = [];
  let last = 0;

  QUOTE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QUOTE_RE.exec(value)) !== null) {
    if (match.index > last) {
      result.push({ type: "text", value: value.slice(last, match.index) });
    }
    result.push({
      type: "element",
      tagName: "span",
      properties: { className: "quoted-text" },
      children: [{ type: "text", value: match[0] }],
    });
    last = QUOTE_RE.lastIndex;
  }
  if (last < value.length) {
    result.push({ type: "text", value: value.slice(last) });
  }
  return result.length > 0 ? result : [{ type: "text", value }];
}

function visitText(node: any): void {
  if (!node.children) return;
  const next: any[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      next.push(...splitQuoted(child.value));
    } else if (child.type === "element") {
      visitText(child);
      next.push(child);
    } else {
      next.push(child);
    }
  }
  node.children = next;
}

const rehypeQuotedText = () => (tree: any) => visitText(tree);

// ─── Component overrides ───

const components: Record<string, React.ComponentType<any>> = {
  p({ children, node, ...props }: any) {
    const text = extractText(children);
    const lines = text.split("\n").filter((l: string) => l.trim());
    const allMeta = lines.length > 0 && lines.every((l: string) => SCENE_META_RE.test(l.trim()));

    if (allMeta) {
      return <div className="scene-meta">{children}</div>;
    }

    return <p {...props}>{children}</p>;
  },

  hr() {
    return <hr className="msg-hr" />;
  },

  ul({ children, ...props }: any) {
    return (
      <ul className="md-list" {...props}>
        {children}
      </ul>
    );
  },

  ol({ children, ...props }: any) {
    return (
      <ol className="md-list md-list-ordered" {...props}>
        {children}
      </ol>
    );
  },

  li({ children, ...props }: any) {
    return (
      <li className="md-list-item" {...props}>
        {children}
      </li>
    );
  },

  blockquote({ children, ...props }: any) {
    return (
      <blockquote className="md-blockquote" {...props}>
        {children}
      </blockquote>
    );
  },

  code({ className, children, ...props }: any) {
    if (!className) {
      return (
        <code className="md-code-inline" {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },

  pre({ children, ...props }: any) {
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

function renderRPText(text: string): React.ReactNode {
  return <Markdown text={text} />;
}
