import React from 'react';

interface MarkdownProps {
  text: string;
  className?: string;
}

type InlineNode = string | React.ReactNode;

const INLINE_RE = /(\*{3}[^*]+\*{3})|(\*{2}[^*]+\*{2})|(\*[^*]+\*)|("[^"]+")/g;

function parseInlineFormatting(text: string, keyPrefix: string): InlineNode[] {
  const result: InlineNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let keyIdx = 0;

  INLINE_RE.lastIndex = 0;
  while ((match = INLINE_RE.exec(text)) !== null) {
    // Push plain text before this match
    if (match.index > lastIndex) {
      result.push(text.slice(lastIndex, match.index));
    }
    lastIndex = INLINE_RE.lastIndex;

    const full = match[0];
    if (match[1]) {
      // ***bold italic***
      result.push(<strong key={`${keyPrefix}-bi-${keyIdx++}`}><em>{full.slice(3, -3)}</em></strong>);
    } else if (match[2]) {
      // **bold**
      result.push(<strong key={`${keyPrefix}-b-${keyIdx++}`}>{full.slice(2, -2)}</strong>);
    } else if (match[3]) {
      // *italic*
      result.push(<em key={`${keyPrefix}-i-${keyIdx++}`}>{full.slice(1, -1)}</em>);
    } else if (match[4]) {
      // "quoted text"
      result.push(<span key={`${keyPrefix}-q-${keyIdx++}`} className="quoted-text">{full}</span>);
    }
  }

  // Remaining text after last match
  if (lastIndex < text.length) {
    result.push(text.slice(lastIndex));
  }

  return result;
}

const SCENE_META_RE = /^\[.+:.+\]$/;

function renderParagraphContent(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const result: React.ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) result.push(<br key={`br-${i}`} />);
    result.push(...parseInlineFormatting(lines[i], `l${i}`));
  }
  return result;
}

export const Markdown: React.FC<MarkdownProps> = ({ text, className }) => {
  if (!text) return null;

  let normalized = text.replace(/\r\n/g, '\n');
  normalized = normalized.replace(/^[_*\-]{3,}$/gm, '\n\n___HR___\n\n');
  const paragraphs = normalized.split(/\n\n+/).filter(p => p.trim().length > 0);

  return (
    <div className={className}>
      {paragraphs.map((para, i) => {
        const trimmed = para.trim();

        if (trimmed === '___HR___') {
          return <hr key={i} className="msg-hr" />;
        }

        const lines = trimmed.split('\n');
        const allMeta = lines.length > 0 && lines.every(l => SCENE_META_RE.test(l.trim()));
        if (allMeta) {
          return (
            <div key={i} className="scene-meta">
              {lines.map((l, j) => (
                <React.Fragment key={j}>
                  {j > 0 && <br />}
                  {l}
                </React.Fragment>
              ))}
            </div>
          );
        }

        return (
          <p key={i} style={{ marginTop: i > 0 ? '0.88em' : 0 }}>
            {renderParagraphContent(trimmed)}
          </p>
        );
      })}
    </div>
  );
};

export function renderRPText(text: string): React.ReactNode {
  return <Markdown text={text} />;
}
