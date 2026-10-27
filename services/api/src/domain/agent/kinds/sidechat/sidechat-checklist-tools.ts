/**
 * The sidechat-OOC kind's checklist and branch-plan read tools (SIDECHAT_PLAN
 * Wave 3 / SC-12) — the last two Wave-3 toggles. Neither tool is authored
 * here: both are the SHARED factories REUSED as-is, which is the unit's point
 * (no fork — the acceptance probes for a copied implementation):
 *
 * - `todo` — the standalone session-checklist factory
 *   (`interactive/copilot/copilot-todo-tool.ts`): the same
 *   description/schema/result envelope the experience copilot serves, the
 *   full-list rewrite persisted through the injected writer (the stream wires
 *   `ExperienceCopilotStore.updateTodo(threadId, items)` — the thread row's
 *   own checklist column). SC-13 renders checklists through the SAME
 *   `parseAgentToolOutput` path the experience kind's panel uses, so the
 *   output shape stays byte-identical by construction.
 * - `read_plan` — the shared agent-plan tools in READ-ONLY mode
 *   (`agent-plan/agent-plan-tools.ts`, SC-0h): `createAgentPlanTools(...,
 *   { readOnly: true, owner })` builds ONLY `read_plan` — the branch-plan
 *   write is reserved for the director kind (owner ruling 7), so no `plan`
 *   tool is ever handed to the sidechat model.
 *
 * The plan OWNER is the caller's thread-row pair (chat + branch), never the
 * request — the stream derives it from the thread row and passes it here; this
 * module only projects it into the `chatBranch` owner the plan store reads.
 *
 * Gating mirrors the search pair and `propose_objective` exactly: `toolSet` is
 * the RESOLVED profile's set (the kind's toggles, SC-5), and a tool whose key
 * is not enabled is not served — a tool landed with its toggle off is not
 * landed.
 */

import type { ToolSet } from "ai";
import type { AgentPlan, AgentPlanOwner } from "@vibe-tavern/domain";
import type { CopilotTodoItem } from "@vibe-tavern/api-contracts";
import { createCopilotTodoTool } from "../../../interactive/copilot/copilot-todo-tool.js";
import { createAgentPlanTools } from "../../../agent-plan/agent-plan-tools.js";

/** Build the sidechat's `todo` + `read_plan`.
 *
 *  `saveTodo` is the thread-store writer (the stream closes over the turn's
 *  thread row — `updateTodo(threadId, items)`, the same seam the experience
 *  kind wires); `agentPlans` is the shared plan store's READ seam (the
 *  sidechat never writes a branch plan). */
export function buildSidechatChecklistTools(input: {
  /** The RESOLVED profile's tool set (the kind's toggles, SC-5). */
  readonly toolSet: Record<string, boolean>;
  /** The thread row's own chat + branch — the plan owner. Derived by the
   *  stream from the THREAD ROW (never the request). */
  readonly owner: { readonly chatId: string; readonly branchId: string };
  /** The checklist's full-list-rewrite writer (thread store `updateTodo`). */
  readonly saveTodo: (items: readonly CopilotTodoItem[]) => Promise<void>;
  /** The shared agent-plan store's read seam. */
  readonly agentPlans: { get(owner: AgentPlanOwner): Promise<AgentPlan | null> };
}): ToolSet {
  const branchOwner: AgentPlanOwner = {
    kind: "chatBranch",
    chatId: input.owner.chatId,
    branchId: input.owner.branchId,
  };

  const allTools: ToolSet = {
    // REUSED factory — never cloned: the description, schema and result
    // envelope are the shared tool's, byte-identical.
    todo: createCopilotTodoTool({ save: input.saveTodo }),

    // REUSED shared plan tools, read-only: the set this spreads carries
    // exactly `read_plan` (readOnly builds no `plan` tool). The `save` dep
    // exists only because the shared factory's signature serves read-write
    // callers too — under readOnly it is unreachable, so the stub refuses
    // loudly if that ever changes shape.
    ...createAgentPlanTools(
      {
        load: () => input.agentPlans.get(branchOwner),
        save: async () => {
          throw new Error("plan: the sidechat serves no plan-write tool (SC-12 readOnly)");
        },
      },
      { readOnly: true, owner: branchOwner },
    ),
  };

  // The kind's toggles (the resolved profile's set): only enabled keys are
  // served — the same filter the search pair and propose_objective apply.
  return Object.fromEntries(
    Object.entries(allTools).filter(([name]) => input.toolSet[name] === true),
  );
}
