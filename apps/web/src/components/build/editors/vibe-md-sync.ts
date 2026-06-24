/**
 * Vibe MD — bidirectional sync core (storage ↔ editor prose fields).
 *
 * The bridge between the CodeMirror MD body (what the user authors as one
 * contiguous prose document) and the prose fields of a {@link BuildCharacterDraft}
 * (`description` / `scenario` / `mesExample`). The MD area shows ONLY the body
 * — no frontmatter (edited via the Metadata accordion form fields in VTF-13);
 * instructions (`systemPrompt` / `postHistoryInstructions` / `depthPrompt*`)
 * and greetings (`firstMessage` / `alternateGreetings`) already live on the
 * draft as plain fields and are persisted server-side by the character store,
 * so they are intentionally NOT round-tripped through this module.
 *
 * **Structural pinning (Threat 2 — load-bearing data guarantee).**
 * `applyBodyToDraft` parses the MD body through the canonical `profile.md`
 * codec (`parseProfileMd`) and extracts the known H1 sections into the prose
 * fields. Whatever broke a heading — a malformed LLM Co-Author return, a
 * hand-edited import, a stale draft — the canonical heading set self-heals on
 * the next {@link draftToBody} emission: `serializeProfileMd` ALWAYS emits
 * `# PERSONALITY` (required; the VTF-1 codec was amended in VTF-12 for exactly
 * this guarantee) and emits `# SCENARIO` / `# EXAMPLES` when their fields are
 * non-empty. A malformed heading (`## PERSONALITY`, `# Personality`, a deleted
 * heading line) is NOT recognized as a known section by the parser, so it does
 * not populate the prose field; on re-emission the canonical heading is
 * restored in fixed order. Headings are immortal at the data level.
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
import { parseProfileMd, serializeProfileMd, type VtfProfile } from "@vibe-tavern/db";

// ───────────────────────────────────────────────────────────────────────────
// Editor → storage prose fields (with structural pinning)
// ───────────────────────────────────────────────────────────────────────────

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
 * Parse an MD body and extract the prose fields via the canonical codec
 * (Threat 2 structural pinning). Never throws — malformed MD yields empty
 * fields (the canonical heading is restored on the next {@link draftToBody}).
 *
 * The body is wrapped in a throwaway frontmatter block because `parseProfileMd`
 * expects a full document; the frontmatter content is irrelevant (only the body
 * sections are read).
 */
export function pinBodyFields(body: string): PinnedProseFields {
  const parsed = parseProfileMd(`---\nname: _pin\n---\n\n${body}`);
  return {
    description: parsed.profile.description,
    scenario: parsed.profile.scenario ?? "",
    mesExample: parsed.profile.mesExample ?? "",
  };
}

/**
 * Apply an MD body to a draft, returning a new draft with the prose fields
 * updated through structural pinning. All other draft fields (name, tags,
 * instructions, greetings, metadata) are preserved unchanged — the MD area
 * owns ONLY the prose body.
 */
export function applyBodyToDraft(body: string, draft: BuildCharacterDraft): BuildCharacterDraft {
  const fields = pinBodyFields(body);
  return {
    ...draft,
    description: fields.description,
    scenario: fields.scenario,
    mesExample: fields.mesExample,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Storage prose fields → editor MD body (canonical emission)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Emit the canonical MD body for a draft's prose fields. The body carries ONLY
 * the H1 prose sections — `# PERSONALITY` (always, even when empty — the
 * Threat 2 guarantee), `# SCENARIO` / `# EXAMPLES` when non-empty — in fixed
 * order, with no frontmatter (frontmatter is edited via the Metadata accordion
 * and re-glued server-side on save).
 */
export function draftToBody(draft: BuildCharacterDraft): string {
  const profile: VtfProfile = {
    name: draft.name,
    // Frontmatter-only fields are absent from the body; placeholders keep the
    // codec happy (they are stripped by stripFrontmatter and never reach the editor).
    tags: [],
    creator: null,
    characterVersion: null,
    creatorNotes: null,
    mesExampleMode: draft.mesExampleMode,
    mesExampleDepth: draft.mesExampleDepth,
    description: draft.description,
    scenario: draft.scenario || null,
    mesExample: draft.mesExample || null,
  };
  const fullMd = serializeProfileMd({ profile });
  return stripFrontmatter(fullMd);
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

/** Strip the leading `---\n...\n---\n` frontmatter block, returning the body. */
function stripFrontmatter(md: string): string {
  const match = md.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1]!.replace(/^\n+/, "") : md;
}
