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
import { parseProfileMd, serializeProfileMd } from "@vibe-tavern/db";
import type { CoauthorTarget, CoauthorToolOutput } from "@vibe-tavern/api-contracts";

// Re-export so existing internal import sites (strategy, tests) are unaffected.
export type { CoauthorTarget, CoauthorToolOutput };

// ─── Output contract ───────────────────────────────────────────────────────

// `CoauthorTarget` and `CoauthorToolOutput` are now defined in
// `@vibe-tavern/api-contracts` (the wire contract shared with the frontend —
// CA-9.2). See the import + re-export at the top of this file.

// ─── Validation helpers ────────────────────────────────────────────────────

/**
 * Round-trip a proposed profile.md through the canonical codec to normalize
 * whitespace/heading drift so the diff the user sees is against canonical
 * text, not the model's raw emission. NOTE: parseProfileMd/serializeProfileMd
 * are TOTAL (they never throw — unknown frontmatter and missing sections pass
 * through). This function therefore canonicalizes rather than gates; the only
 * hard validation is the empty-input guard in each tool's execute().
 */
function validateProfileMd(profileMd: string): string {
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
