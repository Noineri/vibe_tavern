/**
 * Thread proposal resolution adapter (SIDECHAT_PLAN Wave 3 / SC-11;
 * generalized by DIRECTOR_MODE_PLAN DR-5) — the thin wiring behind
 * `POST /api/agent/threads/:threadId/proposals/:toolCallId/{apply,reject}`.
 * Owns NO logic: the whole resolution (thread ownership, toolCallId
 * validation, the recordType dispatch through the one registry, Accept-time
 * tracker state, the reused insights services, the status write through
 * setToolResultOutput) lives in
 * `domain/sidechat/sidechat-objective-proposal.ts`; this class only hands it
 * the REAL stores plus the REUSED domain seams:
 *
 * - `addObjectiveTask` — the insights runtime member behind
 *   `POST /api/chats/:chatId/insights/objective/tasks` (route mode);
 * - `addShortTermGoal` — `ObjectiveService.addShortTermGoal`, the service
 *   behind `POST /api/chats/:chatId/insights/objective/short-term`
 *   (goals mode);
 * - `insertNextStoryEvent` / `applyStoryPlan` — `StoryPlanSync` (R3's
 *   next-event insert; the plan's normalize-or-422 save + ACTIVE-branch
 *   projection);
 * - `updateObjectiveConfig` — `ObjectiveService.updateObjectiveConfig`
 *   (A6's auto-check switch);
 * - `applyTrackerScene` — the insights adapter's shared tracker-template
 *   apply tail (`applyTrackerSceneTemplate`);
 * - `readInsightsPatch` — the read-only active-chat patch a reject returns;
 * - `editMessage` / `addEditorVariant` (DMT-22) — `ChatApplicationService`'s
 *   ordinary guarded edit (with the reviewed base content) and add-variant
 *   path the message-edit / message-variant handlers run through. The RP
 *   message READS need no injection — the stores' `messages` member satisfies
 *   the handlers' narrow read seam directly.
 *
 * The branded ids enter at the seam closures the WIRING creates (the
 * `addShortTermGoal` precedent — see runtime-api-adapter.ts).
 *
 * A dedicated slice (not a member of `ExperienceCopilotAdapter`) per the
 * adapters' composition rule — "create an adapter and wire it here" — which
 * also keeps the big copilot adapter under its size ratchet.
 */
import type { StoreContainer } from "@vibe-tavern/db";
import type { AgentPlan, TrackerTemplate } from "@vibe-tavern/domain";
import type { ConfigPatchResponse } from "../contract/session-types.js";
import type { AgentThreadProposalsRuntimeApi, AgentThreadProposalResolveWire } from "../contract/runtime-api.js";
import type { AgentThreadProposalApplyRequest } from "@vibe-tavern/api-contracts";
import { notFound } from "../../shared/errors.js";
import { resolveSidechatRecordProposal, type SidechatRecordProposalResolution } from "../../domain/sidechat/sidechat-objective-proposal.js";

/** The REUSED domain seams the resolution needs beyond the stores, all
 *  optional TOGETHER so store-only harnesses can construct the adapter —
 *  apply/reject then reports unavailability through the same 404-shaped
 *  seam manual compaction uses (no silent no-op). */
export interface AgentThreadProposalServices {
  readonly addObjectiveTask: (chatId: string, body: { description: string }) => Promise<unknown>;
  readonly addShortTermGoal: (chatId: string, description: string) => Promise<unknown>;
  readonly insertNextStoryEvent: (
    chatId: string,
    branchId: string,
    event: { title: string; body: string },
  ) => Promise<AgentPlan>;
  readonly applyStoryPlan: (chatId: string, branchId: string, plan: unknown) => Promise<AgentPlan>;
  readonly updateObjectiveConfig: (
    chatId: string,
    patch: { autoCheckFrequency: number },
  ) => Promise<unknown>;
  readonly applyTrackerScene: (
    chatId: string,
    scene: NonNullable<TrackerTemplate["scene"]>,
  ) => Promise<ConfigPatchResponse>;
  readonly readInsightsPatch: (chatId: string) => Promise<ConfigPatchResponse>;
  /** DMT-22: the ordinary guarded edit WITH the reviewed base content —
   *  `ChatApplicationService.editMessage` (409-class conflicts on a moved
   *  selection or a newer edit to the same still-selected swipe). */
  readonly editMessage: (
    messageId: string,
    content: string,
    expectedVariantId?: string,
    expectedBaseContent?: string,
  ) => Promise<unknown>;
  /** DMT-22: the ordinary add-variant path — `ChatApplicationService.
   *  addEditorVariant` (source-existence checks; no provenance input). */
  readonly addEditorVariant: (
    messageId: string,
    input: { readonly content: string; readonly sourceVariantIds: readonly string[] },
  ) => Promise<unknown>;
}

export class AgentThreadProposalAdapter implements AgentThreadProposalsRuntimeApi {
  constructor(
    private readonly stores: StoreContainer,
    private readonly proposalServices?: AgentThreadProposalServices,
  ) {}

  /** The resolution deps over the REAL stores + the injected seams (the
   *  wiring's seam closures apply the branded ids where the concrete
   *  services need them — the `addShortTermGoal` precedent). */
  private deps() {
    if (this.proposalServices === undefined) {
      throw notFound(
        "InsightsAdapter",
        "Objective proposal resolution is unavailable (no objective services wired).",
      );
    }
    const services = this.proposalServices;
    return {
      store: this.stores.experienceCopilot,
      chats: this.stores.chats,
      agentPlans: this.stores.agentPlans,
      addObjectiveTask: services.addObjectiveTask,
      addShortTermGoal: services.addShortTermGoal,
      insertNextStoryEvent: services.insertNextStoryEvent,
      applyStoryPlan: services.applyStoryPlan,
      updateObjectiveConfig: services.updateObjectiveConfig,
      applyTrackerScene: services.applyTrackerScene,
      readInsightsPatch: services.readInsightsPatch,
      // DMT-22: the RP-message reads come straight from the stores (the
      // handlers' narrow structural seam); the two write seams are the
      // injected ChatApplicationService members.
      messages: this.stores.messages,
      editMessage: services.editMessage,
      addEditorVariant: services.addEditorVariant,
    };
  }

  /** The wire mapping: the resolution's companion is opaque to the domain
   *  (the layer rule — it cannot import the api contract), but the seams
   *  this adapter wires produce `ConfigPatchResponse` patches; narrow once
   *  here, at the edge that knows the producer. The DMT-22 message
   *  companion passes through as-is (the contract imports the domain type —
   *  one source for the shape). */
  private toWire(resolution: SidechatRecordProposalResolution): AgentThreadProposalResolveWire {
    const { companion, proposal } = resolution;
    if (companion === undefined) return { proposal };
    return {
      proposal,
      ...(companion.plan !== undefined ? { plan: companion.plan } : {}),
      ...(companion.patch !== undefined
        ? { patch: companion.patch as ConfigPatchResponse }
        : {}),
      ...(companion.message !== undefined ? { message: companion.message } : {}),
    };
  }

  /** Accept one pending record proposal (DR-5 dispatch by recordType) — see
   *  the contract member's doc (`experience-copilot-contracts.ts`) for the
   *  typed-error contract. */
  agentThreadApplyProposal = async (
    threadId: string,
    toolCallId: string,
    body: AgentThreadProposalApplyRequest,
  ): Promise<AgentThreadProposalResolveWire> =>
    this.toWire(
      await resolveSidechatRecordProposal(this.deps(), threadId, toolCallId, "apply", body),
    );

  /** Reject one pending record proposal: write nothing to the domain, only
   *  the row's status. */
  agentThreadRejectProposal = async (
    threadId: string,
    toolCallId: string,
  ): Promise<AgentThreadProposalResolveWire> =>
    this.toWire(
      await resolveSidechatRecordProposal(this.deps(), threadId, toolCallId, "reject"),
    );
}
