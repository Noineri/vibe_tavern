import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownProps {
  text: string;
  className?: string;
}

const SCENE_META_RE = /^\[.+:.+\]$/;

/**
 * Custom text renderer: wraps "quoted text" in a colored span.
 */
function TextWithQuotes({ children }: { children?: React.ReactNode }) {
  if (typeof children !== "string") return <>{children}</>;

  const parts: React.ReactNode[] = [];
  const quoteRe = /("[^"]*")/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = quoteRe.exec(children)) !== null) {
    if (match.index > last) parts.push(children.slice(last, match.index));
    parts.push(
      <span key={`q-${key++}`} className="quoted-text">
        {match[0]}
      </span>
    );
    last = quoteRe.lastIndex;
  }
  if (last < children.length) parts.push(children.slice(last));

  return parts.length === 1 ? <>{parts[0]}</> : <>{parts}</>;
}

const components: Record<string, React.ComponentType<any>> = {
  p({ children, node, ...props }: any) {
    // Detect scene-meta paragraphs: every child line matches [key: value]
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

  strong({ children }: any) {
    return <strong>{children}</strong>;
  },

  em({ children }: any) {
    return <em>{children}</em>;
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

  code({ inline, className, children, ...props }: any) {
    if (inline) {
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

  text({ children }: any) {
    return <TextWithQuotes>{children}</TextWithQuotes>;
  },
};

/**
 * Extract plain text from React children (for scene-meta detection).
 */
function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (React.isValidElement(children) && (children.props as any).children) {
    return extractText((children.props as any).children);
  }
  return "";
}

export const Markdown: React.FC<MarkdownProps> = ({ text, className }) => {
  if (!text) return null;

  return (
    <div className={className || "md-content"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
};

export function renderRPText(text: string): React.ReactNode {
  return <Markdown text={text} />;
}
