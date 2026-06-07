import { Markdown } from "../../lib/markdown.js";

interface StreamingMarkdownProps {
  text: string;
}

export function StreamingMarkdown({ text }: StreamingMarkdownProps) {
  if (!text) return null;
  return <Markdown text={text} />;
}
