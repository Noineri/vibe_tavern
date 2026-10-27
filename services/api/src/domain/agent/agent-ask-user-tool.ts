import { tool, type Tool } from "ai";
import { z } from "zod";
import { log } from "@vibe-tavern/domain";

/**
 * The ONE `ask_user` tool (TAG-3/TAG-5 split-turn, style B) — the clarifying
 * question a model asks the user to END its turn: the execute returns ONLY
 * the awaiting marker (the question/options/recommended echoed verbatim);
 * the split-turn mechanism stops the turn on it, the shared UI renders the
 * card, and the user's answer arrives as an `answer`-mode stream request.
 *
 * Unified at the THIRD consumer (owner ruling 2026-10-27, DIRECTOR_MODE_PLAN
 * DR-4b ruling B): the tool was born inline in
 * `interactive/copilot/experience-copilot-tools.ts` (the original) and forked
 * once into `agent/script-agent/script-agent-tools.ts` (AS-7, byte-identical);
 * when the sidechat kind needed it too, the owner ruled REUSE over a third
 * copy — this factory is the one implementation, consumed by all three kinds'
 * builders. Description, schema and the `recommended` refine are
 * byte-identical to the original inline tool.
 */

/** Same observability discipline as the original inline tool (CA-17/CANARY). */
const logger = log.tag("agent.ask_user");

/** The tool's wire name — the toggle key in every kind's tool-set schema and
 *  the `toolName` the persisted ask tool-result rows carry (the split-turn
 *  mechanism dispatches on this exact spelling). */
export const AGENT_ASK_USER_TOOL_NAME = "ask_user";

/** Marker result for the `ask_user` tool (TAG-3): the tool does NOT persist
 *  and does NOT wait — it only marks the turn as awaiting an answer. TAG-5's
 *  stop-condition and the frontend read this envelope; the question/options/
 *  recommended are echoed verbatim (options is a flat string list;
 *  `recommended` names one of them). The kind-agnostic twin of the
 *  experience kind's `ExperienceCopilotAskResult` (which aliases this). */
export interface AgentAskUserResult {
  readonly status: "awaiting_answer";
  readonly question: string;
  readonly options?: readonly string[];
  readonly recommended?: string;
}

/** Build the shared `ask_user` tool. Pure — no I/O, no store access; the
 *  caller gates it by the resolved profile's tool set like every other
 *  toggleable tool. (The base `Tool` annotation is deliberate: the SDK's
 *  inferred generic names private `@ai-sdk/provider-utils` types and is not
 *  portable across the workspace boundary — consumers only ever place the
 *  tool into a `ToolSet`, which is exactly this shape.) */
export function createAskUserTool(): Tool {
  return tool({
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
    execute: async ({ question, options, recommended }): Promise<AgentAskUserResult> => {
      logger.info("ask_user IN options=%d recommended=%s", options?.length ?? 0, recommended ?? "(none)");
      return {
        status: "awaiting_answer",
        question,
        ...(options !== undefined ? { options } : {}),
        ...(recommended !== undefined ? { recommended } : {}),
      };
    },
  });
}
