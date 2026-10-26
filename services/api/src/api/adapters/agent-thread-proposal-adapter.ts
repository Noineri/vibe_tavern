/**
 * Thread proposal resolution adapter (SIDECHAT_PLAN Wave 3 / SC-11) — the
 * thin wiring behind `POST /api/agent/threads/:threadId/proposals/:toolCallId/
 * {apply,reject}`. Owns NO logic: the whole resolution (thread ownership,
 * toolCallId validation, Accept-time tracker state, the reused insights
 * services, the status write through setToolResultOutput) lives in
 * `domain/sidechat/sidechat-objective-proposal.ts`; this class only hands it
 * the REAL stores plus the two REUSED insights seams:
 *
 * - `addObjectiveTask` — the insights runtime member behind
 *   `POST /api/chats/:chatId/insights/objective/tasks` (route mode);
 * - `addShortTermGoal` — `ObjectiveService.addShortTermGoal`, the service
 *   behind `POST /api/chats/:chatId/insights/objective/short-term`
 *   (goals mode; the branded chat id enters at this adapter edge).
 *
 * A dedicated slice (not a member of `ExperienceCopilotAdapter`) per the
 * adapters' composition rule — "create an adapter and wire it here" — which
 * also keeps the big copilot adapter under its size ratchet.
 */
import type { StoreContainer } from "@vibe-tavern/db";
import type { AgentThreadProposalsRuntimeApi, AgentThreadProposalResolveWire } from "../contract/runtime-api.js";
import { notFound } from "../../shared/errors.js";
import {
  resolveSidechatObjectiveProposal,
  type SidechatObjectiveProposalDeps,
} from "../../domain/sidechat/sidechat-objective-proposal.js";

export class AgentThreadProposalAdapter implements AgentThreadProposalsRuntimeApi {
  constructor(
    private readonly stores: StoreContainer,
    /** The REUSED insights services (SC-11): the insights runtime's add-task
     *  member and the ObjectiveService's short-term adder. Optional so
     *  store-only harnesses can construct the adapter without them
     *  (apply/reject then reports unavailability through the same 404-shaped
     *  seam manual compaction uses — no silent no-op). */
    private readonly objectiveServices?: {
      addObjectiveTask: (chatId: string, body: { description: string }) => Promise<unknown>;
      addShortTermGoal: (chatId: string, description: string) => Promise<unknown>;
    },
  ) {}

  /** The resolution deps over the REAL stores + the injected seams. */
  private deps(): SidechatObjectiveProposalDeps {
    if (this.objectiveServices === undefined) {
      throw notFound(
        "InsightsAdapter",
        "Objective proposal resolution is unavailable (no objective services wired).",
      );
    }
    return {
      store: this.stores.experienceCopilot,
      chats: this.stores.chats,
      addObjectiveTask: this.objectiveServices.addObjectiveTask,
      addShortTermGoal: this.objectiveServices.addShortTermGoal,
    };
  }

  /** Accept one pending sidechat objective proposal — see the contract
   *  member's doc (`experience-copilot-contracts.ts`) for the typed-error
   *  contract. */
  agentThreadApplyObjectiveProposal = async (
    threadId: string,
    toolCallId: string,
  ): Promise<AgentThreadProposalResolveWire> => {
    const proposal = await resolveSidechatObjectiveProposal(this.deps(), threadId, toolCallId, "apply");
    return { proposal };
  };

  /** Reject one pending sidechat objective proposal — writes nothing to the
   *  tracker, only the row's status. */
  agentThreadRejectObjectiveProposal = async (
    threadId: string,
    toolCallId: string,
  ): Promise<AgentThreadProposalResolveWire> => {
    const proposal = await resolveSidechatObjectiveProposal(this.deps(), threadId, toolCallId, "reject");
    return { proposal };
  };
}
