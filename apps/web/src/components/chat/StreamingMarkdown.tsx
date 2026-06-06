import { Markdown } from "../../lib/markdown.js";

interface StreamingMarkdownProps {
  committedText: string;
  tailText: string;
}

/**
 * Streaming markdown renderer: parse only stable committed text as markdown,
 * and render the live reveal tail as plain text to avoid reparsing markdown on
 * every animation tick.
 */
export function StreamingMarkdown({ committedText, tailText }: StreamingMarkdownProps) {
  if (!committedText && !tailText) return null;

  return (
    <>
      {committedText ? <Markdown text={committedText} /> : null}
      {tailText ? <span className="streaming-tail whitespace-pre-wrap">{tailText}</span> : null}
    </>
  );
}
