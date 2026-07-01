/**
 * Co-Author editor tools (CA-6).
 *
 * These tools are the AI's only channel for proposing card edits. They NEVER
 * write to `CharacterStore` — each `execute()` validates the proposal and
 * returns it as the proposed document; the frontend renders a diff
 * (canonical → proposed) and the user commits via the Apply RPC (CA-7).
 * This is the Google-Docs-Suggestions / pull-request pattern: the model
 * edits a working copy, the user merges.
 *
 * Returned shape (`CoauthorToolOutput`): `{ target, proposed, summary }`.
 * - `target` tells the frontend which surface to overlay the diff on.
 * - `proposed` is the proposed content (full document for the profile, a
 *   single greeting string for greeting tools).
 * - `summary` is a one-line "commit message" the model supplies, rendered
 *   above the Apply button so the user knows what the change does at a glance.
 *
 * The model may call several tools per turn; the AI SDK multi-step loop
 * (stopWhen: stepCountIs(maxSteps)) feeds results back so the model stays
 * coherent. See `CoauthorModeStrategy.assemble` for the prompt that governs
 * these calls (batching, retain-unchanged-sections, sequential-dependent-calls).
 */

import { tool } from "ai";
import { z } from "zod";
import { parseProfileMd, serializeProfileMd, splitFrontmatter } from "@vibe-tavern/db";
import type { CoauthorTarget, CoauthorToolOutput } from "@vibe-tavern/api-contracts";

// Re-export so existing internal import sites (strategy, tests) are unaffected.
export type { CoauthorTarget, CoauthorToolOutput };

// ─── Output contract ───────────────────────────────────────────────────────

// `CoauthorTarget` and `CoauthorToolOutput` are now defined in
// `@vibe-tavern/api-contracts` (the wire contract shared with the frontend —
// CA-9.2). See the import + re-export at the top of this file.

// ─── Validation helpers ────────────────────────────────────────────────────

/**
 * The canonical prose section headings the codec recognizes. These MUST be H1
 * (single `#`); {@link parseProfileMd}'s body parser only captures H1 lines, so
 * a heading at any other level is invisible to it (see {@link detectLostSections}).
 */
const KNOWN_PROSE_SECTIONS = ["PERSONALITY", "SCENARIO", "EXAMPLES"] as const;

/** Maps a known prose section name to the `VtfProfile` field it feeds. */
const SECTION_TO_PROFILE_FIELD: Readonly<Record<string, "description" | "scenario" | "mesExample">> = {
  PERSONALITY: "description",
  SCENARIO: "scenario",
  EXAMPLES: "mesExample",
};

/** A known section whose content would be silently dropped by canonicalization. */
interface LostSection {
  /** The heading exactly as the model wrote it, e.g. `## PERSONALITY`. */
  heading: string;
  /** Canonical section name (PERSONALITY/SCENARIO/EXAMPLES). */
  section: string;
  /** The non-empty body that would be lost. */
  body: string;
}

/**
 * Detect "silent content loss" in a proposed profile.md (CA-17).
 *
 * The canonical codec ({@link parseProfileMd}) recognizes ONLY H1 body headings
 * (`# PERSONALITY` / `# SCENARIO` / `# EXAMPLES`). When the model emits a known
 * section at the wrong level — most commonly `## PERSONALITY` instead of
 * `# PERSONALITY` — the heading is not recognized: its body is dropped to empty
 * and does NOT survive in `unknownSections` (only H1 lines are section candidates;
 * a non-H1 known heading under a leading position is dropped entirely, and under
 * a prior H1 it is misrouted into that section's body). The result: the canonical
 * field comes back EMPTY even though the model clearly authored content, and the
 * loss is silent — it happens INSIDE the tool, before the frontend diff (CA-11)
 * ever sees it, so the diff would show a deletion the model didn't intend and
 * Apply would commit an empty section.
 *
 * This scan is deliberately LOOSE: it captures atx headings at ANY level
 * (`#{1..6}`) over the raw post-frontmatter body, records the body that follows
 * each known-by-name section heading, and flags any whose raw body is non-empty
 * but whose canonical field (via {@link parseProfileMd}) came back empty/null.
 * Mechanism-agnostic — catches wrong-level headings and any future parser gap
 * that empties a section the model populated.
 *
 * Returns the lost sections (empty if the proposal is safe to canonicalize).
 */
function detectLostSections(profileMd: string): LostSection[] {
  const { bodyText } = splitFrontmatter(profileMd);

  // Loose atx-heading scan: group the body under each heading until the next.
  // `seen` keeps the LAST occurrence per known section name (later wins, matching
  // how a reader/model would resolve duplicates).
  const seen = new Map<string, LostSection>();
  let current: { level: string; name: string; body: string } | null = null;
  const flush = () => {
    if (!current) return;
    const upper = current.name.toUpperCase();
    if ((KNOWN_PROSE_SECTIONS as readonly string[]).includes(upper) && current.body.trim().length > 0) {
      seen.set(upper, { heading: `${current.level} ${current.name}`, section: upper, body: current.body });
    }
    current = null;
  };
  for (const line of bodyText.split("\n")) {
    const m = /^(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      current = { level: m[1]!, name: m[2]!.trim(), body: "" };
    } else if (current) {
      current.body += (current.body ? "\n" : "") + line;
    }
  }
  flush();
  if (seen.size === 0) return [];

  // Compare each populated raw known-section against its canonical field. A
  // non-empty raw body whose canonical field is empty/null is silent loss.
  const canonical = parseProfileMd(profileMd).profile;
  const lost: LostSection[] = [];
  for (const [name, info] of seen) {
    const field = SECTION_TO_PROFILE_FIELD[name];
    if (field && (canonical[field] ?? "").trim().length === 0) lost.push(info);
  }
  return lost;
}

/**
 * Round-trip a proposed profile.md through the canonical codec to normalize
 * whitespace/heading drift so the diff the user sees is against canonical
 * text, not the model's raw emission. NOTE: parseProfileMd/serializeProfileMd
 * are TOTAL (they never throw — unknown frontmatter and missing sections pass
 * through). Canonicalization is therefore gated (not by the codec, but here):
 * (1) the empty-input guard in each tool's execute(), and (2) the lost-section
 * guard below ({@link detectLostSections}), which refuses to canonicalize a
 * document whose known section content would be silently dropped — returning a
 * tool-error so the model re-emits with correct H1 headings in the same turn.
 */
function validateProfileMd(profileMd: string): string {
  const lost = detectLostSections(profileMd);
  if (lost.length > 0) {
    const detail = lost
      .map((l) => {
        const snippet = l.body.trim().slice(0, 80);
        const ell = l.body.trim().length > 80 ? "\u2026" : "";
        return `\"${l.heading}\" (${l.section}; body starts: ${JSON.stringify(snippet)}${ell})`;
      })
      .join("; ");
    throw new Error(
      `edit_profile: proposed document has a known section heading at the wrong level — ${detail}. ` +
        `The canonical profile codec only recognizes H1 headings (# PERSONALITY / # SCENARIO / # EXAMPLES); a heading at any other level is not recognized and its body would be SILENTLY DROPPED during canonicalization (it is not preserved as an unknown section). ` +
        `Re-emit the full document using single-hash H1 headings so all section content survives.`,
    );
  }
  const parsed = parseProfileMd(profileMd);
  return serializeProfileMd(parsed);
}

// ─── Tool set ──────────────────────────────────────────────────────────────

/**
 * Build the co-author tool set. Pure — no I/O, no store access. Each tool
 * validates and echoes the proposal; the strategy passes this set to the
 * executor (tools propose; the Apply RPC is the sole write path).
 */
export function buildCoauthorTools() {
  return {
    edit_profile: tool({
      description:
        "Propose a full rewrite of the character's profile.md (YAML frontmatter + the three H1 sections: PERSONALITY, SCENARIO, EXAMPLES). " +
        "Retain any section the user did NOT ask to change, verbatim. The proposed document is shown to the user as a diff before applying.",
      inputSchema: z.object({
        profileMd: z
          .string()
          .describe(
            "The FULL proposed profile.md text, including the YAML frontmatter delimiter (---) and all three H1 sections. Copy unchanged sections verbatim from the current document.",
          ),
        summary: z
          .string()
          .max(200)
          .describe("One-line description of what this edit changes, shown above the Apply button. e.g. 'Made the personality more assertive.'"),
      }),
      execute: async ({ profileMd, summary }): Promise<CoauthorToolOutput> => {
        if (!profileMd.trim()) {
          throw new Error("edit_profile: profileMd must not be empty");
        }
        const canonical = validateProfileMd(profileMd);
        return { target: "profile", proposed: canonical, summary };
      },
    }),

    edit_greeting: tool({
      description:
        "Propose a replacement for an EXISTING greeting slot. index 0 is the primary greeting (firstMessage); index 1+ are alternate greetings in order. " +
        "Use add_alt_greeting to create a new slot rather than editing a non-existent index. If editing multiple greetings that depend on each other, call them sequentially so each proposal reflects the prior.",
      inputSchema: z.object({
        index: z
          .number()
          .int()
          .min(0)
          .describe("The greeting slot to replace: 0 = primary greeting (firstMessage), 1+ = the Nth alternate greeting."),
        content: z
          .string()
          .describe("The full proposed greeting text for this slot."),
        summary: z
          .string()
          .max(200)
          .describe("One-line description of what this greeting change does, shown above the Apply button."),
      }),
      execute: async ({ index, content, summary }): Promise<CoauthorToolOutput> => {
        if (!content.trim()) {
          throw new Error("edit_greeting: content must not be empty");
        }
        return { target: "greeting", greetingIndex: index, proposed: content, summary };
      },
    }),

    add_alt_greeting: tool({
      description:
        "Propose ADDING a new alternate greeting (appended after the existing alternates). Use this for new opening scenarios; use edit_greeting to revise an existing slot.",
      inputSchema: z.object({
        content: z
          .string()
          .describe("The full text of the new alternate greeting to add."),
        summary: z
          .string()
          .max(200)
          .describe("One-line description of the new greeting, shown above the Apply button."),
      }),
      execute: async ({ content, summary }): Promise<CoauthorToolOutput> => {
        if (!content.trim()) {
          throw new Error("add_alt_greeting: content must not be empty");
        }
        return { target: "greeting", isAdd: true, proposed: content, summary };
      },
    }),
  };
}

/**
 * Max tool-calling rounds per Co-Author turn (consensus maxSteps from the
 * CA-6 design review). Hardcoded for V1 — made user-tunable in CA-16, where the
 * storage decision (global `uiSettings.coauthorMaxSteps` vs per-chat
 * `coauthor_config_json`) is taken once the Wave-3 UI is visible. See
 * VTF_COAUTHOR_PLAN.md → `CA-16_configurable_max_steps`.
 */
export const COAUTHOR_MAX_STEPS = 5;
