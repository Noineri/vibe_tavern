import { tool, type Tool } from "ai";
import { z } from "zod";
import { log } from "@vibe-tavern/domain";
import { copilotTodoListSchema, type CopilotTodoItem } from "@vibe-tavern/api-contracts";

/**
 * The copilot's session-scoped `todo` tool (TAG-3, restored PM-7 — owner
 * ruling 2026-10-11: todo = the thread's session checklist living BESIDE the
 * script-owned plan; see `agent-plan-tools.ts` for the durable twin).
 *
 * The builder injects the persistence writer. SDK entrypoints serialize tool
 * execution with `toolCallConcurrency: 1`.
 */

/** Structured log — same observability tag as the builder's other tools. */
const logger = log.tag("exp-copilot.tool");

/** Result envelope for the `todo` tool (TAG-3, restored PM-7). Success
 *  carries the rewritten list plus the collapsed-panel summary the frontend
 *  renders (`activeTitle` + `remaining`); a `save` persistence failure
 *  returns `ok:false` (NOT a throw — mirroring how `run_test` reports
 *  failures as a structured digest the model can reason over) so a transient
 *  DB error does not surface as an opaque tool-error. `remaining` counts
 *  non-completed, non-abandoned items (pending + active) — the "N remaining
 *  goals" the collapsed panel shows. */
export interface ExperienceCopilotTodoResult {
  readonly ok: boolean;
  readonly items?: readonly CopilotTodoItem[];
  readonly activeTitle?: string;
  readonly remaining?: number;
  readonly error?: string;
}

/** Build the checklist writer. A missing `save` rejects the call. */
export function createCopilotTodoTool(deps: {
  readonly save?: (items: readonly CopilotTodoItem[]) => Promise<void>;
}): Tool<{ items: CopilotTodoItem[] }, ExperienceCopilotTodoResult> {
  const { save } = deps;
  return tool({
    description:
      "Maintain the quick checklist of SMALL tasks for the CURRENT session (this thread only — it does not survive sessions). " +
      "Send the FULL list every call (rewrite semantics, not incremental) as {items: [...]}. " +
      "One item should be `active` — the step you are on now. " +
      "For serious multi-step work with a durable goal, use the `plan` tool instead (the plan survives sessions and carries a goal); keep `todo` for the session's small tasks.",
    // Object root (2026-08-21 incident): a bare-array inputSchema made models
    // emit `{}` — tool-calling arguments are JSON objects, and providers
    // reject/never produce a non-object root — so every call failed
    // validation ("expected array, received object") and the turn died.
    inputSchema: z.object({
      items: copilotTodoListSchema.describe("The FULL rewritten todo list — every item, every time."),
    }),
    execute: async ({ items }): Promise<ExperienceCopilotTodoResult> => {
      const toolName = "todo";
      logger.info("%s IN items=%d", toolName, items.length);
      if (save === undefined) {
        logger.warn("%s REJECTED no saveTodo writer wired", toolName);
        throw new Error(`${toolName}: no todo writer wired — saveTodo is required for this tool`);
      }
      try {
        await save(items);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("%s FAIL message=%s", toolName, message);
        return { ok: false, error: message };
      }
      const activeTitle = items.find((i) => i.status === "active")?.title;
      const remaining = items.filter((i) => i.status === "pending" || i.status === "active").length;
      logger.info("%s OK items=%d remaining=%d activeTitle=%s", toolName, items.length, remaining, activeTitle ?? "(none)");
      return { ok: true, items, activeTitle, remaining };
    },
  });
}
