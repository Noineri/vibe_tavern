import React from 'react';

/**
 * A specialized Markdown parser for Roleplay.
 * Focuses on paragraph handling and asterisk-based italics (*action*).
 */

interface MarkdownProps {
  text: string;
  className?: string;
}

/**
 * Parses a single block of text (paragraph) and converts *text* into <em>text</em>.
 */
function parseInlineFormatting(text: string): (string | React.ReactNode)[] {
  // Regex to match text between asterisks
  const parts = text.split(/(\*[^*]+\*)/g);

  return parts.map((part, index) => {
    if (part.startsWith('*') && part.endsWith('*')) {
      // Return as italicized element, removing the asterisks
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}

/**
 * The main Markdown component.
 * Splits input text into paragraphs and renders them as <p> tags.
 */
export const Markdown: React.FC<MarkdownProps> = ({ text, className }) => {
  if (!text) return null;

  // Split by double newlines for paragraphs
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);

  return (
    <div className={className}>
      {paragraphs.map((para, i) => (
        <p key={i} style={{ marginTop: i > 0 ? '0.88em' : 0 }}>
          {parseInlineFormatting(para)}
        </p>
      ))}
    </div>
  );
};

/**
 * Utility function for direct use without component wrapper
 */
export function renderRPText(text: string): React.ReactNode {
  return <Markdown text={text} />;
}
