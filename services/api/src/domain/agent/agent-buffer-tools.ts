/**
 * Generic agent buffer tools (AGENT_SHELL_PLAN, Wave 1 / AS-2c) — the
 * kind-AGNOSTIC `write_buffer`/`edit_buffer` mechanism carved out of
 * `experience-copilot-tools.ts` (ER-4): per-buffer working state seeded at
 * turn start, the whole-buffer FIRST-mutation guard, per-buffer validators
 * (throw = tool-error; `{ notValidated }` return = an SS-4B-style marker
 * riding on the output) and empty-content rejection. SDK entrypoints serialize
 * tool execution. Everything KIND-SPECIFIC — buffer ids, description fragments,
 * and output shape — arrives through
 * {@link CreateBufferToolsConfig}; the experience wiring in the old module
 * reproduces today's strings BYTE-EXACTLY through them (pinned by the tools
 * suite's description pins).
 *
 * The tools never write to a store or any external resource: a mutating
 * `execute()` validates the proposal and returns it as the proposed buffer;
 * committing is the user's action at the kind's own binding endpoints (the
 * Google-Docs-Suggestions / pull-request pattern).
 *
 * This file must stay free of kind knowledge: no buffer names in code, no
 * kind imports — a second kind (the script agent, AS-7) builds its buffer
 * tools through the same factory.
 */

import { tool, type Tool } from "ai";
import { z } from "zod";
import { applyExactEditsToBody, log } from "@vibe-tavern/domain";

/** Structured log for every buffer-tool call — the observability channel for a
 *  path whose tool I/O and validation verdicts are otherwise invisible (errors
 *  feed back to the model as tool-results and never reach the server logger).
 *  Mirrors the tool-builder tag convention. */
const logger = log.tag("agent-buffer-tools");

// ─── Input/output shapes ─────────────────────────────────────────────────────

/** `write_buffer` input: which buffer to rewrite, the full proposed content,
 *  and a one-line change summary. */
export interface AgentBufferWriteInput {
  readonly target: string;
  readonly content: string;
  readonly summary: string;
}

/** One exact SEARCH/REPLACE edit (the shared exact-edit primitive's item). */
export interface AgentBufferEditItem {
  readonly search: string;
  readonly replace: string;
}

/** `edit_buffer` input: which buffer to edit, the ordered edit list, and the
 *  one-line change summary. The edit list is mutable-shaped to mirror the
 *  zod schema's inference (consumers read it as a readonly view). */
export interface AgentBufferEditInput {
  readonly target: string;
  readonly edits: AgentBufferEditItem[];
  readonly summary: string;
}

/** A validator's optional annotation on an ACCEPTED proposal (the SS-4B
 *  «not validated» marker pattern: the proposal is accepted without running
 *  the kind's validation because its source must not execute yet). */
export interface AgentBufferMarker {
  readonly notValidated?: string;
}

/** The structural result of a successful buffer mutation: the proposal triple
 *  (which buffer, the full proposed content, the one-line change summary)
 *  plus the optional marker. The kind's richer output types are structural
 *  supersets of this base (the marker is the only extension point today). */
export interface AgentBufferToolOutput {
  readonly target: string;
  readonly proposed: string;
  readonly summary: string;
  readonly notValidated?: string;
}

// ─── Description seams ───────────────────────────────────────────────────────

/** The kind-owned description fragments. Each function receives a buffer id
 *  and returns that buffer's slice of the composed copy; the factory splices
 *  them around the generic mechanism sentences (the buffer list and target
 *  enum are interpolated from `bufferIds`), so the kind's fragments reproduce
 *  its exact tool copy. */
export interface AgentBufferDescriptions {
  /** The buffer's validation sentence inside the `write_buffer` description
   *  (joined with a single space between buffers, appended after the generic
   *  whole-buffer-rewrite sentences). */
  readonly write: (bufferId: string) => string;
  /** The buffer's sentence inside the `edit_buffer` description (same
   *  joining rule). */
  readonly edit: (bufferId: string) => string;
  /** The buffer's ANNOTATED label for the `write_buffer` target enum's
   *  describe text (e.g. `'<id>' (what this buffer is)`). `write_buffer` is
   *  the buffer-introducing tool, so it lists the annotated labels;
   *  `edit_buffer` — a follow-up refinement — lists the bare ids. */
  readonly targetDescribe: (bufferId: string) => string;
}

// ─── Factory config ──────────────────────────────────────────────────────────

/** Build the generic buffer-tool pair. Pure — no I/O, no store access. The
 *  output type is the structural base {@link AgentBufferToolOutput}: ai@7's
 *  Tool typing (a `NeverOptional<OUTPUT, …>` conditional) cannot be satisfied
 *  by an unresolved generic output at tool-construction time, and every house
 *  tool factory (cf. the todo tool) likewise types its concrete result. */
export interface CreateBufferToolsConfig {
  /** The kind's buffer ids, in the order descriptions enumerate them. */
  readonly bufferIds: readonly string[];
  /** Turn-start working-state seeds per buffer (absent key = the buffer does
   *  not exist yet — `edit_buffer` then refuses until `write_buffer` sets
   *  it). An explicit empty string is a valid seeded buffer. */
  readonly seeds?: Readonly<Partial<Record<string, string>>>;
  /** The kind's description fragments (see {@link AgentBufferDescriptions}). */
  readonly descriptions: AgentBufferDescriptions;
  /** Per-buffer proposal validators. Called with the PROPOSED content and the
   *  calling tool's name: a THROW surfaces as a tool-error so the model can
   *  self-correct in the same turn; a returned {@link AgentBufferMarker}
   *  rides on the output through `makeOutput`; a buffer with no entry is
   *  accepted unvalidated. */
  readonly validators?: Partial<
    Record<string, (content: string, toolName: string) => AgentBufferMarker | undefined>
  >;
  /** Per-buffer FIRST-mutation guard for `write_buffer`: when true (default
   *  per buffer: false), a whole-buffer rewrite may only be the FIRST change
   *  to that buffer in a turn — afterwards the model must use `edit_buffer`
   *  for incremental changes (a guard-thrown write does NOT increment the
   *  count, so a self-correct re-emit in the same turn is allowed). */
  readonly firstMutationGuard?: Partial<Record<string, boolean>>;
  /** Builds one tool-result object from a successful mutation. `marker` is
   *  the validator's annotation (undefined when the validator ran clean or no
   *  validator exists); the kind decides whether and how it lands on the
   *  output. */
  readonly makeOutput: (
    target: string,
    proposed: string,
    summary: string,
    marker: AgentBufferMarker | undefined,
  ) => AgentBufferToolOutput;
}

/** The factory result: the two ToolSet pieces plus the working-state reader
 *  the kind's read-only diagnostic tools use (they run against the CURRENT
 *  working buffer, composing on earlier in-turn mutations). */
export interface AgentBufferTools {
  readonly write_buffer: Tool<AgentBufferWriteInput, AgentBufferToolOutput>;
  readonly edit_buffer: Tool<AgentBufferEditInput, AgentBufferToolOutput>;
  /** The current working content of a buffer, or undefined when the buffer
   *  has neither been seeded nor mutated this turn. */
  readonly getBuffer: (bufferId: string) => string | undefined;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/** Build the generic buffer tools. SDK entrypoints serialize execution with
 *  `toolCallConcurrency: 1` so mutations compose on the last good state. */
export function createBufferTools(
  config: CreateBufferToolsConfig,
): AgentBufferTools {
  const { bufferIds, descriptions, makeOutput } = config;

  const bufferListPhrase = bufferIds.join(" OR ");
  const targetEnumPhrase = bufferIds.map((id) => `'${id}'`).join(" or ");

  // ── Turn-local composable buffer state ─────────────────────────────────────
  // Each successful buffer mutation advances the working copy, so a later call
  // composes on top of earlier mutations. Per-buffer mutation counters drive
  // the write_buffer first-mutation guard.
  const working = new Map<string, string>();
  for (const [bufferId, seed] of Object.entries(config.seeds ?? {})) {
    if (seed !== undefined) working.set(bufferId, seed);
  }
  const mutationCounts = new Map<string, number>();
  const getBuffer = (bufferId: string): string | undefined => working.get(bufferId);

  const write_buffer = tool({
    description:
      `Replace the ENTIRE ${bufferListPhrase} buffer with \`content\`. EVERY call MUST include \`target\` (${targetEnumPhrase}) — a call missing it, or any required field, is rejected wholesale. ` +
      "Use it for a ground-up rewrite of a buffer. " +
      "It must be the FIRST change to that buffer in a turn — once a buffer has been mutated, refine it with edit_buffer instead. " +
      bufferIds.map(descriptions.write).join(" "),
    inputSchema: z.object({
      target: z
        .enum(bufferIds)
        .describe(
          "REQUIRED on every call. Which buffer to rewrite: " +
            bufferIds.map(descriptions.targetDescribe).join(" or ") +
            ". Never omit.",
        ),
      content: z
        .string()
        .describe("The FULL proposed buffer content, replacing the current buffer entirely."),
      summary: z
        .string()
        .max(200)
        .describe("One-line description of what this change does, shown above the Apply action."),
    }),
    execute: async ({ target, content, summary }): Promise<AgentBufferToolOutput> => {
      const toolName = "write_buffer";
      if (!content.trim()) {
        logger.warn("%s REJECTED empty content target=%s", toolName, target);
        throw new Error(`${toolName}: content must not be empty`);
      }
      logger.info("%s IN target=%s len=%d summary=%s", toolName, target, content.length, summary);
      if (config.firstMutationGuard?.[target] === true) {
        const count = mutationCounts.get(target) ?? 0;
        if (count > 0) {
          logger.warn(
            "%s REJECTED late whole-buffer %s rewrite after %d mutation(s)",
            toolName,
            target,
            count,
          );
          throw new Error(
            `${toolName}: a whole-buffer rewrite of '${target}' can only be the FIRST ${target} change in a turn. ` +
              `Earlier edits already composed into the working ${target} buffer; a full rewrite now would erase them. ` +
              `Use edit_buffer with exact {search, replace} edits to refine the composed result.`,
          );
        }
      }
      const marker = config.validators?.[target]?.(content, toolName);
      working.set(target, content); // advance ONLY on success — atomic on failure
      mutationCounts.set(target, (mutationCounts.get(target) ?? 0) + 1);
      logger.info("%s OK target=%s len=%d", toolName, target, content.length);
      return makeOutput(target, content, summary, marker);
    },
  });

  const edit_buffer = tool({
    description:
      `Apply exact SEARCH/REPLACE edits to the current ${bufferListPhrase} buffer. EVERY call MUST include \`target\` (${targetEnumPhrase}) — a call missing it, or any required field, is rejected wholesale before any edit runs. ` +
      "Each `search` must match exactly once in the current buffer text; use this for targeted incremental changes after the buffer exists. " +
      bufferIds.map(descriptions.edit).join(" "),
    inputSchema: z.object({
      target: z
        .enum(bufferIds)
        .describe(
          "REQUIRED on every call. Which buffer to edit: " +
            bufferIds.map((id) => `'${id}'`).join(" or ") +
            ". Never omit.",
        ),
      edits: z
        .array(
          z.object({
            search: z.string().describe("Exact text to find in the current buffer (must match once)."),
            replace: z.string().describe("The replacement text."),
          }),
        )
        .min(1)
        .describe("Ordered exact SEARCH/REPLACE edits applied to the current buffer."),
      summary: z
        .string()
        .max(200)
        .describe("One-line description of what these edits change, shown above the Apply action."),
    }),
    execute: async ({ target, edits, summary }): Promise<AgentBufferToolOutput> => {
      const toolName = "edit_buffer";
      logger.info("%s IN target=%s edits=%d summary=%s", toolName, target, edits.length, summary);
      const current = working.get(target);
      if (current === undefined) {
        logger.warn("%s REJECTED no %s buffer in working state", toolName, target);
        throw new Error(
          `${toolName}: no '${target}' buffer in the working state — use write_buffer to set the buffer first`,
        );
      }
      // Shared exact-edit primitive. Atomic on failure: a failed item throws
      // and the working buffer is left untouched.
      const proposed = applyExactEditsToBody(current, edits, toolName);
      const marker = config.validators?.[target]?.(proposed, toolName);
      working.set(target, proposed);
      mutationCounts.set(target, (mutationCounts.get(target) ?? 0) + 1);
      logger.info("%s OK target=%s len=%d", toolName, target, proposed.length);
      return makeOutput(target, proposed, summary, marker);
    },
  });

  return { write_buffer, edit_buffer, getBuffer };
}