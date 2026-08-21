/**
 * Experience-Copilot AI tools (EXPERIENCE_EDITOR_REFACTOR_PLAN, Wave 2 / ER-4).
 *
 * These tools are the model's ONLY channel for proposing rules/visual edits to
 * an experience and for running tests against the unsaved source. They NEVER
 * write to the {@link ExperienceCopilotStore} or any script/visual resource —
 * each mutating `execute()` validates the proposal and returns it as the
 * proposed buffer; the user commits via the BE-6 binding endpoints
 * (`/api/scripts/:scriptId/visuals`), the sole write path. This is the same
 * Google-Docs-Suggestions / pull-request pattern the Co-Author tools use, with
 * two named text buffers ("rules"/"visual") in place of the profile/greeting
 * surfaces — adapted from {@link buildCoauthorTools}.
 *
 * Returned shape for the proposing tools (`write_buffer`/`edit_buffer`):
 * {@link ExperienceCopilotToolOutput} — `{ target, proposed, summary }`.
 * - `target` tells the frontend which editor surface to overlay the diff on.
 * - `proposed` is the proposed full buffer content.
 * - `summary` is a one-line "commit message" rendered above the Apply action.
 *
 * The read-only tools (`run_test`, `run_simulate`, `suggest_visual_binding`)
 * return condensed digests the model reasons over; they never mutate the
 * working state. `read_skill_file` is REUSED from the Co-Author skill system
 * (same sandboxed reader, same progressive-disclosure flow).
 *
 * The model may call several tools per turn; the AI SDK multi-step loop feeds
 * results back so the model stays coherent (bounded only by the nominal
 * `COPILOT_TOOL_LOOP_CEILING` — the profile `maxSteps` was removed in TAG-4).
 * The closure working-state composes across calls in one turn (a later call
 * sees earlier mutations), serialized through a non-poisoning queue so a
 * rejected call cannot corrupt the buffers or block a later one.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { applyExactEditsToBody, log } from "@vibe-tavern/domain";
import {
  copilotTodoListSchema,
  type CopilotTodoItem,
  type ExperienceCopilotToolOutput,
  type ExperienceSeatLegalityMatrix,
} from "@vibe-tavern/api-contracts";
import {
  runExperienceTest,
  simulateExperienceTest,
} from "../experience-tester.js";
import { buildReadSkillFileTool } from "../../coauthor/skills/skill-read-tool.js";

/** Structured log for every experience-copilot tool call — the observability
 *  channel for a path whose tool I/O and validation verdicts are otherwise
 *  invisible (errors feed back to the model as tool-results via the stepCountIs
 *  loop and never reach the server logger). Mirrors `[coauthor.tool]`. */
const logger = log.tag("exp-copilot.tool");

// ─── Read-only tool digest shapes ───────────────────────────────────────────
//
// Condensed views of the (potentially large) tester results — only what the
// model needs to reason and self-correct. These are tool-result payloads; ER-7
// will lift the full copilot wire schemas (thread/message/context) into
// `@vibe-tavern/api-contracts` alongside the tool-output schema. The proposing
// tools return {@link ExperienceCopilotToolOutput} (defined in api-contracts).

/** A create-only test digest: the model reasons over status, legal actions, a
 *  capped state snapshot, and the console tail; on failure it gets the typed
 *  error code/kind/message to self-correct in the same turn. */
export interface ExperienceCopilotRunTestDigest {
  readonly ok: boolean;
  /** Session status after create (ok path). */
  readonly status?: string;
  /** In-memory revision after create (0 for a create-only run). */
  readonly revision?: number;
  /** `type` of each legal action the human seat may submit next. */
  readonly legalActionTypes?: string[];
  /** Per-seat legality matrix (one entry per roster participant + the current
   *  turn owners) — present when the run carried a roster. The copilot's own
   *  `run_test` tool runs create-only with an empty roster (the projection's
   *  `legalActionTypes` already covers that case), so today this arrives via
   *  the frontend-pushed tester digest; kept in this interface so both digest
   *  sources stay shape-compatible. */
  readonly seatLegality?: ExperienceSeatLegalityMatrix;
  /** Compact JSON snapshot of the projected state (capped). */
  readonly stateSummary?: string;
  /** Last few flattened console entries (`level: args…`). */
  readonly consoleTail?: string[];
  /** Tester error code (failure path), e.g. `vm_error`/`validation_error`. */
  readonly errorCode?: string;
  /** Kernel/sandbox error kind (failure path), e.g. `syntax`/`missing_method`. */
  readonly errorKind?: string;
  /** Tester error message (failure path). */
  readonly errorMessage?: string;
}

/** A bounded-simulation digest: stop reason + iteration count tell the model
 *  whether the rules auto-terminate or stall; the console tail aids debugging. */
export interface ExperienceCopilotRunSimulateDigest {
  readonly ok: boolean;
  /** Why the simulation stopped (`completed`/`awaiting_human`/`no_legal_action`/…). */
  readonly stopReason?: string;
  /** Number of script-seat reduces performed. */
  readonly iterations?: number;
  readonly status?: string;
  readonly revision?: number;
  readonly consoleTail?: string[];
  readonly errorCode?: string;
  readonly errorKind?: string;
  readonly errorMessage?: string;
}

/** A REALTIME playground digest (RM-13): pushed by the frontend from the
 *  in-frame loop's observability sample. The realtime round's authority
 *  lives INSIDE the sandbox frame (the server only ever sees create() and
 *  the final claim), so this — not the turn-session shape — is the truthful
 *  signal for a realtime experience: the loop's liveness (boot status via
 *  event tails), the latest sampled projection, and the frame console. */
export interface ExperienceCopilotRealtimeDigest {
  readonly ok: boolean;
  /** Discriminator: always `realtime` (distinguishes from the turn shapes). */
  readonly mode: "realtime";
  /** Manifest tick the loop runs at (ms). */
  readonly tickMs?: number;
  /** The round's deterministic seed (replay lifeline). */
  readonly seed?: number;
  /** `running` while the loop is alive; the claim status once finished. */
  readonly status?: string;
  /** Latest sampled flat projection, capped JSON (may lag ~1s by design). */
  readonly stateSummary?: string;
  /** Tail of round-log events (`kind`-tagged loop events), bounded. */
  readonly eventTail?: string[];
  /** Tail of loop errors (`kind: message`), bounded — EMPTY means healthy. */
  readonly errorTail?: string[];
  /** Tail of the frame console (`level: text`), bounded. */
  readonly consoleTail?: string[];
  readonly errorCode?: string;
  readonly errorKind?: string;
  readonly errorMessage?: string;
}

/** A non-binding suggestion that a visual resource be bound to the experience.
 *  Binding itself is a USER action (BE-6 endpoints); the tool only surfaces the
 *  recommendation for review. */
export interface ExperienceCopilotBindingSuggestion {
  readonly suggestedVisualId?: string;
  readonly reason: string;
}

/** Result envelope for the `todo` tool (TAG-3). Success carries the rewritten
 *  list plus the collapsed-panel summary the frontend renders (`activeTitle` +
 *  `remaining`); a `saveTodo` persistence failure returns `ok:false` (NOT a
 *  throw — mirroring how `run_test` reports failures as a structured digest the
 *  model can reason over) so a transient DB error does not surface as an opaque
 *  tool-error. `remaining` counts non-completed, non-abandoned items (pending +
 *  active) — the "N remaining goals" the collapsed panel shows. */
export interface ExperienceCopilotTodoResult {
  readonly ok: boolean;
  readonly items?: readonly CopilotTodoItem[];
  readonly activeTitle?: string;
  readonly remaining?: number;
  readonly error?: string;
}

/** Marker result for the `ask_user` tool (TAG-3): the tool does NOT persist and
 *  does NOT wait — it only marks the turn as awaiting an answer. TAG-5's
 *  stop-condition and the frontend read this envelope; the question/options/
 *  recommended are echoed verbatim (options is a flat string list; `recommended`
 *  names one of them). */
export interface ExperienceCopilotAskResult {
  readonly status: "awaiting_answer";
  readonly question: string;
  readonly options?: readonly string[];
  readonly recommended?: string;
}

// ─── Tunables ─────────────────────────────────────────────────────────────────

/** Max entries retained in a digest's `consoleTail` (the model needs recent
 *  output, not the full trace). */
const CONSOLE_TAIL_MAX = 20;
/** Max chars of the projected state kept in `stateSummary` (avoids dumping the
 *  whole 256KB state into the model context). */
const STATE_SUMMARY_MAX = 1500;

// ─── Digest helpers ──────────────────────────────────────────────────────────

/** Flatten the last {@link CONSOLE_TAIL_MAX} console entries to `level: args`
 *  strings. Structural typing on the entry shape avoids importing the sandbox
 *  type transitively. */
function consoleTail(
  entries: ReadonlyArray<{ readonly level: string; readonly args: readonly string[] }>,
): string[] {
  return entries.slice(-CONSOLE_TAIL_MAX).map((e) => `${e.level}: ${e.args.join(" ")}`);
}

/** Compact JSON snapshot of an unknown projected state, capped to keep the
 *  model context bounded. Falls back to a placeholder for unserializable state. */
function summarizeState(state: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(state) ?? String(state);
  } catch {
    return "(unserializable state)";
  }
  return s.length > STATE_SUMMARY_MAX ? `${s.slice(0, STATE_SUMMARY_MAX)}\u2026` : s;
}

// ─── Tool set ───────────────────────────────────────────────────────────────

/**
 * Build the experience-copilot tool set. Pure — no I/O, no store access. The
 * proposing tools validate and echo the proposal; `run_test`/`run_simulate` are
 * read-only diagnostics; `read_skill_file` is the reused Co-Author skill
 * reader; `suggest_visual_binding` is a non-binding recommendation; `todo`
 * maintains the session step-plan (full-list rewrite through the injected
 * `saveTodo`); `ask_user` ends the turn with a clarifying question (a marker —
 * the stream, not this builder, persists/acts on it). The caller
 * passes this set to the executor (tools propose/diagnose; the BE-6 endpoints
 * are the sole write path).
 *
 * @param opts.rules   Seed rules source for the working buffer (the current
 *   script's rules at turn start). When absent, the model must `write_buffer`
 *   before `run_test`/`run_simulate` can run.
 * @param opts.visual  Seed visual source for the working buffer.
 * @param opts.toolSet Optional inclusion map for the seven authoring/diagnostic
 *   tools (default: all on). `read_skill_file` is always included, mirroring
 *   the Co-Author convention (it is the universal read-only skill channel).
 * @param opts.saveTodo Optional writer for the `todo` tool's full-list rewrite
 *   (TAG-6 wires it to `ExperienceCopilotStore.updateTodo(threadId, items)`; the
 *   test injects a fake). When absent, a `todo` call throws — a precondition
 *   miss, mirroring `run_test`'s no-buffer guard.
 * @param opts.skillRoots  Roots for the reused `read_skill_file` tool.
 */
export function buildExperienceCopilotTools(opts: {
  rules?: string;
  visual?: string;
  toolSet?: Record<string, boolean>;
  saveTodo?: (items: readonly CopilotTodoItem[]) => Promise<void>;
  skillRoots?: readonly string[];
} = {}): ToolSet {
  const { toolSet, skillRoots, saveTodo } = opts;

  // ── Turn-local composable buffer state ─────────────────────────────────────
  // Two named text buffers (rules/visual) seeded from the turn-start source.
  // Each successful buffer mutation advances the working copy, so a later call
  // composes on top of earlier mutations. Per-buffer mutation counters drive
  // the write_buffer first-mutation guard (a whole-buffer rewrite may only be
  // the FIRST change to a buffer; afterwards the model must use edit_buffer for
  // incremental changes — mirrors co-author's write_profile late-rewrite reject).
  let workingRules: string | undefined = opts.rules;
  let workingVisual: string | undefined = opts.visual;
  let rulesMutationCount = 0;
  let visualMutationCount = 0;
  let turnChain: Promise<unknown> = Promise.resolve();

  /** Serialize a buffer mutation onto the turn queue (non-poisoning: a rejected
   *  call is swallowed so the next call runs against the last good state). */
  function runQueued<T>(fn: () => Promise<T>): Promise<T> {
    const result = turnChain.catch(() => undefined).then(fn);
    turnChain = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Rules-validation guard (inside write_buffer/edit_buffer when
   * target==="rules"). Runs the PROPOSED rules source through a create-only
   * test (discover + create + project + legal actions). If it fails to
   * bootstrap a valid session, throw an Error naming the tool + the typed error
   * code/kind/message so the AI SDK surfaces it as a tool-error and the model
   * self-corrects in the same turn — the same throw-from-execute pattern the
   * Co-Author tools use for validation failures. No guard for the visual buffer
   * (no validator exists).
   */
  function validateRules(proposed: string, toolName: string): void {
    const test = runExperienceTest({ rulesCode: proposed, actions: [] });
    if (!test.ok) {
      const kind = test.error.kind !== undefined ? ` kind=${test.error.kind}` : "";
      throw new Error(
        `${toolName}: proposed rules failed validation — code=${test.error.code}${kind} message=${test.error.message}`,
      );
    }
  }

  const allTools = {
    write_buffer: tool({
      description:
        "Replace the ENTIRE rules OR visual buffer with `content`. Use it for a ground-up rewrite of a buffer. " +
        "It must be the FIRST change to that buffer in a turn — once a buffer has been mutated, refine it with edit_buffer instead. " +
        "For target 'rules', the proposed source is validated by running it through the experience sandbox (a create-only test); an invalid proposal returns a tool-error so you can self-correct in the same turn. " +
        "For target 'visual', no validation runs (no validator exists). The proposed buffer is shown to the user as a diff before they bind it.",
      inputSchema: z.object({
        target: z
          .enum(["rules", "visual"])
          .describe("Which buffer to rewrite: 'rules' (the experience rules source) or 'visual' (the visual source)."),
        content: z
          .string()
          .describe("The FULL proposed buffer content, replacing the current buffer entirely."),
        summary: z
          .string()
          .max(200)
          .describe("One-line description of what this change does, shown above the Apply action."),
      }),
      execute: async ({ target, content, summary }): Promise<ExperienceCopilotToolOutput> =>
        runQueued(async () => {
          const toolName = "write_buffer";
          if (!content.trim()) {
            logger.warn("%s REJECTED empty content target=%s", toolName, target);
            throw new Error(`${toolName}: content must not be empty`);
          }
          logger.info("%s IN target=%s len=%d summary=%s", toolName, target, content.length, summary);
          if (target === "rules") {
            // A whole-buffer rewrite may only be the FIRST rules change in a
            // turn — once the buffer has been mutated, edit_buffer must be used
            // for incremental changes (a guard-thrown write does NOT increment
            // the count, so a self-correct re-emit in the same turn is allowed).
            if (rulesMutationCount > 0) {
              logger.warn("%s REJECTED late whole-buffer rules rewrite after %d mutation(s)", toolName, rulesMutationCount);
              throw new Error(
                `${toolName}: a whole-buffer rewrite of 'rules' can only be the FIRST rules change in a turn. ` +
                  `Earlier edits already composed into the working rules buffer; a full rewrite now would erase them. ` +
                  `Use edit_buffer with exact {search, replace} edits to refine the composed result.`,
              );
            }
            validateRules(content, toolName);
            workingRules = content; // advance ONLY on success — atomic on failure
            rulesMutationCount += 1;
          } else {
            if (visualMutationCount > 0) {
              logger.warn("%s REJECTED late whole-buffer visual rewrite after %d mutation(s)", toolName, visualMutationCount);
              throw new Error(
                `${toolName}: a whole-buffer rewrite of 'visual' can only be the FIRST visual change in a turn. ` +
                  `Earlier edits already composed into the working visual buffer; a full rewrite now would erase them. ` +
                  `Use edit_buffer with exact {search, replace} edits to refine the composed result.`,
              );
            }
            workingVisual = content; // no validator for the visual buffer
            visualMutationCount += 1;
          }
          logger.info("%s OK target=%s len=%d", toolName, target, content.length);
          return { target, proposed: content, summary };
        }),
    }),

    edit_buffer: tool({
      description:
        "Apply exact SEARCH/REPLACE edits to the current rules OR visual buffer. Each `search` must match exactly once in the current buffer text; use this for targeted incremental changes after the buffer exists. " +
        "For target 'rules', the RESULTING proposed source is validated by running it through the experience sandbox (a create-only test); an invalid result returns a tool-error. " +
        "Edits compose across calls within one turn. The proposed buffer is shown to the user as a diff before they bind it.",
      inputSchema: z.object({
        target: z
          .enum(["rules", "visual"])
          .describe("Which buffer to edit: 'rules' or 'visual'."),
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
      execute: async ({ target, edits, summary }): Promise<ExperienceCopilotToolOutput> =>
        runQueued(async () => {
          const toolName = "edit_buffer";
          logger.info("%s IN target=%s edits=%d summary=%s", toolName, target, edits.length, summary);
          const current = target === "rules" ? workingRules : workingVisual;
          if (current === undefined) {
            logger.warn("%s REJECTED no %s buffer in working state", toolName, target);
            throw new Error(
              `${toolName}: no '${target}' buffer in the working state — use write_buffer to set the buffer first`,
            );
          }
          // Shared exact-edit primitive (ER-1). Atomic on failure: a failed item
          // throws and the working buffer is left untouched.
          const proposed = applyExactEditsToBody(current, edits, toolName);
          if (target === "rules") {
            validateRules(proposed, toolName);
            workingRules = proposed;
            rulesMutationCount += 1;
          } else {
            workingVisual = proposed;
            visualMutationCount += 1;
          }
          logger.info("%s OK target=%s len=%d", toolName, target, proposed.length);
          return { target, proposed, summary };
        }),
    }),

    run_test: tool({
      description:
        "Run a CREATE-ONLY test of the CURRENT working rules buffer: discover the definition, create the initial state, project for the viewer, and list the legal actions. " +
        "Returns a condensed digest (status, revision, legal action types, a capped state snapshot, and the console tail) so you can verify the rules bootstrap correctly. " +
        "On failure, returns the typed error code/kind/message to self-correct. Read-only — it NEVER mutates the working buffers. " +
        "Use this after writing/editing rules to confirm they are valid and to see what actions are available before the user binds the source.",
      inputSchema: z.object({}),
      execute: async (): Promise<ExperienceCopilotRunTestDigest> => {
        const toolName = "run_test";
        if (workingRules === undefined) {
          logger.warn("%s REJECTED no rules buffer in working state", toolName);
          throw new Error(
            `${toolName}: no rules buffer in the working state — write_buffer or edit_buffer rules first`,
          );
        }
        logger.info("%s IN rulesLen=%d", toolName, workingRules.length);
        const result = runExperienceTest({ rulesCode: workingRules, actions: [] });
        if (result.ok) {
          logger.info("%s OK status=%s revision=%d legalActions=%d", toolName, result.data.status, result.data.revision, result.data.projection.actions.length);
          return {
            ok: true,
            status: result.data.status,
            revision: result.data.revision,
            legalActionTypes: result.data.projection.actions.map((a) => a.type),
            stateSummary: summarizeState(result.data.projection.state),
            consoleTail: consoleTail(result.data.console),
          };
        }
        logger.warn("%s FAIL code=%s kind=%s", toolName, result.error.code, result.error.kind ?? "(none)");
        return {
          ok: false,
          errorCode: result.error.code,
          errorKind: result.error.kind,
          errorMessage: result.error.message,
          consoleTail: consoleTail(result.error.console),
        };
      },
    }),

    run_simulate: tool({
      description:
        "Run a bounded SIMULATION of the CURRENT working rules buffer: discover, create, then auto-advance script-controlled seats via the real `choose` until a human/model boundary, a terminal status, no legal action, or a host bound is reached. " +
        "Returns a diagnostic digest (stop reason, iteration count, status, console tail) telling you whether the rules auto-terminate or stall. Read-only — it NEVER mutates the working buffers. " +
        "Use this to sanity-check that a rules package terminates or advances sensibly under automated play before the user binds the source.",
      inputSchema: z.object({}),
      execute: async (): Promise<ExperienceCopilotRunSimulateDigest> => {
        const toolName = "run_simulate";
        if (workingRules === undefined) {
          logger.warn("%s REJECTED no rules buffer in working state", toolName);
          throw new Error(
            `${toolName}: no rules buffer in the working state — write_buffer or edit_buffer rules first`,
          );
        }
        logger.info("%s IN rulesLen=%d", toolName, workingRules.length);
        const result = simulateExperienceTest({ rulesCode: workingRules });
        if (result.ok) {
          logger.info("%s OK stopReason=%s iterations=%d", toolName, result.data.stopReason, result.data.iterations);
          return {
            ok: true,
            stopReason: result.data.stopReason,
            iterations: result.data.iterations,
            status: result.data.status,
            revision: result.data.revision,
            consoleTail: consoleTail(result.data.console),
          };
        }
        logger.warn("%s FAIL code=%s kind=%s", toolName, result.error.code, result.error.kind ?? "(none)");
        return {
          ok: false,
          errorCode: result.error.code,
          errorKind: result.error.kind,
          errorMessage: result.error.message,
          consoleTail: consoleTail(result.error.console),
        };
      },
    }),

    suggest_visual_binding: tool({
      description:
        "Suggest that a visual resource be bound to the experience (a non-binding recommendation for the user). " +
        "Optionally name a `visualId` you believe fits; `reason` explains why. The suggestion is surfaced for review only — actual binding is a USER action via the binding endpoints, never performed by this tool. " +
        "Use this when the rules would benefit from a visual component but you cannot bind it yourself.",
      inputSchema: z.object({
        reason: z
          .string()
          .min(1)
          .max(2000)
          .describe("Why a visual should be bound (or why the named one fits)."),
        visualId: z
          .string()
          .min(1)
          .optional()
          .describe("Optional: a specific visual resource id you recommend binding. Omit for a general recommendation."),
      }),
      execute: async ({ reason, visualId }): Promise<ExperienceCopilotBindingSuggestion> => {
        logger.info("suggest_visual_binding IN visualId=%s reasonLen=%d", visualId ?? "(none)", reason.length);
        return { ...(visualId !== undefined ? { suggestedVisualId: visualId } : {}), reason };
      },
    }),

    todo: tool({
      description:
        "Maintain the step-by-step action plan for this authoring session. Send the FULL list every call (rewrite semantics, not incremental) as {items: [...]}. " +
        "One item should be `active` — the step you are on now. Use for any work that needs more than ~3 steps; this is a real development project, plan it.",
      // Object root (2026-08-21 incident): a bare-array inputSchema made models
      // emit `{}` — tool-calling arguments are JSON objects, and providers
      // reject/never produce a non-object root — so every call failed
      // validation ("expected array, received object") and the turn died.
      inputSchema: z.object({
        items: copilotTodoListSchema.describe("The FULL rewritten todo list — every item, every time."),
      }),
      execute: async ({ items }): Promise<ExperienceCopilotTodoResult> =>
        runQueued(async () => {
          const toolName = "todo";
          logger.info("%s IN items=%d", toolName, items.length);
          if (saveTodo === undefined) {
            logger.warn("%s REJECTED no saveTodo writer wired", toolName);
            throw new Error(`${toolName}: no todo writer wired — saveTodo is required for this tool`);
          }
          try {
            await saveTodo(items);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn("%s FAIL message=%s", toolName, message);
            return { ok: false, error: message };
          }
          const activeTitle = items.find((i) => i.status === "active")?.title;
          const remaining = items.filter((i) => i.status === "pending" || i.status === "active").length;
          logger.info("%s OK items=%d remaining=%d activeTitle=%s", toolName, items.length, remaining, activeTitle ?? "(none)");
          return { ok: true, items, activeTitle, remaining };
        }),
    }),

    ask_user: tool({
      description:
        "Ask the user ONE clarifying question and end your turn. Provide option chips when the answer space is small (mark your recommended option via `recommended`), or omit options for open questions. " +
        "The user may answer with a chip, answer freely, or skip.",
      inputSchema: z
        .object({
          question: z.string().min(1).describe("The single clarifying question to ask."),
          options: z
            .array(z.string().min(1))
            .max(6)
            .optional()
            .describe("Optional answer chips for a small answer space. Omit for an open question."),
          recommended: z
            .string()
            .min(1)
            .optional()
            .describe("Optional: which option you recommend. Must be one of `options` when present."),
        })
        .refine(
          (data) =>
            data.recommended === undefined ||
            (data.options !== undefined && data.options.includes(data.recommended)),
          {
            message: "`recommended` must be one of `options` (omit both for a free-text-only question)",
            path: ["recommended"],
          },
        ),
      execute: async ({ question, options, recommended }): Promise<ExperienceCopilotAskResult> => {
        logger.info("ask_user IN options=%d recommended=%s", options?.length ?? 0, recommended ?? "(none)");
        return {
          status: "awaiting_answer",
          question,
          ...(options !== undefined ? { options } : {}),
          ...(recommended !== undefined ? { recommended } : {}),
        };
      },
    }),
  };

  // read_skill_file is always available (the universal read-only skill channel,
  // NOT gated by toolSet) — mirroring the Co-Author convention. It is REUSED
  // directly from the Co-Author skill system, not reimplemented.
  if (toolSet) {
    const filtered = Object.fromEntries(
      Object.entries(allTools).filter(([name]) => toolSet[name] === true),
    ) as typeof allTools;
    return {
      ...filtered,
      read_skill_file: buildReadSkillFileTool(skillRoots ?? []),
    } as typeof allTools & { read_skill_file: ReturnType<typeof buildReadSkillFileTool> };
  }
  return {
    ...allTools,
    read_skill_file: buildReadSkillFileTool(skillRoots ?? []),
  } as typeof allTools & { read_skill_file: ReturnType<typeof buildReadSkillFileTool> };
}
