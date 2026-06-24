/**
 * Vibe Tavern Format — `profile.md` codec.
 *
 * Serializes/parses the canonical VTF **prose** document: a YAML-frontmatter
 * header (a FIXED, small schema — see {@link VtfProfile}) followed by the
 * three prose H1 body sections (`# PERSONALITY`, `# SCENARIO`, `# EXAMPLES`).
 *
 * This codec is PROSE-ONLY: functional instruction fields (`# SYSTEM`,
 * `# POST-HISTORY`, `# DEPTH PROMPT` + their `vt.depth_prompt_*` config) live
 * in `instructions.json` (see `instructions.ts`), NOT in this document. Those
 * headings exist only in the exchange monolith (`monolith.ts`). If they appear
 * in a `profile.md`, they are preserved losslessly as unknown sections
 * (never routed to fields).
 *
 * This is a HAND-ROLLED codec for our own canonical dialect, not a general
 * YAML parser (no YAML dependency exists in the workspaces and `import-export`
 * is intentionally `domain`-only). The frontmatter grammar we accept is
 * deliberately narrow: scalars, one inline flow array (`tags`), one nested
 * `vt:` map, and block scalars (`key: |`). Unknown frontmatter keys, unknown
 * `vt:` keys, and unknown body sections are preserved verbatim so that
 * `MD → Form → MD` is lossless (they re-emit after the known/canonical ones).
 *
 * Routing contract (section/frontmatter key → Character field → canvas slot)
 * lives in `plans/VIBE_TAVERN_FORMAT.md`; this module is the single source of
 * truth for HOW that contract is serialized.
 *
 * Round-trip invariants (pinned by `profile-md.test.ts`):
 *  - `Form → MD → Form` produces identical field values.
 *  - `MD → Form → MD` produces textually identical MD after canonicalization
 *    (canonical frontmatter key order, canonical heading order, single blank
 *    line between sections, empty optionals omitted).
 */

// ───────────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────────

/** Default value for {@link VtfProfile.mesExampleMode} (mirrors CharacterForm). */
export const DEFAULT_MES_EXAMPLE_MODE = "always";
/** Default value for {@link VtfProfile.mesExampleDepth} and depthPrompt depth (mirrors assemble.ts). */
export const DEFAULT_DEPTH = 4;

/**
 * The known VTF profile fields — the subset of a `Character` that is authored
 * as prose/config inside `profile.md`. Maps 1:1 to the routing contract.
 *
 * `personalitySummary` is intentionally absent: VTF-native cards express the
 * whole personality in `# PERSONALITY` → `description`; a non-empty legacy
 * `personalitySummary` is preserved losslessly via `extensions.json` (facade),
 * never through this codec.
 */
export interface VtfProfile {
  /** frontmatter `name` (required). */
  name: string;
  /** frontmatter `tags` (inline flow array). */
  tags: string[];
  /** frontmatter `creator` (from `extensions.creator`). */
  creator: string | null;
  /** frontmatter `character_version` (from `extensions.character_version`). */
  characterVersion: string | null;
  /** frontmatter `creator_notes` (block scalar). */
  creatorNotes: string | null;
  /** frontmatter `vt.mes_example_mode` (`always` | `once` | `depth`). */
  mesExampleMode: string;
  /** frontmatter `vt.mes_example_depth`. */
  mesExampleDepth: number;
  /** `# PERSONALITY` body → `description` / `charDescription` slot (required). */
  description: string;
  /** `# SCENARIO` body → `defaultScenario` / `scenario` slot. */
  scenario: string | null;
  /** `# EXAMPLES` body → `mesExample`. */
  mesExample: string | null;
}

/** A preserved-verbatim frontmatter entry (used for unknown keys). */
export interface FrontmatterEntry {
  key: string;
  /** Value text. For scalars/flow arrays: the raw value (quotes stripped). For block scalars: the de-indented content. */
  value: string;
  /** `true` → re-emit as a `key: |` block scalar. */
  block: boolean;
}

/** A preserved-verbatim body section (used for unknown headings). */
export interface BodySection {
  /** Heading text exactly as written after `# ` (e.g. `CUSTOM NOTES`). */
  heading: string;
  /** Section body, with leading/trailing blank lines trimmed. */
  body: string;
}

/** Shape accepted by {@link serializeProfileMd}. */
export interface ProfileMd {
  profile: VtfProfile;
  /** Unknown top-level frontmatter keys, re-emitted after the known ones. */
  unknownFrontmatter?: FrontmatterEntry[];
  /** Unknown `vt:` keys, re-emitted after the known ones inside `vt:`. */
  unknownVt?: FrontmatterEntry[];
  /** Unknown body sections, re-emitted after the known ones. */
  unknownSections?: BodySection[];
}

/** Shape returned by {@link parseProfileMd} (round-trips into {@link ProfileMd}). */
export interface ParsedProfile extends ProfileMd {}

// ───────────────────────────────────────────────────────────────────────────
// Canonical ordering
// ───────────────────────────────────────────────────────────────────────────

/** Canonical emission order for the known (prose) body sections. */
const KNOWN_SECTIONS = [
  "PERSONALITY",
  "SCENARIO",
  "EXAMPLES",
] as const;

/**
 * Maps a known heading to the {@link VtfProfile} field it feeds.
 *
 * Functional instruction sections (`# SYSTEM` / `# POST-HISTORY` /
 * `# DEPTH PROMPT`) are intentionally NOT mapped here — they live in
 * `instructions.json`, not the prose document. If they appear in a
 * `profile.md`, they are preserved losslessly as {@link BodySection} unknowns.
 */
type SectionField = "description" | "scenario" | "mesExample";

const SECTION_TO_FIELD: Readonly<Record<string, SectionField>> = {
  "PERSONALITY": "description",
  "SCENARIO": "scenario",
  "EXAMPLES": "mesExample",
};

// ───────────────────────────────────────────────────────────────────────────
// Frontmatter value model
// ───────────────────────────────────────────────────────────────────────────

type FmValue =
  | { kind: "scalar"; text: string }
  | { kind: "flowArray"; items: string[] }
  | { kind: "block"; text: string }
  | { kind: "map"; entries: FmEntry[] };

interface FmEntry {
  key: string;
  value: FmValue;
  /** For scalar/flowArray entries: the raw value text exactly as written (quotes/brackets intact), used to re-emit unknown keys byte-faithfully. Undefined for block/map kinds. */
  raw?: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Parser
// ───────────────────────────────────────────────────────────────────────────

/**
 * Parse a `profile.md` document into {@link ParsedProfile}.
 *
 * Tolerant of: quoted/unquoted scalars, inline flow arrays, block scalars, and
 * the nested `vt:` map. Missing frontmatter yields a profile with defaults
 * (the caller may treat an empty `name` as invalid). Never throws on unknown
 * keys/sections — they are preserved.
 */
export function parseProfileMd(text: string): ParsedProfile {
  const { frontmatterText, bodyText } = splitFrontmatter(text);
  const fmEntries = frontmatterText.length > 0 ? parseFrontmatter(frontmatterText) : [];
  const sections = parseBodySections(bodyText);

  const { profile, unknownFrontmatter, unknownVt } = extractProfileFromFrontmatter(fmEntries);
  const { profile: profileFromSections, unknownSections } = extractProfileFromSections(sections);

  // Section-derived fields override only when the frontmatter didn't set them
  // (sections are the source for prose fields; frontmatter never carries them).
  for (const field of Object.keys(profileFromSections) as SectionField[]) {
    const value = profileFromSections[field];
    if (value !== null && value !== undefined) {
      (profile as Record<SectionField, string | null>)[field] = value;
    }
  }

  return { profile, unknownFrontmatter, unknownVt, unknownSections };
}

/** Split a document into the frontmatter block (between `---` fences) and the body. */
function splitFrontmatter(text: string): { frontmatterText: string; bodyText: string } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // Leading blank lines before the opening fence are tolerated.
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (i >= lines.length || lines[i]!.trim() !== "---") {
    return { frontmatterText: "", bodyText: text.replace(/\r\n?/g, "\n").trim() };
  }
  const start = i + 1;
  let end = start;
  while (end < lines.length && lines[end]!.trim() !== "---") end++;
  if (end >= lines.length) {
    // Unterminated frontmatter — treat the rest as frontmatter (graceful).
    return { frontmatterText: lines.slice(start).join("\n"), bodyText: "" };
  }
  const frontmatterText = lines.slice(start, end).join("\n");
  const bodyText = lines.slice(end + 1).join("\n").trim();
  return { frontmatterText, bodyText };
}

/** Parse frontmatter lines into an ordered list of entries. */
function parseFrontmatter(text: string): FmEntry[] {
  const lines = text.split("\n");
  const entries: FmEntry[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const match = /^([A-Za-z0-9_]+)[ \t]*:(.*)$/.exec(line);
    if (!match) {
      // Unrecognized line shape — skip gracefully.
      i++;
      continue;
    }
    const key = match[1]!;
    const rest = match[2]!.trim();
    if (rest === "|") {
      // Block scalar: consume following indented lines.
      const { block, next } = consumeBlock(lines, i + 1);
      entries.push({ key, value: { kind: "block", text: block } });
      i = next;
    } else if (rest === "") {
      // Could be a nested map (indented sub-entries follow) or an empty scalar.
      const { map, next, hadSub } = consumeMap(lines, i + 1);
      if (hadSub) {
        entries.push({ key, value: { kind: "map", entries: map } });
        i = next;
      } else {
        entries.push({ key, value: { kind: "scalar", text: "" } });
        i = next;
      }
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      entries.push({ key, value: { kind: "flowArray", items: parseFlowArray(rest) }, raw: rest });
      i++;
    } else {
      entries.push({ key, value: { kind: "scalar", text: unquote(rest) }, raw: rest });
      i++;
    }
  }
  return entries;
}

/** Consume a block scalar body (indented lines following `key: |`). */
function consumeBlock(lines: string[], from: number): { block: string; next: number } {
  const collected: string[] = [];
  let i = from;
  let indent: number | null = null;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      // Blank lines are part of the block only if more indented content follows.
      collected.push("");
      i++;
      continue;
    }
    const leading = line.length - line.trimStart().length;
    if (indent === null) indent = leading;
    if (leading < indent!) {
      // First non-indented line ends the block (but we may have trailing blanks).
      break;
    }
    collected.push(line.slice(indent!));
    i++;
  }
  // Trim trailing blank lines captured.
  while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();
  return { block: collected.join("\n"), next: i };
}

/** Consume a nested map (indented `key: value` lines following `parent:`). */
function consumeMap(lines: string[], from: number): { map: FmEntry[]; next: number; hadSub: boolean } {
  const map: FmEntry[] = [];
  let i = from;
  let indent: number | null = null;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }
    const leading = line.length - line.trimStart().length;
    if (indent === null) {
      if (leading === 0) break; // no sub-entries at all
      indent = leading;
    } else if (leading < indent!) {
      break;
    }
    const sub = /^([A-Za-z0-9_]+)[ \t]*:(.*)$/.exec(line.trimStart());
    if (!sub) break;
    const subKey = sub[1]!;
    const subRest = sub[2]!.trim();
    if (subRest === "|") {
      const { block, next } = consumeBlock(lines, i + 1);
      map.push({ key: subKey, value: { kind: "block", text: block } });
      i = next;
    } else if (subRest.startsWith("[") && subRest.endsWith("]")) {
      map.push({ key: subKey, value: { kind: "flowArray", items: parseFlowArray(subRest) }, raw: subRest });
      i++;
    } else {
      map.push({ key: subKey, value: { kind: "scalar", text: unquote(subRest) }, raw: subRest });
      i++;
    }
  }
  return { map, next: i, hadSub: map.length > 0 || indent !== null };
}

/** Parse an inline flow array `[a, "b", c]` into string items (quote-aware: commas inside quotes are preserved). */
function parseFlowArray(text: string): string[] {
  const inner = text.slice(1, -1).trim();
  if (inner === "") return [];
  const items: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (inQuote) {
      current += ch;
      if (ch === inQuote && inner[i - 1] !== "\\") inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
    } else if (ch === ",") {
      const trimmed = current.trim();
      if (trimmed.length > 0) items.push(unquote(trimmed));
      current = "";
    } else {
      current += ch;
    }
  }
  const last = current.trim();
  if (last.length > 0) items.push(unquote(last));
  return items;
}

/** Strip surrounding single/double quotes from a scalar value. */
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

// ───────────────────────────────────────────────────────────────────────────
// Body section parsing
// ───────────────────────────────────────────────────────────────────────────

interface RawSection {
  heading: string;
  body: string;
}

/** Split the body into H1 sections. */
function parseBodySections(text: string): RawSection[] {
  const lines = text.split("\n");
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  for (const line of lines) {
    const h1 = /^#[ \t]+(.+?)\s*$/.exec(line);
    if (h1) {
      if (current) sections.push(current);
      current = { heading: h1[1]!.trim(), body: "" };
    } else if (current) {
      current.body += (current.body ? "\n" : "") + line;
    }
  }
  if (current) sections.push(current);
  return sections.map((s) => ({ heading: s.heading, body: s.body.replace(/^\n+|\n+$/g, "") }));
}

// ───────────────────────────────────────────────────────────────────────────
// Extraction (entries → VtfProfile + unknowns)
// ───────────────────────────────────────────────────────────────────────────

const KNOWN_TOP_KEYS = new Set([
  "name",
  "tags",
  "creator",
  "character_version",
  "creator_notes",
  "vt",
]);
const KNOWN_VT_KEYS = new Set([
  "mes_example_mode",
  "mes_example_depth",
]);

function extractProfileFromFrontmatter(entries: FmEntry[]): {
  profile: VtfProfile;
  unknownFrontmatter: FrontmatterEntry[];
  unknownVt: FrontmatterEntry[];
} {
  const profile: VtfProfile = {
    name: "",
    tags: [],
    creator: null,
    characterVersion: null,
    creatorNotes: null,
    mesExampleMode: DEFAULT_MES_EXAMPLE_MODE,
    mesExampleDepth: DEFAULT_DEPTH,
    description: "",
    scenario: null,
    mesExample: null,
  };
  const unknownFrontmatter: FrontmatterEntry[] = [];
  const unknownVt: FrontmatterEntry[] = [];

  for (const entry of entries) {
    switch (entry.key) {
      case "name":
        profile.name = scalar(entry.value);
        break;
      case "tags":
        profile.tags = flowArray(entry.value);
        break;
      case "creator":
        profile.creator = optionalScalar(entry.value);
        break;
      case "character_version":
        profile.characterVersion = optionalScalar(entry.value);
        break;
      case "creator_notes":
        profile.creatorNotes = optionalScalar(entry.value);
        break;
      case "vt":
        for (const sub of mapEntries(entry.value)) {
          switch (sub.key) {
            case "mes_example_mode":
              profile.mesExampleMode = scalar(sub.value);
              break;
            case "mes_example_depth":
              profile.mesExampleDepth = numberOr(sub.value, DEFAULT_DEPTH);
              break;
            default:
              unknownVt.push({ key: sub.key, value: sub.raw ?? scalar(sub.value), block: sub.value.kind === "block" });
          }
        }
        break;
      default:
        unknownFrontmatter.push(fmEntryToUnknown(entry));
    }
  }
  return { profile, unknownFrontmatter, unknownVt };
}

function extractProfileFromSections(sections: RawSection[]): {
  profile: Partial<Record<SectionField, string | null>>;
  unknownSections: BodySection[];
} {
  const profile: Partial<Record<SectionField, string | null>> = {};
  const unknownSections: BodySection[] = [];
  for (const section of sections) {
    const field = SECTION_TO_FIELD[section.heading];
    const body = section.body.trim();
    if (field) {
      // Empty section body = field absent (null). Non-empty = the field value.
      profile[field] = body.length > 0 ? body : field === "description" ? "" : null;
    } else {
      unknownSections.push({ heading: section.heading, body });
    }
  }
  return { profile, unknownSections };
}

// ───────────────────────────────────────────────────────────────────────────
// Serializer
// ───────────────────────────────────────────────────────────────────────────

/** Serialize {@link ProfileMd} into canonical `profile.md` text. */
export function serializeProfileMd(input: ProfileMd): string {
  const out: string[] = [];
  out.push(...serializeFrontmatter(input));
  out.push(...serializeBody(input));
  // Join with single newlines, ensure the document ends with exactly one newline.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "").trimEnd() + "\n";
}

function serializeFrontmatter(input: ProfileMd): string[] {
  const p = input.profile;
  const lines: string[] = ["---"];
  lines.push(`name: ${emitScalar(p.name)}`);
  if (p.tags.length > 0) lines.push(`tags: [${p.tags.map(emitFlowItem).join(", ")}]`);
  if (p.creator) lines.push(`creator: ${emitScalar(p.creator)}`);
  if (p.characterVersion) lines.push(`character_version: ${emitScalar(p.characterVersion)}`);
  if (p.creatorNotes) lines.push(...emitBlock("creator_notes", p.creatorNotes));

  // vt: block — known keys in canonical order, then unknown vt keys.
  const vtLines: string[] = [];
  vtLines.push(`  mes_example_mode: ${emitScalar(p.mesExampleMode)}`);
  vtLines.push(`  mes_example_depth: ${String(p.mesExampleDepth)}`);
  for (const u of input.unknownVt ?? []) {
    if (u.block) {
      vtLines.push(...emitBlock(u.key, u.value, 2));
    } else {
      // Emit verbatim (raw text) — unknown vt keys round-trip byte-faithfully.
      vtLines.push(`  ${u.key}: ${u.value}`);
    }
  }
  lines.push("vt:");
  lines.push(...vtLines);

  // Unknown top-level keys after the known ones.
  for (const u of input.unknownFrontmatter ?? []) {
    if (u.block) lines.push(...emitBlock(u.key, u.value));
    else lines.push(`${u.key}: ${u.value}`);
  }
  lines.push("---");
  return lines;
}

function serializeBody(input: ProfileMd): string[] {
  const p = input.profile;
  const lines: string[] = [];
  // PERSONALITY is ALWAYS emitted (required section — Threat 2 structural
  // pinning guarantee: a missing/renamed/broken heading must self-heal on
  // save). An empty body is emitted as a bare heading so round-trip of an
  // empty description stays lossless (`# PERSONALITY` with no body parses back
  // to empty `description`). SCENARIO/EXAMPLES are optional — omitted when empty.
  lines.push("");
  lines.push("# PERSONALITY");
  if (p.description.trim().length > 0) {
    lines.push(p.description.replace(/^\n+|\n+$/g, ""));
  }
  const optional: { heading: string; body: string | null }[] = [
    { heading: "SCENARIO", body: p.scenario },
    { heading: "EXAMPLES", body: p.mesExample },
  ];
  for (const section of optional) {
    if (section.body && section.body.trim().length > 0) {
      lines.push("");
      lines.push(`# ${section.heading}`);
      lines.push(section.body.replace(/^\n+|\n+$/g, ""));
    }
  }
  for (const u of input.unknownSections ?? []) {
    if (u.body.trim().length > 0 || u.heading.length > 0) {
      lines.push("");
      lines.push(`# ${u.heading}`);
      if (u.body.trim().length > 0) lines.push(u.body.replace(/^\n+|\n+$/g, ""));
    }
  }
  return lines;
}

// ───────────────────────────────────────────────────────────────────────────
// Emit helpers
// ───────────────────────────────────────────────────────────────────────────

/** True if a scalar value must be quoted in our canonical YAML dialect. */
function needsQuotes(text: string): boolean {
  if (text === "") return true;
  if (text !== text.trim()) return true; // leading/trailing whitespace
  if (/^["'#\[\]{}&*!|>'%@`,]/.test(text)) return true; // YAML indicator chars
  if (/\s#/.test(text)) return true; // inline comment
  if (/:\s/.test(text)) return true; // looks like a mapping
  if (/^(true|false|null|yes|no|~)$/i.test(text)) return true; // YAML booleans/null
  if (/^-?\d+(\.\d+)?$/.test(text)) return true; // looks like a number
  return false;
}

function emitScalar(text: string): string {
  if (!needsQuotes(text)) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function emitFlowItem(text: string): string {
  return needsQuotes(text) ? emitScalar(text) : text;
}

function emitBlock(key: string, content: string, indent = 0): string[] {
  const pad = " ".repeat(indent);
  const bodyIndent = " ".repeat(indent + 2);
  const contentLines = content.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "").split("\n");
  const lines = [`${pad}${key}: |`];
  for (const line of contentLines) {
    lines.push(line.trim() === "" ? "" : `${bodyIndent}${line}`);
  }
  return lines;
}

// ───────────────────────────────────────────────────────────────────────────
// Value accessors (parse-side)
// ───────────────────────────────────────────────────────────────────────────

function scalar(v: FmValue): string {
  return v.kind === "scalar" ? v.text : v.kind === "block" ? v.text : v.kind === "flowArray" ? v.items.join(", ") : "";
}

function optionalScalar(v: FmValue): string | null {
  const text = scalar(v).trim();
  return text.length > 0 ? text : null;
}

function flowArray(v: FmValue): string[] {
  return v.kind === "flowArray" ? v.items : v.kind === "scalar" || v.kind === "block" ? (v.text.trim() ? [v.text.trim()] : []) : [];
}

function numberOr(v: FmValue, fallback: number): number {
  if (v.kind === "scalar") {
    const n = Number(v.text);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function mapEntries(v: FmValue): FmEntry[] {
  return v.kind === "map" ? v.entries : [];
}

function fmEntryToUnknown(entry: FmEntry): FrontmatterEntry {
  if (entry.value.kind === "block") {
    return { key: entry.key, value: entry.value.text, block: true };
  }
  if (entry.value.kind === "map") {
    // Re-serialize a nested map compactly; rare for unknown top-level keys.
    const inner = entry.value.entries.map((e) => `${e.key}: ${scalar(e.value)}`).join(", ");
    return { key: entry.key, value: `{${inner}}`, block: false };
  }
  // scalar or flowArray: preserve the raw value text verbatim so unknown keys
  // round-trip byte-faithfully (a bare `7` stays `7`, not `"7"`).
  return { key: entry.key, value: entry.raw ?? scalar(entry.value), block: false };
}
