/**
 * Script-agent AI tools (AGENT_SHELL_PLAN, Wave 3 / AS-7).
 *
 * The model's ONLY channels for proposing code edits and testing the script
 * being authored. Mirrors `experience-copilot-tools.ts` structurally, with the
 * script species' specifics:
 *
 * - `write_buffer`/`edit_buffer` over the SINGLE buffer `code` through the
 *   generic factory (`agent-buffer-tools.ts`) — same proposal semantics
 *   (Google-Docs-Suggestions / pull-request pattern: mutating `execute()`
 *   validates and returns the proposal; committing is the USER's action).
 *   NO validator (the plan's letter: none exists for free-form script code).
 * - `run_script_test` runs the CURRENT working `code` buffer through the SAME
 *   tester the script-test route uses (`testScript` — the domain service
 *   behind `POST /api/scripts/:scriptId/test`), which dispatches by the
 *   STORED script kind: prompt scripts run the seven-channel tester, dice
 *   scripts run discovery + one deterministic sample roll per check (the
 *   exact path DiceScriptTester reaches through the route). The result is
 *   trimmed to a kind-discriminated digest the model can reason over.
 * - `plan`/`read_plan` via the shared agent-plan tools, `ask_user` (the
 *   TAG-3 marker semantics), `read_skill_file` reused from the Co-Author
 *   skill system — wired exactly the way the experience kind wires them.
 *
 * TRUST (SCRIPT_SAFETY_PLAN, the unit's HARD security point): an imported
 * script that has never been enabled is UNTRUSTED — its code NEVER executes
 * here, not even for a test. `run_script_test` checks the REQUIRED
 * `codeTrusted` flag of {@link buildScriptAgentTools}'s opts FIRST and returns
 * a structured refusal naming how trust is established (fail-closed: the flag
 * has NO trusted default, so a caller that forgets to derive it gets a type
 * error, not a silent execution). The domain `testScript` service itself has NO trust
 * gate (the route adapter owns it there) — so this boundary owns it here.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { StoreContainer } from "@vibe-tavern/db";
import { log, type AgentPlan } from "@vibe-tavern/domain";
import { testScript, type ScriptTestInput, type ScriptTestResult } from "../../scripts-engine/script-test-service.js";
import { buildReadSkillFileTool } from "../../coauthor/skills/skill-read-tool.js";
import { createAgentPlanTools } from "../../agent-plan/agent-plan-tools.js";
import { createBufferTools } from "../agent-buffer-tools.js";

/** Structured log for every script-agent tool call — the observability channel
 *  for a path whose tool I/O and validation verdicts are otherwise invisible
 *  (errors feed back to the model as tool-results and never reach the server
 *  logger). Mirrors `[exp-copilot.tool]`. */
const logger = log.tag("script-agent.tool");

// ─── Trust refusal constants (mirrors the experience kind's SS-4B wording) ───

/** Tester-style error code for the structured run refusal (matches the
 *  snake_case convention of `script_not_enabled`/`validation_error`). */
const UNTRUSTED_SCRIPT_ERROR_CODE = "script_not_trusted";
/** The model-visible refusal reason — the model relays it to the user. */
const UNTRUSTED_SCRIPT_REFUSAL_MESSAGE =
  "script is imported and never enabled — enable it in the editor first: its code does not run (not even for tests) until the user reviews the import warning and enables it through the import-warning flow; tell the user this";

// ─── Digest caps (mirrors the experience kind's digest tunables) ─────────────

/** Max entries retained in a digest's `consoleTail`. */
const CONSOLE_TAIL_MAX = 20;
/** Max chars of the `state`/`shared` snapshots kept in the digest. */
const STATE_SUMMARY_MAX = 1500;
/** Max chars of the personality/scenario outputs kept in the digest. */
const OUTPUT_TEXT_MAX = 2000;

// ─── Result envelope ─────────────────────────────────────────────────────────

/** The prompt-script test digest (trimmed from PromptScriptTestResult). */
export interface ScriptAgentPromptTestDigest {
  readonly ok: boolean;
  readonly kind: "prompt";
  /** The personality the script left on the character (capped). */
  readonly personality: string;
  /** The scenario the script left (capped). */
  readonly scenario: string;
  /** Compact JSON snapshot of the script's `context.state` (capped). */
  readonly stateSummary: string;
  /** Messages the script injected via `context.chat.injectMessage(...)`. */
  readonly injectedMessages: ReadonlyArray<{ readonly content: string; readonly role: string }>;
  /** Last few console entries (`level: args`). */
  readonly consoleTail: readonly string[];
  /** Per-script runtime errors (empty when the run was clean). */
  readonly errors: ReadonlyArray<{ readonly error: string; readonly line?: number }>;
}

/** The dice-script test digest (trimmed from DiceScriptTestResult). */
export interface ScriptAgentDiceTestDigest {
  readonly ok: boolean;
  readonly kind: "dice";
  /** Validated check descriptors from discovery. */
  readonly checks: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly notation: string;
    readonly actors: readonly string[];
  }>;
  /** One deterministic sample roll per valid check (first allowed actor). */
  readonly sampleRolls: ReadonlyArray<{
    readonly checkId: string;
    readonly result:
      | { readonly ok: true; readonly faces: readonly number[]; readonly total: number; readonly final?: { readonly total: number; readonly outcome?: string; readonly degree?: string } }
      | { readonly ok: false; readonly error: string };
  }>;
  /** Discovery VM error (syntax/runtime/timeout); null when clean. */
  readonly discoveryError: string | null;
}

/** The `run_script_test` result: the kind-discriminated digest, or the
 *  structured untrusted-refusal envelope (`errorCode: "script_not_trusted"`). */
export type ScriptAgentRunTestResult =
  | ScriptAgentPromptTestDigest
  | ScriptAgentDiceTestDigest
  | { readonly ok: false; readonly errorCode: string; readonly errorMessage: string };

// ─── Digest helpers ──────────────────────────────────────────────────────────

/** Cap a free-text run output (personality/scenario) for the model context. */
function capText(text: string): string {
  return text.length > OUTPUT_TEXT_MAX ? `${text.slice(0, OUTPUT_TEXT_MAX)}\u2026` : text;
}

/** Compact JSON snapshot of an unknown state object, capped. */
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

/** Build the script-agent tool set. Pure with respect to stores — the only
 *  store consumer is `run_script_test`, which calls the domain `testScript`
 *  service through the injected {@link ScriptAgentToolsOpts.stores} (the same
 *  seam the route adapter uses). */
export function buildScriptAgentTools(opts: {
  /** The script under authoring — `run_script_test` runs against its row (the
   *  tester dispatches by the STORED script kind, exactly like the route). */
  readonly scriptId: string;
  /** Seed the `code` working buffer with the LIVE request buffer (the current
   *  unsaved editor code). When absent, the model must `write_buffer` before
   *  `run_script_test` can run. */
  readonly code?: string;
  /**
   * Trust flag for the script's code (REQUIRED, no default — derive with
   * `isScriptAuthoringTrusted(scriptRow)`). When false, `run_script_test`
   * refuses with the structured `script_not_trusted` envelope and NOTHING
   * executes.
   */
  readonly codeTrusted: boolean;
  /** Store container for the test service (T1 seam — tests may inject a spy). */
  readonly stores: StoreContainer;
  /** Optional inclusion map for the toggleable tools (default: all on).
   *  `read_skill_file` is always included (the universal read-only channel). */
  readonly toolSet?: Record<string, boolean>;
  /** Plan reader/writer for the script-owned agent plan (the stream wires
   *  these; absent ⇒ the plan tools throw their precondition errors). */
  readonly loadPlan?: () => Promise<AgentPlan | null>;
  readonly savePlan?: (plan: AgentPlan) => Promise<void>;
  /** Roots for the reused `read_skill_file` tool. */
  readonly skillRoots?: readonly string[];
}): ToolSet {
  const { toolSet, skillRoots, loadPlan, savePlan } = opts;
  const codeTrusted = opts.codeTrusted;

  const agentPlanTools = createAgentPlanTools({
    load: loadPlan ?? (async () => {
      throw new Error("read_plan: no plan reader wired");
    }),
    save: savePlan ?? (async () => {
      throw new Error("plan: no plan writer wired");
    }),
  });

  // ── Buffer tools through the generic factory (single buffer: `code`) ─────
  const bufferTools = createBufferTools({
    bufferIds: ["code"],
    ...(opts.code !== undefined ? { seeds: { code: opts.code } } : {}),
    descriptions: {
      write: () =>
        "For target 'code', no validation runs (no validator exists for free-form script code). The proposed buffer is shown to the user as a diff before they apply it; use run_script_test to check it.",
      edit: () =>
        "Edits compose across calls within one turn. The proposed buffer is shown to the user as a diff before they apply it; use run_script_test to check it.",
      targetDescribe: () => "'code' (the script's source code)",
    },
    firstMutationGuard: { code: true },
    makeOutput: (target, proposed, summary) => ({ target, proposed, summary }),
  });

  const allTools = {
    write_buffer: bufferTools.write_buffer,
    edit_buffer: bufferTools.edit_buffer,

    run_script_test: tool({
      description:
        "Run the script's own test against the CURRENT working `code` buffer — the SAME tester the user's test panel runs (prompt scripts: the full seven-channel run with a simulated message; dice scripts: check discovery plus one deterministic sample roll per check). " +
        "Returns a trimmed, kind-discriminated result: outputs (personality/scenario for prompt scripts; checks and sample rolls for dice scripts), a capped state snapshot, the console tail, and typed errors to self-correct. Read-only with respect to the buffer — it NEVER mutates the working code. " +
        "Run it before declaring a change done, and again after every fix. " +
        "If it returns `script_not_trusted`, the script is imported and not yet enabled: relay that to the user — do not attempt to work around it.",
      inputSchema: z.object({
        input: z
          .string()
          .max(4000)
          .optional()
          .describe(
            "Optional simulated chat message for PROMPT scripts (the user turn the script reacts to). Ignored by dice scripts.",
          ),
        characterName: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Optional character name for the test context (dice sample rolls label the character actor with it; prompt scripts see it as context.character.name).",
          ),
        personaName: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Optional persona name (dice sample rolls label the persona actor with it; prompt scripts see it as context.persona.name).",
          ),
      }),
      execute: async (args): Promise<ScriptAgentRunTestResult> => {
        const toolName = "run_script_test";
        // TRUST GATE FIRST (fail-closed, zero tolerance): an imported,
        // never-enabled script is never executed — not even for a read-only
        // test. Structured refusal (not a throw) so the model can relay the
        // reason to the user in the same turn. Nothing below this branch may
        // execute while codeTrusted is false — including the store read.
        if (!codeTrusted) {
          logger.warn("%s REFUSED untrusted script (imported, never enabled)", toolName);
          return {
            ok: false,
            errorCode: UNTRUSTED_SCRIPT_ERROR_CODE,
            errorMessage: UNTRUSTED_SCRIPT_REFUSAL_MESSAGE,
          };
        }
        const workingCode = bufferTools.getBuffer("code");
        if (workingCode === undefined) {
          logger.warn("%s REJECTED no code buffer in working state", toolName);
          throw new Error(
            `${toolName}: no 'code' buffer in the working state — write_buffer or edit_buffer code first`,
          );
        }
        logger.info(
          "%s IN codeLen=%d input=%s char=%s persona=%s",
          toolName,
          workingCode.length,
          args.input !== undefined ? "yes" : "no",
          args.characterName ?? "(default)",
          args.personaName ?? "(default)",
        );
        const input: ScriptTestInput = {
          scriptId: opts.scriptId,
          code: workingCode,
          ...(args.input !== undefined ? { lastMessage: args.input } : {}),
          ...(args.characterName !== undefined ? { characterName: args.characterName } : {}),
          ...(args.personaName !== undefined
            ? { persona: { name: args.personaName, description: "" } }
            : {}),
        };
        const result = await testScript(opts.stores, input);
        const digest = trimTestResult(result);
        const digestKind = "kind" in digest ? digest.kind : digest.errorCode;
        logger.info("%s %s kind=%s", toolName, digest.ok ? "OK" : "FAIL", digestKind);
        return digest;
      },
    }),

    ...agentPlanTools,

    // fork #2 of ask_user (services/api/src/domain/interactive/copilot/experience-copilot-tools.ts)
    // — description, schema, and `recommended`-refine are byte-identical; only
    // the kind-owned result type differs. Source carries the reciprocal count.
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
      execute: async ({ question, options, recommended }): Promise<{
        readonly status: "awaiting_answer";
        readonly question: string;
        readonly options?: readonly string[];
        readonly recommended?: string;
      }> => {
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
  // NOT gated by toolSet) — mirroring the experience/Co-Author convention.
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

// ─── Envelope trimming ───────────────────────────────────────────────────────

/**
 * Trim the tester's full result into the model-facing digest — the noise
 * control point (the plan's failure point #4): only what the model needs to
 * reason and self-correct, everything long capped, everything
 * panel-rendering-only dropped.
 */
function trimTestResult(result: ScriptTestResult): ScriptAgentRunTestResult {
  if (result.kind === "prompt") {
    return {
      ok: result.errors.length === 0,
      kind: "prompt",
      personality: capText(result.personality),
      scenario: capText(result.scenario),
      stateSummary: summarizeState(result.state),
      injectedMessages: result.injectedMessages.map((m) => ({ content: m.content, role: m.role })),
      consoleTail: result.console.slice(-CONSOLE_TAIL_MAX).map((e) => `${e.level}: ${e.args}`),
      errors: result.errors.map((e) => ({
        error: e.error,
        ...(e.line !== undefined ? { line: e.line } : {}),
      })),
    };
  }
  if (result.kind === "dice") {
    return {
      ok: result.discoveryError === null,
      kind: "dice",
      checks: result.checks.map((c) => ({
        id: c.id,
        label: c.label,
        notation: c.notation,
        actors: [...c.actors],
      })),
      sampleRolls: result.sampleRolls.map((r) => ({
        checkId: r.checkId,
        result:
          r.result.ok === true
            ? {
                ok: true as const,
                faces: [...r.result.faces],
                total: r.result.total,
                ...(r.result.final !== undefined
                  ? {
                      final: {
                        total: r.result.final.total,
                        ...(r.result.final.outcome !== undefined
                          ? { outcome: r.result.final.outcome }
                          : {}),
                        ...(r.result.final.degree !== undefined
                          ? { degree: r.result.final.degree }
                          : {}),
                      },
                    }
                  : {}),
              }
            : { ok: false as const, error: r.result.error },
      })),
      discoveryError: result.discoveryError,
    };
  }
  // `interactive` scripts are served by the EXPERIENCE kind, not this one; a
  // stored interactive kind reaching here is a wiring error. Fail loudly with
  // a typed envelope instead of executing further trimming assumptions.
  return {
    ok: false,
    errorCode: "script_kind_not_supported",
    errorMessage:
      `run_script_test serves prompt and dice scripts; this script's stored kind is "${result.kind}" (interactive scripts belong to the experience agent).`,
  };
}
