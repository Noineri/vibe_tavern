/**
 * Vibe MD — bidirectional sync core (storage ↔ editor prose fields).
 *
 * The bridge between the CodeMirror MD body (what the user authors as one
 * contiguous prose document) and the prose+greetings fields of a
 * {@link BuildCharacterDraft}. The MD area shows ONLY the body — no frontmatter
 * (edited via the shared top block form fields). It owns FIVE draft fields,
 * surfaced as FOUR locked H1 sections:
 *  - `# PERSONALITY` → `description`
 *  - `# SCENARIO` → `scenario`
 *  - `# EXAMPLES` → `mesExample`
 *  - `# GREETINGS` → `firstMessage` + `alternateGreetings` (a SYNTHESIZED view of
 *    the `greetings/` folder, built via the inline marker codec — greetings are
 *    NOT part of `profile.md` storage; this section is split off before the
 *    profile-md codec ever runs).
 * Instructions (`systemPrompt` / `postHistoryInstructions` / `depthPrompt*`)
 * and metadata (`creatorNotes` / `personalitySummary`) live on the draft as
 * plain fields edited in the "Advanced fields" accordion, so they are
 * intentionally NOT round-tripped through this module.
 *
 * **Structural pinning (Threat 2 — load-bearing data guarantee).**
 * `applyBodyToDraft` parses the MD body through the canonical `profile.md`
 * codec (`parseProfileMd`) and extracts the known H1 sections into the prose
 * fields. Whatever broke a heading — a malformed LLM Co-Author return, a
 * hand-edited import, a stale draft — the canonical heading set self-heals on
 * the next {@link draftToBody} emission: `serializeProfileMd` ALWAYS emits
 * `# PERSONALITY` (required; the VTF-1 codec was amended in VTF-12 for exactly
 * this guarantee) and emits `# SCENARIO` / `# EXAMPLES` when their fields are
 * non-empty; `# GREETINGS` is ALWAYS appended (like PERSONALITY). A malformed
 * heading (`## PERSONALITY`, `# Personality`, a deleted heading line) is NOT
 * recognized as a known section by the parser, so it does not populate the
 * prose field; on re-emission the canonical heading is restored in fixed order.
 * Headings are immortal at the data level.
 *
 * This is the COMPLEMENT to `vibe-md-locked-headings.ts` (VTF-11): the
 * `changeFilter` is a UX guardrail against accidental user typing; THIS module
 * is the data guarantee against ANY write source. Do not rely on the filter
 * alone — a wholesale programmatic document replace (LLM Co-Author Apply,
 * import) is not blocked by it.
 *
 * Scope (VTF-12): PURE functions only — no CodeMirror, no React, no debounce.
 * Debounced dispatch + caret-position preservation on round-trip is wired in
 * the VibeMdView component (VTF-13), which composes these functions.
 */

import type { BuildCharacterDraft } from "@vibe-tavern/api-contracts";
import {
  parseProfileMd,
  compileGreetingsInline,
  splitGreetingsInline,
  greetingsFromCharacter,
  characterFromGreetings,
} from "@vibe-tavern/db";

// ───────────────────────────────────────────────────────────────────────────
// Editor → storage prose fields (with structural pinning)
// ───────────────────────────────────────────────────────────────────────────

/** The heading text for the greetings section appended to the editor body. */
const GREETINGS_HEADING = "# GREETINGS";
/** Matches the `# GREETINGS` H1 line (own line) to split the editor body. */
const GREETINGS_HEADING_RE = /^#[ \t]+GREETINGS[ \t]*$/m;

/** The three prose fields sourced from the MD body, extracted by pinning. */
export interface PinnedProseFields {
  /** `# PERSONALITY` body → `description` (required; always defined, possibly empty). */
  description: string;
  /** `# SCENARIO` body → `scenario` (empty string when the section is absent/empty). */
  scenario: string;
  /** `# EXAMPLES` body → `mesExample` (empty string when the section is absent/empty). */
  mesExample: string;
}

/**
 * Split an editor body into its prose part (PERSONALITY/SCENARIO/EXAMPLES) and
 * its greetings part (the `# GREETINGS` section body). The greetings section is
 * a SYNTHESIZED 4th section that lives only in the editor view — greetings are
 * NOT part of `profile.md` storage (they live in the `greetings/` folder), so
 * this split keeps `parseProfileMd` from ever seeing a GREETINGS heading.
 * Returns an empty greetings part when the heading is absent (tolerant).
 */
function splitGreetingsSection(body: string): { prose: string; greetings: string } {
  const m = body.match(GREETINGS_HEADING_RE);
  if (!m || m.index === undefined) return { prose: body, greetings: "" };
  const prose = body.slice(0, m.index).replace(/\n+$/, "");
  const greetings = body.slice(m.index + m[0].length).replace(/^\n+/, "");
  return { prose, greetings };
}

/**
 * Parse an MD body and extract the prose fields via the canonical codec
 * (Threat 2 structural pinning). Never throws — malformed MD yields empty
 * fields (the canonical heading is restored on the next {@link draftToBody}).
 *
 * The body is wrapped in a throwaway frontmatter block because `parseProfileMd`
 * expects a full document; the frontmatter content is irrelevant (only the body
 * sections are read). The `# GREETINGS` section is split off FIRST so the
 * profile-md codec never sees it.
 */
export function pinBodyFields(body: string): PinnedProseFields {
  const { prose } = splitGreetingsSection(body);
  const parsed = parseProfileMd(`---\nname: _pin\n---\n\n${prose}`);
  return {
    description: parsed.profile.description,
    scenario: parsed.profile.scenario ?? "",
    mesExample: parsed.profile.mesExample ?? "",
  };
}

/**
 * Parse the `# GREETINGS` section of an editor body into the primary greeting +
 * alternates via the inline-marker codec. Returns `{ firstMessage: "",
 * alternateGreetings: [] }` when the section is absent/empty (never throws).
 */
export function pinGreetingsFields(body: string): { firstMessage: string; alternateGreetings: string[] } {
  const { greetings } = splitGreetingsSection(body);
  if (!greetings.trim()) return { firstMessage: "", alternateGreetings: [] };
  return characterFromGreetings(splitGreetingsInline(greetings));
}

/**
 * Apply an MD body to a draft, returning a new draft with the prose fields AND
 * the greetings fields updated through structural pinning. All other draft
 * fields (name, tags, instructions, metadata) are preserved unchanged — the MD
 * area owns ONLY the prose body and the greetings section.
 */
export function applyBodyToDraft(body: string, draft: BuildCharacterDraft): BuildCharacterDraft {
  const fields = pinBodyFields(body);
  const greetings = pinGreetingsFields(body);
  return {
    ...draft,
    description: fields.description,
    scenario: fields.scenario,
    mesExample: fields.mesExample,
    firstMessage: greetings.firstMessage,
    alternateGreetings: greetings.alternateGreetings,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Storage prose fields → editor MD body (canonical emission)
// ───────────────────────────────────────────────────────────────────────────

/** Matches an `=== ALT [N] ===` greeting marker line (own line). */
const GREETINGS_ALT_RE = /^[=\-]{3}\s*(?:alt|ALT)(?:\s+\d+)?\s*[=\-]{3}\s*$/;

/** The canonical H1 headings of the editor body, in fixed order. */
export const EDITOR_HEADINGS = ["PERSONALITY", "SCENARIO", "EXAMPLES", "GREETINGS"] as const;

/** Emit one section as `# HEADING\n<body>` with a trimmed body. */
function emitSection(heading: string, body: string): string {
  const trimmed = (body ?? "").replace(/^\n+|\n+$/g, "");
  return `# ${heading}\n${trimmed}`;
}

/**
 * Emit the canonical editor MD body for a draft. The body carries the FOUR H1
 * sections as a STABLE SKELETON — PERSONALITY / SCENARIO / EXAMPLES / GREETINGS
 * are ALWAYS emitted (even when empty), so the user always sees four locked
 * headings. This is an editor-only concern: STORAGE (`profile.md` via the db
 * codec) still omits empty SCENARIO/EXAMPLES; only the editor view pads them.
 * `parseProfileMd` is tolerant of empty sections (parses to null → empty field),
 * so the round-trip `draftToBody → applyBodyToDraft → draftToBody` is stable.
 *
 * `# GREETINGS` is built from `firstMessage` + `alternateGreetings` via the
 * inline marker codec; it is a VIEW of the `greetings/` folder, not storage.
 */
export function draftToBody(draft: BuildCharacterDraft): string {
  const sections = [
    emitSection("PERSONALITY", draft.description),
    emitSection("SCENARIO", draft.scenario || ""),
    emitSection("EXAMPLES", draft.mesExample || ""),
  ];
  const greetingsInline = compileGreetingsInline(
    greetingsFromCharacter(draft.firstMessage ?? "", draft.alternateGreetings ?? []),
  );
  sections.push(emitSection("GREETINGS", greetingsInline));
  return (
    sections
      .join("\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+$/gm, "")
      .trimEnd() + "\n"
  );
}

/**
 * Count the `=== ALT N ===` markers BEFORE a given offset, returning the
 * 0-based alternate index of the marker at `markerOffset` (or -1 if the offset
 * is not on a marker line). Used by the editor's remove-greeting widget to map
 * a clicked marker to the `alternateGreetings[]` slot it deletes.
 */
export function altIndexAt(body: string, markerOffset: number): number {
  const lineEnd = body.indexOf("\n", markerOffset);
  const lineText = body.slice(markerOffset, lineEnd === -1 ? body.length : lineEnd);
  if (!GREETINGS_ALT_RE.test(lineText.trim())) return -1;
  // Count markers strictly BEFORE this one (loop breaks AT markerOffset, before
  // incrementing for the current marker) — that count IS the 0-based index.
  let index = 0;
  let pos = 0;
  for (const line of body.split("\n")) {
    if (pos >= markerOffset) break;
    if (GREETINGS_ALT_RE.test(line.trim())) index++;
    pos += line.length + 1;
  }
  return index;
}

// ───────────────────────────────────────────────────────────────────────────
// Round-trip identity check (used by VTF-13's debounce to skip no-op writes)
// ───────────────────────────────────────────────────────────────────────────

/**
 * True when `body` is already the canonical emission of `draft`'s prose fields.
 * VTF-13 uses this to avoid a dispatch→pin→dispatch loop: if the pinned body
 * equals what the editor already shows, there is nothing to write back.
 */
export function bodyIsCanonical(body: string, draft: BuildCharacterDraft): boolean {
  return draftToBody(applyBodyToDraft(body, draft)) === body;
}

// ───────────────────────────────────────────────────────────────────────────
// Internals
// ───────────────────────────────────────────────────────────────────────────

// (No internals — `draftToBody` builds the body directly, no frontmatter stripping needed.)
