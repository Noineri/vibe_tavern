import type { ReactNode } from "react";
import { Markdown } from "../../lib/markdown.js";

interface StreamingMarkdownProps {
  text: string;
  trailing?: ReactNode;
}

export function StreamingMarkdown({ text, trailing }: StreamingMarkdownProps) {
  if (!text) return trailing;
  return <Markdown text={text} trailing={trailing} />;
}
