import type { ReactNode } from "react";
import { Markdown } from "../../lib/markdown.js";

interface StreamingMarkdownProps {
  text: string;
  indicator?: ReactNode;
}

export function StreamingMarkdown({ text, indicator }: StreamingMarkdownProps) {
  if (!text && !indicator) return null;

  return (
    <div className="streaming-markdown flex flex-col">
      {text && <Markdown text={text} />}
      {indicator && (
        <div className="streaming-generation-indicator flex min-h-[1.65em] shrink-0 items-center">
          {indicator}
        </div>
      )}
    </div>
  );
}
