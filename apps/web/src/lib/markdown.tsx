import React from 'react';

interface MarkdownProps {
  text: string;
  className?: string;
}

function parseInlineFormatting(text: string, keyPrefix: string): (string | React.ReactNode)[] {
  const parts = text.split(/(\*[^*]+\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={`${keyPrefix}-${index}`}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
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
