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
import { parseProfileMd, serializeProfileMd, splitFrontmatter, type VtfProfile } from "@vibe-tavern/db";
import {
  coauthorSectionEditInputSchema,
  coauthorSectionWriteInputSchema,
  type CoauthorLoreBundleOutput,
  type CoauthorTarget,
  type CoauthorToolOutput,
} from "@vibe-tavern/api-contracts";
import { log } from "@vibe-tavern/domain";
import { buildReadSkillFileTool } from "../coauthor/skills/skill-read-tool.js";
import {
  defaultLoreDraftIdGen,
  LoreDraftState,
  type LoreDraftIdGen,
  type LoreDraftScopeType,
} from "../coauthor/lore/lore-draft-state.js";
import type { LoreDelegate, LoreDelegateInput } from "../coauthor/lore/lore-delegate.js";

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

/** Count non-overlapping literal occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/**
 * Apply an ordered batch of exact SEARCH/REPLACE edits to a single section body
 * (pure). Each `search` must be non-empty, differ from `replace`, and match
 * EXACTLY ONCE in the CURRENT (already-mutated-by-prior-items-in-this-batch)
 * body. Matching is literal — case-sensitive, no regex, no `$` substitution —
 * implemented via indexOf+slice so replacement text is never reinterpreted. A
 * failed item throws and the caller discards the partial result, so a batch
 * commits atomically (all-or-nothing).
 */
function applyExactEditsToBody(
  body: string,
  edits: ReadonlyArray<{ search: string; replace: string }>,
  toolName: string,
): string {
  let result = body;
  for (const { search, replace } of edits) {
    if (!search) {
      throw new Error(`${toolName}: edit.search must not be empty`);
    }
    if (search === replace) {
      throw new Error(`${toolName}: edit is a no-op (search === replace): ${JSON.stringify(search.slice(0, 80))}`);
    }
    const count = countOccurrences(result, search);
    if (count === 0) {
      throw new Error(
        `${toolName}: edit.search not found in the current section body: ${JSON.stringify(search.slice(0, 80))}`,
      );
    }
    if (count > 1) {
      throw new Error(
        `${toolName}: edit.search is ambiguous (${count} matches) — add more surrounding context so it matches once: ${JSON.stringify(search.slice(0, 80))}`,
      );
    }
    const idx = result.indexOf(search);
    result = result.slice(0, idx) + replace + result.slice(idx + search.length);
  }
  return result;
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
export function buildCoauthorTools(opts: { toolSet?: Record<string, boolean>; profileMd?: string; skillRoots?: readonly string[]; loreIdGen?: LoreDraftIdGen; loreDelegate?: LoreDelegate } = {}) {
  const { toolSet, skillRoots, loreDelegate } = opts;

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

  // ── Turn-local lore draft state (CTX-L1, Wave 4) ──────────────────────────
  // Proposal-only: allocates stable draft IDs and mutates closure state only —
  // NO LorebookStore, NO SQLite. Apply (CTEX-L2) is the sole persistence
  // boundary; Cancel drops this instance. The engine self-serializes its own
  // mutations through a separate non-poisoning queue (independent of the
  // profile queue), validates parent lorebook refs, and returns the complete
  // cumulative bundle from every successful call.
  const loreDraft = new LoreDraftState({ idGen: opts.loreIdGen ?? defaultLoreDraftIdGen() });

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

  /** Gather the delegation context for a drafted entry (entry + parent lorebook). */
  function buildLoreDelegateInput(
    kind: "write_entry" | "generate_keys",
    entryId: string,
    instruction: string,
    toolName: string,
  ): LoreDelegateInput {
    const snap = loreDraft.snapshot();
    const entry = snap.entries.find((e) => e.id === entryId);
    if (!entry) {
      throw new Error(`${toolName}: entry '${entryId}' does not exist in the draft`);
    }
    const lorebook = snap.lorebooks.find((lb) => lb.id === entry.lorebookId);
    return {
      kind,
      characterProfileMd: workingProfileMd ?? "",
      lorebookName: lorebook?.name ?? "",
      lorebookDescription: lorebook?.description ?? "",
      entryId: entry.id,
      entryTitle: entry.title,
      entryContent: entry.content,
      entryKeys: entry.keys,
      entrySecondaryKeys: entry.secondaryKeys,
      instruction,
    };
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
        "Apply exact SEARCH/REPLACE edits to the PERSONALITY section body only. Each `search` must match exactly once in the current PERSONALITY text; use this for targeted changes to existing prose. The other sections (SCENARIO, EXAMPLES) are preserved. Edits compose across calls within one turn.",
      inputSchema: coauthorSectionEditInputSchema,
      execute: async ({ edits, summary }): Promise<CoauthorToolOutput> =>
        runSectionExactEdit("description", "edit_personality", edits, summary),
    }),

    edit_scenario: tool({
      description:
        "Apply exact SEARCH/REPLACE edits to the SCENARIO section body only. Each `search` must match exactly once in the current SCENARIO text; use this for targeted changes. The other sections (PERSONALITY, EXAMPLES) are preserved. Edits compose across calls within one turn.",
      inputSchema: coauthorSectionEditInputSchema,
      execute: async ({ edits, summary }): Promise<CoauthorToolOutput> =>
        runSectionExactEdit("scenario", "edit_scenario", edits, summary),
    }),

    edit_examples: tool({
      description:
        "Apply exact SEARCH/REPLACE edits to the EXAMPLES section body (example dialogue) only. Each `search` must match exactly once in the current EXAMPLES text; use this for targeted changes. The other sections (PERSONALITY, SCENARIO) are preserved. Edits compose across calls within one turn.",
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

    // ── Wave 4: proposal-only lore tools (CTX-L1) ────────────────────────────
    // These allocate stable draft IDs and mutate ONLY the turn-local
    // LoreDraftState; they never touch LorebookStore / SQLite. Each returns the
    // complete cumulative lore bundle so aggregation keeps the whole graph. The
    // AI-delegation tools (ai_write_lore_entry / ai_generate_lore_keys) land in
    // CTX-L2 alongside the Apply transaction.
    create_lorebook: tool({
      description:
        "Propose creating a NEW lorebook (world-info book) for the character. Returns the complete cumulative lore draft (all books + entries proposed this turn). The book is shown for review before applying — nothing is persisted until Apply.",
      inputSchema: z.object({
        name: z.string().describe("The lorebook's display name, e.g. 'World Lore' or 'Castle Anvil'."),
        description: z.string().optional().describe("A short description of what this lorebook covers."),
        scopeType: z
          .enum(["global", "character", "persona", "chat"])
          .optional()
          .describe("Where this lorebook is scoped. 'character' (default) attaches it to the current character."),
        enabled: z.boolean().optional().describe("Whether the lorebook is active. Defaults to true."),
        summary: z.string().max(200).describe("One-line description of this lorebook, shown above the Apply button."),
      }),
      execute: async ({ name, description, scopeType, enabled, summary }): Promise<CoauthorLoreBundleOutput> => {
        logger.info("create_lorebook IN name=%j scopeType=%s summary=%s", name, scopeType ?? "(default)", summary);
        const bundle = await loreDraft.createLorebook({ name, description, scopeType: scopeType as LoreDraftScopeType | undefined, enabled });
        return { target: "lore_bundle", bundle, summary };
      },
    }),

    create_lore_entry: tool({
      description:
        "Propose adding a NEW entry to a lorebook drafted this turn. `lorebookId` MUST be the id of a lorebook returned by an earlier create_lorebook in this turn. Returns the complete cumulative lore draft. The entry is shown for review (with its keys, content, and activation) before applying.",
      inputSchema: z.object({
        lorebookId: z.string().describe("The id of the parent lorebook (from a create_lorebook result this turn)."),
        title: z.string().optional().describe("A short title for the entry (organizational; not an activation trigger)."),
        content: z.string().optional().describe("The lore content injected when this entry activates."),
        keys: z.array(z.string()).optional().describe("Activation trigger keywords. The entry activates when any key matches the recent context."),
        constant: z.boolean().optional().describe("If true the entry activates every turn regardless of key match. Defaults to false."),
        position: z.string().optional().describe("Where the entry injects (e.g. 'before_char'). Defaults to 'before_char'."),
        depth: z.number().int().optional().describe("Injection depth for depth-aware positions. Defaults to 4."),
        summary: z.string().max(200).describe("One-line description of this entry, shown above the Apply button."),
      }),
      execute: async ({ lorebookId, title, content, keys, constant, position, depth, summary }): Promise<CoauthorLoreBundleOutput> => {
        logger.info("create_lore_entry IN lorebookId=%s title=%j keys=%d summary=%s", lorebookId, title, keys?.length ?? 0, summary);
        const bundle = await loreDraft.createLoreEntry({ lorebookId, title, content, keys, constant, position, depth });
        return { target: "lore_bundle", bundle, summary };
      },
    }),

    set_lore_activation: tool({
      description:
        "Adjust activation fields on a lore entry drafted this turn (e.g. make it constant so it always injects, or disable it). `entryId` MUST be the id of an entry returned earlier this turn. Returns the complete cumulative lore draft.",
      inputSchema: z.object({
        entryId: z.string().describe("The id of the entry to adjust (from an earlier create_lore_entry result this turn)."),
        constant: z.boolean().optional().describe("If true the entry activates every turn regardless of key match."),
        enabled: z.boolean().optional().describe("Whether the entry is active at all."),
        summary: z.string().max(200).describe("One-line description of this activation change, shown above the Apply button."),
      }),
      execute: async ({ entryId, constant, enabled, summary }): Promise<CoauthorLoreBundleOutput> => {
        logger.info("set_lore_activation IN entryId=%s constant=%s enabled=%s summary=%s", entryId, constant, enabled, summary);
        const bundle = await loreDraft.setLoreActivation({ entryId, constant, enabled });
        return { target: "lore_bundle", bundle, summary };
      },
    }),

    // ── Wave 4: AI-delegation lore tools (CTX-L2b) ───────────────────────────
    // These delegate content / key generation to the AI-assistant via an
    // isolated one-shot LLM call (a focused, separate model authors the prose
    // / proposes keys) — IDE-style. Like the other lore tools they mutate ONLY
    // the turn-local draft; Apply is the sole persistence boundary. The
    // delegate reuses the standalone assistant's lore system-prompt assets and
    // grounds on the live working profile of the character being authored.
    ai_write_lore_entry: tool({
      description:
        "Delegate WRITING the content body of a lore entry to the AI-assistant (a separate, focused generation call — a smaller model authors dense worldbuilding prose). Use this when an entry drafted this turn needs its content written or rewritten. `entryId` MUST be the id of an entry returned earlier this turn. " +
        "CRITICAL: the AI-assistant sees ONLY the character card + this entry's lorebook + your `instruction` — it does NOT see this conversation. So `instruction` must be a COMPLETE, self-contained authoring brief: translate the user's request (however vague) into a precise generation directive — the subject to cover, the specific facts/angles/sensory detail to include, and any tone or length guidance. Do NOT write 'as we discussed' or 'the thing the user mentioned' — spell out everything the assistant needs to author the entry in isolation. The generated content updates the draft entry for review. Returns the complete cumulative lore draft.",
      inputSchema: z.object({
        entryId: z.string().describe("The id of the entry whose content to write (from an earlier create_lore_entry result this turn)."),
        instruction: z.string().describe("A COMPLETE, self-contained authoring brief for the AI-assistant (which sees ONLY the character card + this instruction, not the conversation). State the subject, the specifics/facts/angles to cover, and any tone. Expand the user's request into a precise directive — e.g. 'Write the backstory for why {{char}} fears the word X: the originating incident, the sensory trigger, how the fear manifests. Eerie tone, 2-3 paragraphs.'"),
        summary: z.string().max(200).describe("One-line description of this delegation, shown above the Apply button."),
      }),
      execute: async ({ entryId, instruction, summary }): Promise<CoauthorLoreBundleOutput> => {
        if (!loreDelegate) {
          throw new Error("ai_write_lore_entry: no provider is configured for AI delegation");
        }
        logger.info("ai_write_lore_entry IN entryId=%s instructionLen=%d summary=%s", entryId, instruction.length, summary);
        const input = buildLoreDelegateInput("write_entry", entryId, instruction, "ai_write_lore_entry");
        const result = await loreDelegate(input);
        const content = result.content ?? "";
        const bundle = await loreDraft.setLoreEntryContent({ entryId, content });
        logger.info("ai_write_lore_entry OK entryId=%s contentLen=%d", entryId, content.length);
        return { target: "lore_bundle", bundle, summary };
      },
    }),

    ai_generate_lore_keys: tool({
      description:
        "Delegate GENERATING activation keys for a lore entry to the AI-assistant (a separate, focused generation call analyzes the entry and proposes conversational trigger keywords). Use this when an entry needs activation triggers. `entryId` MUST be the id of an entry returned earlier this turn. The generated primary + secondary keys update the draft entry for review. Returns the complete cumulative lore draft.",
      inputSchema: z.object({
        entryId: z.string().describe("The id of the entry whose activation keys to generate (from an earlier create_lore_entry result this turn)."),
        summary: z.string().max(200).describe("One-line description of this delegation, shown above the Apply button."),
      }),
      execute: async ({ entryId, summary }): Promise<CoauthorLoreBundleOutput> => {
        if (!loreDelegate) {
          throw new Error("ai_generate_lore_keys: no provider is configured for AI delegation");
        }
        logger.info("ai_generate_lore_keys IN entryId=%s summary=%s", entryId, summary);
        const input = buildLoreDelegateInput("generate_keys", entryId, "", "ai_generate_lore_keys");
        const result = await loreDelegate(input);
        const keys = result.keys ?? [];
        const bundle = await loreDraft.setLoreEntryKeys({ entryId, keys, secondaryKeys: result.secondaryKeys });
        logger.info("ai_generate_lore_keys OK entryId=%s keys=%d secondary=%d", entryId, keys.length, (result.secondaryKeys ?? []).length);
        return { target: "lore_bundle", bundle, summary };
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

/**
 * Max tool-calling rounds per Co-Author turn (consensus maxSteps from the
 * CA-6 design review). Hardcoded for V1 — made user-tunable in CA-16, where the
 * storage decision (global `uiSettings.coauthorMaxSteps` vs per-chat
 * `coauthor_config_json`) is taken once the Wave-3 UI is visible. See
 * VTF_COAUTHOR_PLAN.md → `CA-16_configurable_max_steps`.
 */
export const COAUTHOR_MAX_STEPS = 5;
