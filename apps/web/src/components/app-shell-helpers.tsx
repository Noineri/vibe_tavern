import type { PromptTraceRecordDto } from "@rp-platform/domain";

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function renderParagraphs(content: string) {
  return content.split(/\n{2,}/).map((paragraph, index) => (
    <p key={`${index}-${paragraph.slice(0, 12)}`}>{paragraph}</p>
  ));
}

export function formatTraceTimestamp(value: PromptTraceRecordDto["createdAt"]): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}
