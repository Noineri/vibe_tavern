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
  * fork #1 of the RP chat feature family (rides the live-chat runtime — live-chat-orchestrator.ts).
 * Members: domain/chat/coauthor-prompt.ts, coauthor-tools.ts, domain/coauthor/* (lore/, macro-subset.ts, modules/), api/adapters/coauthor-skill-adapter.ts.
*/

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { parseProfileMd, serializeProfileMd, splitFrontmatter, type VtfProfile } from "@vibe-tavern/db";
import {
  coauthorSectionEditInputSchema,
  coauthorSectionWriteInputSchema,
  type CoauthorTarget,
  type CoauthorToolOutput,
} from "@vibe-tavern/api-contracts";
import { applyExactEditsToBody, log } from "@vibe-tavern/domain";
import { buildReadSkillFileTool } from "../coauthor/skills/skill-read-tool.js";
import { buildLoreTools, type LoreEntityLookup } from "../coauthor/lore/lore-tools.js";
import type { LoreDraftIdGen } from "../coauthor/lore/lore-draft-state.js";
import type { LoreDelegate } from "../coauthor/lore/lore-delegate.js";

// Re-export so existing import sites (chat-mode-strategy, lore-entity-lookup)
// keep resolving the seam type from this module after the lore tools moved
// to domain/coauthor/lore/lore-tools.ts.
export type { LoreEntityLookup };

/** CA-17/CANARY: structured log for every co-author tool call. Without this
 * there is NO observability on the co-author path — tool I/O, the lost-section
 * guard verdict, and the raw model input are invisible (errors feed back to the
 * model as tool-results via the stepCountIs loop and never reach the server
 * logger). Set LOG_LEVEL=debug to see the full proposed body. */
const logger = log.tag("coauthor.tool");

/** One-line structural snapshot of a proposed document (never logs full body at
 * info level — that is debug-only). Reports what the guard needs to reason about. */
function describeProfileInput(profileMd: string): string {
	const { frontmatterText, bodyText } = splitFrontmatter(profileMd);
	const headings = [...bodyText.matchAll(/^(#{1,6})[ \t]+(.+?)\s*$/gm)].map((m) => `${m[1]} ${m[2]}`);
	return `len=${profileMd.length} fm=${frontmatterText ? "yes" : "no"} bodyLen=${bodyText.trim().length} headings=[${headings.join(" | ")}]`;
}

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

/** A `VtfProfile` prose field owned by one of the three H1 sections. */
type SectionField = "description" | "scenario" | "mesExample";

/** Maps a known prose section name to the `VtfProfile` field it feeds. */
const SECTION_TO_PROFILE_FIELD: Readonly<Record<string, SectionField>> = {
  PERSONALITY: "description",
  SCENARIO: "scenario",
  EXAMPLES: "mesExample",
};

/** Inverse of {@link SECTION_TO_PROFILE_FIELD}: the H1 section name a field lives under. */
const PROFILE_FIELD_TO_SECTION = Object.fromEntries(
  Object.entries(SECTION_TO_PROFILE_FIELD).map(([section, field]) => [field, section]),
) as Readonly<Record<SectionField, string>>;

/** The whole-section write tool that populates each field (the edit_* tools' fallback). */
const PROFILE_FIELD_TO_WRITE_TOOL: Readonly<Record<SectionField, string>> = {
  description: "write_personality",
  scenario: "write_scenario",
  mesExample: "write_examples",
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

/**
 * Assign a mutated section body back onto a {@link VtfProfile} field in a
 * type-safe way (PERSONALITY is always a string; the optional sections fall back
 * to `null` when the body is emptied, matching canonical field shape). Branches
 * per field so the indexer never has to satisfy a union of field nullabilities.
 */
function setSectionField(profile: VtfProfile, field: SectionField, value: string): void {
  if (field === "description") {
    profile.description = value;
  } else if (field === "scenario") {
    profile.scenario = value.trim().length > 0 ? value : null;
  } else {
    profile.mesExample = value.trim().length > 0 ? value : null;
  }
}

// ─── Tool set ──────────────────────────────────────────────────────────────

/**
 * Build the co-author tool set. Pure — no I/O, no store access. Each tool
 * validates and echoes the proposal; the strategy passes this set to the
 * executor (tools propose; the Apply RPC is the sole write path).
 */
export function buildCoauthorTools(opts: { toolSet?: Record<string, boolean>; profileMd?: string; skillRoots?: readonly string[]; loreIdGen?: LoreDraftIdGen; loreDelegate?: LoreDelegate; loreEntityLookup?: LoreEntityLookup; contextSearchSession?: import("../context/context-search-service.js").ContextSearchSession } = {}): ToolSet {
  const { toolSet, skillRoots, loreDelegate, loreEntityLookup, contextSearchSession } = opts;

  // ── Turn-local composable profile state (CED-2) ───────────────────────────
  // Every successful profile mutation in one assembled turn — write_profile,
  // edit_personality/scenario/examples, write_personality/scenario/examples —
  // shares this single working profile and a single serialized, non-poisoning
  // queue. The working profile starts from the canonical storage profile.md
  // captured at turn start; each successful call advances it, so a later call
  // sees earlier mutations (composition). A rejected call cannot poison the
  // queue or corrupt the working profile — its change is discarded and the next
  // call proceeds against the last good state.
  let workingProfileMd: string | undefined = opts.profileMd;
  let profileMutationCount = 0;
  let turnChain: Promise<unknown> = Promise.resolve();

  /** Serialize a profile mutation onto the turn queue (non-poisoning). */
  function runQueued<T>(fn: () => Promise<T>): Promise<T> {
    // Neutralize any prior rejection so this call runs regardless; then run fn.
    const result = turnChain.catch(() => undefined).then(fn);
    // The tail chain for the NEXT call swallows this call's outcome, so a
    // rejection here never blocks a later queued call.
    turnChain = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Shared exact-edit path for edit_personality / edit_scenario / edit_examples. */
  async function runSectionExactEdit(
    field: SectionField,
    toolName: string,
    edits: ReadonlyArray<{ search: string; replace: string }>,
    summary: string,
  ): Promise<CoauthorToolOutput> {
    return runQueued(async () => {
      if (edits.length === 0) {
        throw new Error(`${toolName}: edits must not be empty`);
      }
      if (!workingProfileMd) {
        logger.warn("%s REJECTED missing profileMd context", toolName);
        throw new Error(`${toolName}: Internal error, missing canonical profile context`);
      }
      logger.info("%s IN edits=%d summary=%s", toolName, edits.length, summary);
      const parsed = parseProfileMd(workingProfileMd);
      const currentBody = parsed.profile[field] ?? "";
      // Models anchor `search` on the bare `# SECTION` heading they see in the
      // rendered profile.md; the edit applies to the body only, so that can
      // never match. Name the real fix instead of a generic "not found" — a
      // model left guessing falls back to a whole-profile write_profile.
      const section = PROFILE_FIELD_TO_SECTION[field];
      if (currentBody.trim().length === 0) {
        const writeTool = PROFILE_FIELD_TO_WRITE_TOOL[field];
        const hint = !toolSet || toolSet[writeTool] === true
          ? ` To populate it, call ${writeTool} with the full section content (no heading).`
          : "";
        logger.warn("%s REJECTED empty section %s", toolName, section);
        throw new Error(`${toolName}: the ${section} section is empty, so there is no text for search to match.${hint}`);
      }
      const headingLine = new RegExp(`^#[ \\t]+${section}[ \\t]*$`, "m");
      if (edits.some((e) => headingLine.test(e.search))) {
        logger.warn("%s REJECTED heading in search %s", toolName, section);
        throw new Error(
          `${toolName}: search includes the "# ${section}" heading, which is not part of the section body — edits apply to the body text only. Remove the heading from search and replace.`,
        );
      }
      const newBody = applyExactEditsToBody(currentBody, edits, toolName);
      setSectionField(parsed.profile, field, newBody);
      const merged = serializeProfileMd(parsed);
      const canonical = validateProfileMd(merged); // CA-17 guard + canonicalize
      workingProfileMd = canonical; // advance ONLY on success — atomic on failure
      profileMutationCount += 1;
      logger.info("%s OK canonical len=%d", toolName, canonical.length);
      return { target: "profile", proposed: canonical, summary };
    });
  }

  /** Shared whole-section write path for write_personality / write_scenario / write_examples. */
  async function runSectionWrite(
    field: SectionField,
    toolName: string,
    content: string,
    summary: string,
  ): Promise<CoauthorToolOutput> {
    return runQueued(async () => {
      if (!content.trim()) {
        logger.warn("%s REJECTED empty input", toolName);
        throw new Error(`${toolName}: content must not be empty`);
      }
      if (!workingProfileMd) {
        logger.warn("%s REJECTED missing profileMd context", toolName);
        throw new Error(`${toolName}: Internal error, missing canonical profile context`);
      }
      logger.info("%s IN len=%d summary=%s", toolName, content.length, summary);
      const parsed = parseProfileMd(workingProfileMd);
      setSectionField(parsed.profile, field, content);
      const merged = serializeProfileMd(parsed);
      const canonical = validateProfileMd(merged);
      workingProfileMd = canonical;
      profileMutationCount += 1;
      logger.info("%s OK canonical len=%d", toolName, canonical.length);
      return { target: "profile", proposed: canonical, summary };
    });
  }

  const allTools = {
    write_profile: tool({
      description:
        "Replace the ENTIRE profile document — the YAML frontmatter and all three H1 sections (PERSONALITY, SCENARIO, EXAMPLES) — with `profileMd`. " +
        "This is the whole-document write: use it for a ground-up rewrite, or a change that spans multiple sections and/or frontmatter at once. " +
        "Retain any section the user did NOT ask to change, verbatim. It must be the FIRST profile change in a turn — once a section edit/write has composed into the working profile, refine it with edit_*/write_* instead. " +
        "The proposed document is shown to the user as a diff before applying.",
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
      execute: async ({ profileMd, summary }): Promise<CoauthorToolOutput> =>
        runQueued(async () => {
          if (!profileMd.trim()) {
            logger.warn("write_profile REJECTED empty input summary=%s", summary);
            throw new Error("write_profile: profileMd must not be empty");
          }
          // write_profile is the explicit whole-document escape hatch: it may
          // run ONLY as the first profile mutation in the turn. Once any section
          // edit/write has composed into the working profile, a full rewrite
          // would silently erase that work — reject and steer the model to the
          // section tools. (A guard-thrown write_profile does NOT increment the
          // count, so a self-correct re-emit in the same turn is still allowed.)
          if (profileMutationCount > 0) {
            logger.warn("write_profile REJECTED late whole-profile rewrite after %d mutation(s)", profileMutationCount);
            throw new Error(
              "write_profile: a whole-profile rewrite can only be the FIRST profile change in a turn. " +
                "Earlier section edits already composed into the working profile; a full rewrite now would erase them. " +
                "Use edit_personality / edit_scenario / edit_examples (exact edits) or write_personality / write_scenario / write_examples (whole-section writes) to refine the composed result.",
            );
          }
          logger.info("write_profile IN %s summary=%s", describeProfileInput(profileMd), summary);
          logger.debug("write_profile RAW BODY:\n%s", splitFrontmatter(profileMd).bodyText);
          let canonical: string;
          try {
            canonical = validateProfileMd(profileMd);
          } catch (err) {
            // The lost-section guard throws to force a self-correct re-emit.
            const msg = (err as Error).message;
            const bodySnippet = splitFrontmatter(profileMd).bodyText.slice(0, 200);
            logger.warn("write_profile REJECTED guard-threw msg=%s bodySnippet=%j", msg, bodySnippet);
            throw err;
          }
          workingProfileMd = canonical;
          profileMutationCount += 1;
          logger.info("write_profile OK canonical len=%d", canonical.length);
          return { target: "profile", proposed: canonical, summary };
        }),
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
          logger.warn("edit_greeting REJECTED empty input index=%d", index);
          throw new Error("edit_greeting: content must not be empty");
        }
        logger.info("edit_greeting IN index=%d len=%d summary=%s", index, content.length, summary);
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
          logger.warn("add_alt_greeting REJECTED empty input");
          throw new Error("add_alt_greeting: content must not be empty");
        }
        logger.info("add_alt_greeting IN len=%d summary=%s", content.length, summary);
        return { target: "greeting", isAdd: true, proposed: content, summary };
      },
    }),

    edit_personality: tool({
      description:
        "Apply exact SEARCH/REPLACE edits to the PERSONALITY section body only. Each `search` must match exactly once in the current PERSONALITY text; use this for targeted changes to existing prose. The body excludes the `# PERSONALITY` heading — never put the heading in `search`; if PERSONALITY is empty, use write_personality instead. The other sections (SCENARIO, EXAMPLES) are preserved. Edits compose across calls within one turn.",
      inputSchema: coauthorSectionEditInputSchema,
      execute: async ({ edits, summary }): Promise<CoauthorToolOutput> =>
        runSectionExactEdit("description", "edit_personality", edits, summary),
    }),

    edit_scenario: tool({
      description:
        "Apply exact SEARCH/REPLACE edits to the SCENARIO section body only. Each `search` must match exactly once in the current SCENARIO text; use this for targeted changes. The body excludes the `# SCENARIO` heading — never put the heading in `search`; if SCENARIO is empty, use write_scenario instead. The other sections (PERSONALITY, EXAMPLES) are preserved. Edits compose across calls within one turn.",
      inputSchema: coauthorSectionEditInputSchema,
      execute: async ({ edits, summary }): Promise<CoauthorToolOutput> =>
        runSectionExactEdit("scenario", "edit_scenario", edits, summary),
    }),

    edit_examples: tool({
      description:
        "Apply exact SEARCH/REPLACE edits to the EXAMPLES section body (example dialogue) only. Each `search` must match exactly once in the current EXAMPLES text; use this for targeted changes. The body excludes the `# EXAMPLES` heading — never put the heading in `search`; if EXAMPLES is empty, use write_examples instead. The other sections (PERSONALITY, SCENARIO) are preserved. Edits compose across calls within one turn.",
      inputSchema: coauthorSectionEditInputSchema,
      execute: async ({ edits, summary }): Promise<CoauthorToolOutput> =>
        runSectionExactEdit("mesExample", "edit_examples", edits, summary),
    }),

    write_personality: tool({
      description:
        "Replace the ENTIRE PERSONALITY section body with `content`. Use this to populate an empty PERSONALITY or to intentionally rewrite the whole section; use edit_personality for targeted changes to existing prose. The other sections (SCENARIO, EXAMPLES) are preserved. Writes compose with other edits within one turn.",
      inputSchema: coauthorSectionWriteInputSchema,
      execute: async ({ content, summary }): Promise<CoauthorToolOutput> =>
        runSectionWrite("description", "write_personality", content, summary),
    }),

    write_scenario: tool({
      description:
        "Replace the ENTIRE SCENARIO section body with `content`. Use this to populate an empty SCENARIO or to intentionally rewrite the whole section; use edit_scenario for targeted changes. The other sections (PERSONALITY, EXAMPLES) are preserved. Writes compose with other edits within one turn.",
      inputSchema: coauthorSectionWriteInputSchema,
      execute: async ({ content, summary }): Promise<CoauthorToolOutput> =>
        runSectionWrite("scenario", "write_scenario", content, summary),
    }),

    write_examples: tool({
      description:
        "Replace the ENTIRE EXAMPLES section body (example dialogue) with `content`. Use this to populate empty EXAMPLES or to intentionally rewrite the whole section; use edit_examples for targeted changes. The other sections (PERSONALITY, SCENARIO) are preserved. Writes compose with other edits within one turn.",
      inputSchema: coauthorSectionWriteInputSchema,
      execute: async ({ content, summary }): Promise<CoauthorToolOutput> =>
        runSectionWrite("mesExample", "write_examples", content, summary),
    }),

    edit_alt_greeting: tool({
      description:
        "Propose a replacement for an EXISTING alternate greeting. index 1 is the first alternate greeting, index 2 is the second, etc.",
      inputSchema: z.object({
        index: z
          .number()
          .int()
          .min(1)
          .describe("The alternate greeting slot to replace (1+)."),
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
          logger.warn("edit_alt_greeting REJECTED empty input index=%d", index);
          throw new Error("edit_alt_greeting: content must not be empty");
        }
        logger.info("edit_alt_greeting IN index=%d len=%d summary=%s", index, content.length, summary);
        return { target: "greeting", greetingIndex: index, proposed: content, summary };
      },
    }),

    // ── Lore tools (CTX-L1 Wave 4 / CTX-L2b / CE-B1) ────────────────────────
    // The whole lore surface (create/edit/add tools + the two AI-delegation
    // tools) lives in domain/coauthor/lore/lore-tools.ts; the spread preserves
    // the pre-split tool order (profile/greeting → lore → context search) so
    // the serialized tool block stays byte-identical.
    ...buildLoreTools({ idGen: opts.loreIdGen, loreDelegate, loreEntityLookup, getWorkingProfileMd: () => workingProfileMd }),

    // ── CE-D2: indexed two-step context search ──────────────────────────────
    // search_context returns compact locator metadata only (no body);
    // read_context_item returns canonical full content for one chosen item.
    // Both are read-only and never mutate state. The session lazily projects
    // all canonical entities into FTS5 on its first search and memoizes the
    // immutable snapshot for the rest of the turn. Absent when stores are not
    // wired (test contexts); the tools then throw a clear error if invoked.
    search_context: tool({
      description:
        "Search the user's library by keyword (characters, personas, lorebooks, lore entries, scripts, AND Co-Author skills). " +
        "Returns compact locator metadata only (type, id, title, scope, meta, match kind) — no full content. " +
        "Use concise source-language keywords; retry with synonyms or translation if the first search misses. " +
        "When you know the item's title, pass it as the query — exact-title matches rank above content matches. " +
        "HOW TO READ RESULTS: for type 'character'/'persona'/'lorebook'/'lore-entry'/'script', call `read_context_item` to get full content. " +
        "For type 'skill' (a Co-Author workflow skill), DO NOT use read_context_item — instead call `read_skill_file` with the 'manifestPath' from the result's meta to load the skill's SKILL.md and follow its workflow.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Search keywords. Short, content-language, no operators needed."),
        types: z.array(z.enum(["character", "persona", "lorebook", "lore-entry", "script", "skill"]))
          .optional()
          .describe("Restrict results to these types. Omit to search all (entities + skills)."),
        scope: z.enum(["active_first", "library"])
          .optional()
          .describe("'active_first' (default) boosts the active character/persona and their bound resources. 'library' disables boosting. Skills are never boosted (library-wide)."),
      }),
      execute: async ({ query, types, scope }): Promise<{ results: import("../context/context-search-service.js").ContextSearchToolResult[] }> => {
        if (!contextSearchSession) {
          throw new Error("search_context: context search is not available in this session");
        }
        logger.info("search_context IN query=%s types=%s scope=%s", query, types?.join(",") ?? "(all)", scope ?? "active_first");
        const results = await contextSearchSession.search(query, {
          types,
          scopeMode: scope ?? "active_first",
        });
        logger.info("search_context OK results=%d", results.length);
        return { results };
      },
    }),

    read_context_item: tool({
      description:
        "Read the full canonical content of one ENTITY found via `search_context` " +
        "(character, persona, lorebook, lore-entry, or script). " +
        "Returns the entity's complete text (character profile, persona description, " +
        "lorebook metadata + enabled entries, lore entry content + keys, or script description + code). " +
        "Use this AFTER `search_context` identified the correct item. " +
        "Never call this without a prior search — the type and id come from search results. " +
        "NOTE: this tool does NOT read Co-Author skills (type 'skill') — load those via `read_skill_file` using the manifestPath from the search result.",
      inputSchema: z.object({
        type: z.enum(["character", "persona", "lorebook", "lore-entry", "script"])
          .describe("Entity type from a search_context result."),
        id: z.string().min(1)
          .describe("Entity id from a search_context result."),
      }),
      execute: async ({ type, id }): Promise<import("../context/context-search-service.js").ContextSearchReadResult> => {
        if (!contextSearchSession) {
          throw new Error("read_context_item: context search is not available in this session");
        }
        logger.info("read_context_item IN type=%s id=%s", type, id);
        const result = await contextSearchSession.read(type, id);
        logger.info("read_context_item OK type=%s id=%s contentLen=%d", type, id, result.content.length);
        return result;
      },
    }),
  };

  if (toolSet) {
    const filtered = Object.fromEntries(Object.entries(allTools).filter(([name]) => toolSet[name] === true)) as typeof allTools;
    // read_skill_file is always available in Co-Author mode: it is the universal,
    // read-only skill-access channel and is NOT gated by a module's toolSet
    // (which only scopes the mutating profile/greeting tools). Wave 2 (CTX-S4).
    return { ...filtered, read_skill_file: buildReadSkillFileTool(skillRoots ?? []) } as typeof allTools & { read_skill_file: ReturnType<typeof buildReadSkillFileTool> };
  }
  return { ...allTools, read_skill_file: buildReadSkillFileTool(skillRoots ?? []) } as typeof allTools & { read_skill_file: ReturnType<typeof buildReadSkillFileTool> };
}
