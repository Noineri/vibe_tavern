/** Pure story-map model. Tick merging never changes pointer-to-message mapping. */
export interface RailMessage {
  readonly role: string;
  readonly position?: number;
  readonly content: string;
}

export interface RailEntry {
  readonly id: string;
  readonly displayIndex: number;
  readonly number: number;
  readonly role: "user" | "assistant";
  readonly author: string;
  readonly snippet: string;
}

export interface RailSegment {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly role: RailEntry["role"];
}

export function railSnippet(content: string, limit = 240): string {
  const text = Array.from(content.replace(/\s+/g, " ").trim());
  if (limit <= 0) return "";
  return text.length <= limit ? text.join("") : text.slice(0, limit - 1).join("") + "…";
}

export function buildRailEntries(
  displayIds: readonly string[],
  messages: Readonly<Record<string, RailMessage | undefined>>,
  names: { readonly user?: string; readonly assistant?: string } = {},
): RailEntry[] {
  const entries: RailEntry[] = [];
  displayIds.forEach((id, displayIndex) => {
    const message = messages[id];
    // No invented sequence numbers for transient, missing, or tool records.
    if (id.startsWith("__pending-") || !message || message.role === "tool" ||
      message.position === undefined || !Number.isInteger(message.position) || message.position < 0) return;
    const role = message.role === "user" ? "user" : "assistant";
    entries.push({ id, displayIndex, number: message.position + 1, role, author: names[role] ?? "", snippet: railSnippet(message.content) });
  });
  return entries;
}

/** At least 2px per tick + 2px gap. A zero-height rail has no ticks. */
export function buildRailSegments(entries: readonly RailEntry[], height: number): RailSegment[] {
  const count = Math.min(entries.length, Math.max(0, Math.floor(height / 4)));
  if (!Number.isFinite(count) || count <= 0) return [];
  return Array.from({ length: count }, (_, i) => {
    const startIndex = Math.floor(i * entries.length / count);
    const endIndex = Math.floor((i + 1) * entries.length / count) - 1;
    return { startIndex, endIndex, role: entries.slice(startIndex, endIndex + 1).some((entry) => entry.role === "user") ? "user" : "assistant" };
  });
}

export function railIndexAtY(y: number, top: number, height: number, count: number): number {
  if (count <= 0 || height <= 0 || !Number.isFinite(y + top + height + count)) return -1;
  return Math.max(0, Math.min(count - 1, Math.floor((y - top) / height * count)));
}

export function railIndexFraction(index: number, count: number): number {
  return count > 0 ? (Math.max(0, Math.min(count - 1, index)) + 0.5) / count : 0;
}

export function railWindow(scrollTop: number, scrollHeight: number, clientHeight: number): { start: number; end: number } {
  if (!Number.isFinite(scrollHeight + clientHeight) || scrollHeight <= 0 || clientHeight >= scrollHeight) return { start: 0, end: 1 };
  const visible = Math.max(0, clientHeight);
  const top = Math.max(0, Math.min(scrollHeight - visible, Number.isFinite(scrollTop) ? scrollTop : 0));
  return { start: top / scrollHeight, end: (top + visible) / scrollHeight };
}
