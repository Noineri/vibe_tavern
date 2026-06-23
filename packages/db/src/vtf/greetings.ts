/**
 * Vibe Tavern Format — greetings codec.
 *
 * A character's greetings (the primary `firstMessage` plus zero-or-more
 * `alternateGreetings`) are stored on disk as a small folder of one Markdown
 * file per greeting plus an ordered manifest:
 *
 * ```
 * greetings/
 *   _index.yaml   ordered manifest: [{id, name, file, primary}, ...]
 *   g_0000.md     primary greeting (former FIRST MESSAGE)
 *   g_0001.md     alternate (former alternateGreetings[0])
 *   g_0002.md     alternate (former alternateGreetings[1])
 * ```
 *
 * Stable IDs: filenames are position-derived (`g_` + 4-hex of the creation
 * index) and NEVER derived from content — editing a greeting's body must not
 * rename its file. Once written, the manifest pins the id↔file↔order mapping,
 * so subsequent reads/writes preserve it. Reordering greetings updates the
 * manifest's array order only; filenames stay put.
 *
 * This module also offers a secondary inline-marker representation
 * ({@link splitGreetingsInline} / {@link compileGreetingsInline}) used to pack
 * all greetings into a single text blob for the legacy markdown import path
 * and for compact previews. The canonical on-disk form is the folder layout
 * above; inline markers are a convenience codec.
 *
 * No YAML dependency (see `profile-md.ts`): the `_index.yaml` dialect is a
 * fixed list-of-maps with scalar values, parsed/emitted by hand here.
 */

// ───────────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────────

/** A single VTF greeting entry. */
export interface VtfGreeting {
  /** Stable id matching its `g_{4hex}.md` filename stem. Position-derived at creation, then pinned by the manifest. */
  id: string;
  /** Display name shown in UI lists. Defaults derived from position (see {@link defaultGreetingName}). */
  name: string;
  /** Filename inside `greetings/` (e.g. `g_0001.md`). Always `<id>.md`. */
  file: string;
  /** Exactly one greeting per character has `primary: true` (the former FIRST MESSAGE). */
  primary: boolean;
  /** The greeting body text. */
  content: string;
}

/** A virtual file entry produced/consumed by the folder codec. The facade writes these via `ContentStore`. */
export interface GreetingFileEntry {
  /** Path relative to the character folder, e.g. `greetings/g_0001.md` or `greetings/_index.yaml`. */
  path: string;
  content: string;
}

// ───────────────────────────────────────────────────────────────────────────
// id + name helpers
// ───────────────────────────────────────────────────────────────────────────

/** ID_PREFIX + 4-hex zero-padded index. `g_0000`, `g_0001`, ... `g_00ff`, `g_0100`, ... */
export const GREETING_ID_PREFIX = "g_";
const ID_RADIX = 16;
const ID_MIN_WIDTH = 4;

/** Format a positional index as a stable greeting id (`g_{4hex}`). */
export function greetingIdFromIndex(index: number): string {
  return `${GREETING_ID_PREFIX}${index.toString(ID_RADIX).padStart(ID_MIN_WIDTH, "0")}`;
}

/** Inverse of {@link greetingIdFromIndex}: parse the positional index from a stable id. Returns null if malformed. */
export function indexFromGreetingId(id: string): number | null {
  if (!id.startsWith(GREETING_ID_PREFIX)) return null;
  const hex = id.slice(GREETING_ID_PREFIX.length);
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  return parseInt(hex, ID_RADIX);
}

/** True if `s` looks like a stable greeting id (`g_` + ≥4 hex). */
export function isStableGreetingId(s: string): boolean {
  return new RegExp(`^${GREETING_ID_PREFIX}[0-9a-f]{4,}$`).test(s);
}

/** Default display name for a greeting at a given position (primary = index 0). */
export function defaultGreetingName(index: number): string {
  return index === 0 ? "First Message" : `Alt ${index}`;
}

// ───────────────────────────────────────────────────────────────────────────
// Character ↔ greetings
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build a VTF greeting list from a character's greeting fields. IDs are
 * position-derived (deterministic). The caller (facade/store) may instead read
 * an existing `_index.yaml` to preserve previously-assigned ids; this helper is
 * for first-time generation and round-trip tests.
 */
export function greetingsFromCharacter(firstMessage: string, alternateGreetings: string[]): VtfGreeting[] {
  const all = [firstMessage, ...alternateGreetings];
  return all.map((content, index) => {
    const id = greetingIdFromIndex(index);
    return {
      id,
      name: defaultGreetingName(index),
      file: `${id}.md`,
      primary: index === 0,
      content,
    };
  });
}

/**
 * Reduce a VTF greeting list back to character fields. The primary greeting
 * (primary:true, else the first) becomes `firstMessage`; the rest (in array
 * order) become `alternateGreetings`.
 */
export function characterFromGreetings(greetings: VtfGreeting[]): {
  firstMessage: string;
  alternateGreetings: string[];
} {
  if (greetings.length === 0) return { firstMessage: "", alternateGreetings: [] };
  const primaryIndex = greetings.findIndex((g) => g.primary);
  const ordered = [...greetings];
  if (primaryIndex > 0) {
    // Move the primary to the front so it round-trips to firstMessage.
    const [primary] = ordered.splice(primaryIndex, 1);
    ordered.unshift(primary!);
  } else if (primaryIndex === -1) {
    // No primary flag — mark the first as primary for stability.
    ordered[0]!.primary = true;
  }
  return {
    firstMessage: ordered[0]!.content,
    alternateGreetings: ordered.slice(1).map((g) => g.content),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// _index.yaml codec (hand-rolled, fixed list-of-maps dialect)
// ───────────────────────────────────────────────────────────────────────────

const INDEX_HEADER = "# VTF greetings manifest. Do not reorder by renaming files — edit the list order below.";

/** Compile the ordered manifest text for `greetings/_index.yaml`. */
export function compileGreetingsIndex(greetings: VtfGreeting[]): string {
  const lines: string[] = [INDEX_HEADER, ""];
  for (const g of greetings) {
    lines.push(`- id: ${g.id}`);
    lines.push(`  name: ${emitScalar(g.name)}`);
    lines.push(`  file: ${g.file}`);
    lines.push(`  primary: ${g.primary ? "true" : "false"}`);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Parse `greetings/_index.yaml` text into a list of partial entries (content comes from the `.md` files). */
export function parseGreetingsIndex(text: string): Array<{ id: string; name: string; file: string; primary: boolean }> {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const entries: Array<{ id: string; name: string; file: string; primary: boolean }> = [];
  let current: { id: string; name: string; file: string; primary: boolean } | null = null;
  for (const line of lines) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    // A list-item start begins a new entry.
    const itemStart = /^-\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (itemStart) {
      if (current) entries.push(current);
      current = blankEntry();
      applyField(current, itemStart[1]!, itemStart[2]!);
      continue;
    }
    const sub = /^\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (sub && current) {
      applyField(current, sub[1]!, sub[2]!);
    }
  }
  if (current) entries.push(current);
  return entries;
}

function blankEntry(): { id: string; name: string; file: string; primary: boolean } {
  return { id: "", name: "", file: "", primary: false };
}

function applyField(entry: { id: string; name: string; file: string; primary: boolean }, key: string, raw: string): void {
  switch (key) {
    case "id":
      entry.id = unquote(raw);
      break;
    case "name":
      entry.name = unquote(raw);
      break;
    case "file":
      entry.file = unquote(raw);
      break;
    case "primary":
      entry.primary = raw.trim() === "true";
      break;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Folder codec (greetings/ as virtual file entries)
// ───────────────────────────────────────────────────────────────────────────

const GREETINGS_DIR = "greetings";
const INDEX_FILE = "greetings/_index.yaml";

/** Serialize a greeting list to virtual file entries (manifest + one `.md` per greeting). Order = manifest array order. */
export function writeGreetingsFolder(greetings: VtfGreeting[]): GreetingFileEntry[] {
  const entries: GreetingFileEntry[] = [];
  entries.push({ path: INDEX_FILE, content: compileGreetingsIndex(greetings) });
  for (const g of greetings) {
    entries.push({ path: `${GREETINGS_DIR}/${g.file}`, content: bodyWithFooter(g) });
  }
  return entries;
}

/**
 * Parse virtual file entries back into a greeting list. The manifest supplies
 * order + ids + names + primary flags; each `.md` file supplies the content.
 * Entries are matched by `file`; orphan files or manifest rows are ignored
 * gracefully (never throw).
 */
export function readGreetingsFolder(entries: GreetingFileEntry[]): VtfGreeting[] {
  const byPath = new Map(entries.map((e) => [normalizePath(e.path), e.content]));
  const indexText = byPath.get(INDEX_FILE) ?? byPath.get("greetings/_index.yaml");
  if (!indexText) return [];
  const manifest = parseGreetingsIndex(indexText);
  const greetings: VtfGreeting[] = [];
  for (const entry of manifest) {
    if (!entry.id || !entry.file) continue;
    const content = byPath.get(normalizePath(`${GREETINGS_DIR}/${entry.file}`)) ?? "";
    greetings.push({
      id: entry.id,
      name: entry.name || defaultGreetingName(greetings.length),
      file: entry.file,
      primary: entry.primary,
      content: stripFooter(content),
    });
  }
  return greetings;
}

/** Normalize path separators and collapse `./` for matching. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Footer marking the boundary between body and any future per-greeting metadata. */
const FOOTER_MARKER = "<!-- vtf:greeting-meta -->";

/** Write a greeting body. Today no per-file metadata is stored, so the footer is omitted. Kept for forward-compat. */
function bodyWithFooter(g: VtfGreeting): string {
  return g.content.replace(/\r\n?/g, "\n").replace(/\n+$/g, "") + "\n";
}

/** Strip a trailing footer marker block if present (forward-compat). */
function stripFooter(content: string): string {
  const idx = content.indexOf(FOOTER_MARKER);
  if (idx === -1) return content.replace(/^\n+|\n+$/g, "");
  return content.slice(0, idx).replace(/^\n+|\n+$/g, "");
}

// ───────────────────────────────────────────────────────────────────────────
// Inline-marker codec (legacy markdown import / compact preview)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Inline marker grammar (canonical, tolerant on parse):
 *
 * ```
 * <primary greeting body>
 *
 * === ALT 1 ===
 * <alternate 1 body>
 *
 * === ALT 2 ===
 * <alternate 2 body>
 * ```
 *
 * Parse-side accepts: `=== ALT ===`, `=== ALT 1 ===`, `=== ALT 2 ===`, and
 * case-insensitive `Alt`/`ALT`. The primary block is everything before the
 * first marker. Empty trailing blocks are dropped.
 */
const INLINE_MARKER_RE = /^[=\-]{3}\s*(?:alt|ALT)(?:\s+(\d+))?\s*[=\-]{3}\s*$/;

/** Split a single text blob (canonical or hand-authored) into a greeting list with stable position-derived ids. */
export function splitGreetingsInline(text: string): VtfGreeting[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (INLINE_MARKER_RE.test(line.trim())) {
      blocks.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  blocks.push(current.join("\n"));

  // First block is the primary; each subsequent non-empty block is an alternate.
  const greetings: VtfGreeting[] = [];
  let index = 0;
  for (const block of blocks) {
    const trimmed = block.replace(/^\n+|\n+$/g, "");
    if (index > 0 && trimmed.length === 0) continue; // drop empty alternates
    greetings.push({
      id: greetingIdFromIndex(index),
      name: defaultGreetingName(index),
      file: `${greetingIdFromIndex(index)}.md`,
      primary: index === 0,
      content: trimmed,
    });
    index++;
  }
  // Drop a wholly-empty primary only if there are no alternates.
  if (greetings.length === 1 && greetings[0]!.content.trim() === "") return [];
  return greetings;
}

/** Compile a greeting list into a single inline-marker text blob (canonical form). */
export function compileGreetingsInline(greetings: VtfGreeting[]): string {
  if (greetings.length === 0) return "";
  const parts: string[] = [];
  for (let i = 0; i < greetings.length; i++) {
    const g = greetings[i]!;
    if (i > 0) {
      const altNumber = primaryAdjustedAltNumber(greetings, i);
      parts.push("", `=== ALT ${altNumber} ===`, "");
    }
    parts.push(g.content.replace(/^\n+|\n+$/g, ""));
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "") + "\n";
}

/**
 * Alt number for the alternate at `i`, counting only alternates (primary
 * excluded) starting at 1. This keeps `=== ALT N ===` labels stable across
 * primary moves.
 */
function primaryAdjustedAltNumber(greetings: VtfGreeting[], i: number): number {
  let altCount = 0;
  for (let j = 0; j < i; j++) {
    if (!greetings[j]!.primary) altCount++;
  }
  // If there is no earlier primary, this alternate is the first non-primary; count from 1.
  return altCount + 1;
}

// ───────────────────────────────────────────────────────────────────────────
// Scalar emit/parse helpers (shared dialect with profile-md.ts)
// ───────────────────────────────────────────────────────────────────────────

function needsQuotes(text: string): boolean {
  if (text === "") return true;
  if (text !== text.trim()) return true;
  if (/^["'#\[\]{}&*!|>'%@`,]/.test(text)) return true;
  if (/:\s/.test(text)) return true;
  if (/^(true|false|null|yes|no|~)$/i.test(text)) return true;
  if (/^-?\d+(\.\d+)?$/.test(text)) return true;
  return false;
}

function emitScalar(text: string): string {
  if (!needsQuotes(text)) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2) {
    if ((trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') || (trimmed[0] === "'" && trimmed[trimmed.length - 1] === "'")) {
      const inner = trimmed.slice(1, -1);
      return trimmed[0] === '"' ? inner.replace(/\\"/g, '"') : inner.replace(/\\'/g, "'");
    }
  }
  return trimmed;
}
