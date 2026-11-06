/**
 * Sidechat record-proposal resolution (SIDECHAT_PLAN Wave 3 / SC-11;
 * generalized by DIRECTOR_MODE_PLAN DR-5) — the apply/reject logic behind
 * `POST /api/agent/threads/:threadId/proposals/:toolCallId/{apply,reject}`.
 *
 * Both decisions share one resolution pipeline, in this order:
 *
 * 1. the THREAD: loaded by id; it must be a CHAT-OWNED `sidechat-ooc`
 *    thread — anything else (missing, script-owned, another kind) is a 404
 *    (a thread this kind cannot own is not this route's proposal source).
 * 2. the TOOL ROW: `toolCallId` must address a `role: "tool"` row of THAT
 *    thread whose persisted `{ toolName, output }` payload is a
 *    `RecordProposal` whose `recordType` has an entry in the ONE registry
 *    ({@link SIDECHAT_RECORD_PROPOSAL_REGISTRY} — G1) and whose toolName and
 *    payload match that entry — a foreign toolCallId, a non-proposal row, or
 *    a corrupt payload is a 404, never a 5xx. An UNKNOWN recordType (a row
 *    some future tool wrote that this server cannot resolve) is the typed
 *    422 {@link SIDECHAT_UNKNOWN_RECORD_TYPE_CODE}, refused BEFORE any write.
 * 3. the STATUS: only a `pending` proposal may be resolved — an already
 *    `applied`/`rejected` one is the typed 409
 *    `objective_proposal_already_resolved` (double click, second tab), and
 *    nothing is written anywhere.
 * 4. the DECISION: `reject` writes ONLY the status. `apply` hands the
 *    proposal to the recordType's registry handler — the objective handler
 *    reuses the insights services verbatim (SC-11), the story-plan and
 *    tracker-scene handlers (DR-5) delegate to `StoryPlanSync` and the
 *    insights adapter's shared template tail, and the message-edit /
 *    message-variant handlers (DMT-22) run the ordinary chat edit /
 *    add-variant services over the thread's own branch. The services are
 *    injected (never re-implemented here, never altered in the insights
 *    area).
 * 5. the WRITE: the status rides back into the SAME tool row through
 *    `setToolResultOutput`, preserving the row's parseable
 *    `{ toolName, output }` wrapper and every proposal field (only `status`
 *    changes) — so a reload shows the resolution.
 *
 * The domain write happens BEFORE the status write on purpose: a status
 * write followed by a failed service call would strand the proposal as
 * `applied` with nothing added. The reverse (service success, status write
 * returning null because the row vanished mid-flight) leaves the tracker
 * item standing with no pending row left to re-apply — the 404 the caller
 * then gets reports the vanished row, and the item is visible in the
 * tracker UI either way.
 *
 * Both decisions also return the refreshed companion data the review card
 * needs ({@link SidechatProposalCompanion}): the target branch's plan for
 * plan-touching types, the insights config patch for the tracker-scene
 * type, and (DMT-22) the target-scoped message view for the message-edit /
 * message-variant types. The objective handler under NO plan returns no
 * companion — today's `{ proposal }` response, byte-identical (the SC-11
 * suite is characterization).
 *
 * CONCURRENCY: the pending-check and the writes are serialized per
 * (thread, toolCallId) by an in-process FIFO — the single-process server
 * makes one process the whole world for a proposal row, so a racing double
 * click always resolves sequentially and the second caller observes the
 * first's status (409), never a second tracker write.
 */

import {
  EMPTY_AGENT_PLAN,
  OBJECTIVE_MODE,
  type AgentPlan,
  type AgentPlanOwner,
  type TrackerTemplate,
} from "@vibe-tavern/domain";
import type { Chat, ExperienceCopilotMessage, ExperienceCopilotThread, Message, MessageVariant } from "@vibe-tavern/db";
import type {
  AgentThreadProposalApplyRequest,
  RecordProposal,
} from "@vibe-tavern/api-contracts";
import { conflict, notFound, unprocessable } from "../../shared/errors.js";
import {
  OBJECTIVE_RECORD_TYPE,
  SIDECHAT_OBJECTIVE_TOOL_NAME,
} from "../agent/kinds/sidechat/sidechat-objective-tools.js";
import {
  SIDECHAT_PROPOSE_PLAN_TOOL_NAME,
  SIDECHAT_PROPOSE_TRACKER_TEMPLATE_TOOL_NAME,
  STORY_PLAN_RECORD_TYPE,
  TRACKER_SCENE_RECORD_TYPE,
} from "../agent/kinds/sidechat/sidechat-director-tools.js";
import { DIRECTOR_MESSAGE_PROPOSAL_ENTRIES } from "../director/director-message-proposals.js";

/** Typed 409 code for a tracker that is off at Accept time (the plan's own
 *  spelling — lowercase, the `not_an_rp_chat` family). */
export const OBJECTIVE_TRACKER_DISABLED_CODE = "objective_tracker_disabled";

/** Typed 409 code for resolving an already-resolved proposal (the repeat
 *  apply/reject refusal — same lowercase family). */
export const OBJECTIVE_PROPOSAL_ALREADY_RESOLVED_CODE = "objective_proposal_already_resolved";

/** Typed 422 code for a persisted proposal whose `recordType` has no registry
 *  entry — a row this server cannot resolve (version skew), refused before
 *  any write (DR-5). */
export const SIDECHAT_UNKNOWN_RECORD_TYPE_CODE = "unknown_proposal_record_type";

/** Which decision the route carries. */
export type SidechatRecordProposalDecision = "apply" | "reject";

/** Structural deps — the stores by their method shapes (the concrete
 *  `ExperienceCopilotStore` / `ChatStore` / `AgentPlanStore` satisfy them
 *  without adapters) and the REUSED domain services. `addObjectiveTask` is
 *  the runtime member behind `POST /api/chats/:chatId/insights/objective/tasks`;
 *  `addShortTermGoal` is `ObjectiveService.addShortTermGoal` — the service
 *  behind `POST /api/chats/:chatId/insights/objective/short-term` (both take
 *  plain strings; the branded id is applied at the adapter edge).
 *  DR-5 adds the director seams: `insertNextStoryEvent` /
 *  `applyStoryPlan` are `StoryPlanSync.insertNextEvent` / `applyPlan` (the
 *  normalize-or-422, save and ACTIVE-branch projection live in the service),
 *  `updateObjectiveConfig` is `ObjectiveService.updateObjectiveConfig` (A6's
 *  auto-check switch), `applyTrackerScene` is the insights adapter's shared
 *  template tail (`applyTrackerSceneTemplate`), and `readInsightsPatch` is
 *  the read-only config patch a reject returns. DMT-22 adds the message
 *  seams: `messages` is the plain store read trio the message handlers'
 *  ownership revalidation + companion run through, `editMessage` is
 *  `ChatApplicationService.editMessage` WITH the expected base content (the
 *  store-transactional selected-variant + same-id content guards), and
 *  `addEditorVariant` is `ChatApplicationService.addEditorVariant` (source
 *  existence checks; no provenance input on the Director save). */
export interface SidechatRecordProposalDeps {
  readonly store: {
    getById(threadId: string): Promise<ExperienceCopilotThread | null>;
    listMessages(threadId: string): Promise<readonly ExperienceCopilotMessage[]>;
    setToolResultOutput(
      threadId: string,
      toolCallId: string,
      payload: { toolName: string; output: unknown },
    ): Promise<ExperienceCopilotMessage | null>;
  };
  readonly chats: {
    getById(chatId: string): Promise<Chat | null>;
  };
  readonly agentPlans: {
    get(owner: AgentPlanOwner): Promise<AgentPlan | null>;
  };
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
  ) => Promise<unknown>;
  readonly readInsightsPatch: (chatId: string) => Promise<unknown>;
  /** The narrow RP-message reads (DMT-22) — a structural Pick of the real
   *  `MessageStore`, satisfied by the container's `messages` member. */
  readonly messages: {
    getMessages(branchId: string): Promise<Message[]>;
    getMessageById(id: string): Promise<Message | null>;
    getVariants(messageId: string): Promise<MessageVariant[]>;
  };
  /** The ordinary guarded edit WITH the reviewed base content (DMT-22) —
   *  throws the 409-class conflict when the selected variant id or its
   *  content no longer matches. */
  readonly editMessage: (
    messageId: string,
    content: string,
    expectedVariantId?: string,
    expectedBaseContent?: string,
  ) => Promise<unknown>;
  /** The ordinary add-editor-variant path (DMT-22) — validates the source
   *  variant ids exist on the message; provenance stays unset for a
   *  Director-authored save. */
  readonly addEditorVariant: (
    messageId: string,
    input: { readonly content: string; readonly sourceVariantIds: readonly string[] },
  ) => Promise<unknown>;
}

/** The refreshed data a resolution returns beyond the proposal itself (the
 *  review card's companion — DR-5). Absent for the objective handler under
 *  no plan (today's byte-identical `{ proposal }` response).
 *
 *  `patch` is opaque here: the domain layer cannot import the api contract
 *  (the layer rule), so the seams' `ConfigPatchResponse` value passes
 *  through untyped and the adapter — which wired the producing seam —
 *  narrows it at its edge. */
export interface SidechatProposalCompanion {
  /** The target branch's refreshed plan — the story-plan handler (both
   *  decisions) and the objective handler under a plan with events. */
  readonly plan?: AgentPlan;
  /** The refreshed insights config patch — the tracker-scene companion. */
  readonly patch?: unknown;
  /** The refreshed TARGET-SCOPED message view (DMT-22) — the message-edit /
   *  message-variant companion on an accepted resolution. */
  readonly message?: SidechatProposalMessageCompanion;
}

/** The DMT-22 message companion — ONLY the affected message, never a
 *  branch/chat snapshot a client could merge over a different open chat.
 *  `chatId`/`branchId` scope it (the client refuses to ingest it when its
 *  open conversation differs); `message` is the row post-write; `variants`
 *  is the message's FULL variant list post-write (a Save appends + selects,
 *  an Apply rewrites the selected variant's text). */
export interface SidechatProposalMessageCompanion {
  readonly chatId: string;
  readonly branchId: string;
  readonly message: {
    readonly id: string;
    readonly position: number;
    readonly content: string;
    readonly updatedAt: string;
  };
  readonly variants: readonly {
    readonly id: string;
    readonly variantIndex: number;
    readonly content: string;
    readonly isSelected: boolean;
    readonly modelId: string | null;
    readonly presetName: string | null;
  }[];
}

/** Everything one recordType's handlers resolve against. */
export interface SidechatProposalHandlerContext {
  readonly deps: SidechatRecordProposalDeps;
  /** The owning thread's chat (chat-owned by step 1). */
  readonly chatId: string;
  /** The owning thread's OWN branch — the message handlers'
   *  ownership-revalidation scope (DMT-22). Null on corrupt rows (a
   *  chat-owned sidechat thread always carries one); the message handlers
   *  refuse the same 404 then. The other handlers ignore it. */
  readonly branchId: string | null;
  readonly proposal: RecordProposal;
  /** The apply request body (`.enableAutoCheck` — only the story-plan
   *  handler reads it; reject ignores it). */
  readonly body: AgentThreadProposalApplyRequest;
}

/** One registry entry (G1 — the one dispatch table): how a recordType's
 *  rows are recognized, and what its apply/reject do. */
export interface SidechatRecordProposalEntry {
  /** The `toolName` a row of this type carries — a row whose toolName
   *  differs is another tool's result and 404s (the SC-11 parse gate,
   *  generalized). Also the toolName the status write preserves. */
  readonly toolName: string;
  /** Pin the proposal for this type AFTER the registry lookup (op + payload
   *  shape). A row that does not match is a corrupt payload → 404, never a
   *  5xx. */
  readonly matches: (proposal: RecordProposal) => boolean;
  /** The domain write on Accept. Runs BEFORE the status write; a throw
   *  leaves the row `pending` (nothing resolved). Returns the companion
   *  data for the response, or undefined for today's bare `{ proposal }`. */
  readonly apply: (
    ctx: SidechatProposalHandlerContext,
  ) => Promise<SidechatProposalCompanion | undefined>;
  /** Reject: NO domain write — only this type's read-only companion. */
  readonly reject: (ctx: SidechatProposalHandlerContext) => Promise<SidechatProposalCompanion>;
}

/** Load the thread and confirm it is a chat-owned `sidechat-ooc` row — the
 *  kind whose proposals this module resolves. Everything else is the same
 *  404 a missing thread gets: this route has no proposal to name there. */
async function loadSidechatThread(
  deps: SidechatRecordProposalDeps,
  threadId: string,
): Promise<ExperienceCopilotThread & { chatId: string; agentKind: string }> {
  const thread = await deps.store.getById(threadId);
  if (!thread) {
    throw notFound("ExperienceCopilotThread", `Copilot thread '${threadId}' was not found.`);
  }
  if (thread.agentKind !== "sidechat-ooc" || thread.chatId === null) {
    throw notFound(
      "ExperienceCopilotThread",
      `Thread '${threadId}' carries no sidechat objective proposal.`,
    );
  }
  return thread as ExperienceCopilotThread & { chatId: string; agentKind: string };
}

/** Structural guard for the record-proposal literal fields the resolution
 *  reads (the `isRecordProposal` sibling in api-contracts narrows the
 *  `AgentProposal` union; this one checks a bare `unknown` row payload). */
function isRecordProposalShape(
  value: unknown,
): value is RecordProposal {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === "record" &&
    typeof candidate.id === "string" &&
    typeof candidate.recordType === "string" &&
    (candidate.op === "create" || candidate.op === "update" || candidate.op === "delete") &&
    typeof candidate.status === "string" &&
    (candidate.status === "pending" || candidate.status === "applied" || candidate.status === "rejected")
  );
}

// ─── The objective handler's plan rule (R3) ──────────────────────────────────

/** The ACTIVE branch's plan, when it has events — else null. The objective
 *  handler's behavior switch (DR-5): a proposal under such a plan becomes
 *  the next plan EVENT instead of a tracker item. */
async function activeBranchPlanWithEvents(
  deps: SidechatRecordProposalDeps,
  chat: Chat,
): Promise<AgentPlan | null> {
  const plan = await deps.agentPlans.get({
    kind: "chatBranch",
    chatId: chat.id,
    branchId: chat.activeBranchId,
  });
  return plan !== null && plan.tasks.length > 0 ? plan : null;
}

/** The objective resolution's plan companion: the ACTIVE branch's plan when
 *  it has events, else no companion (the byte-identical `{ proposal }`
 *  response of the no-plan path — SC-11's characterization). */
async function objectivePlanCompanion(
  deps: SidechatRecordProposalDeps,
  chatId: string,
): Promise<SidechatProposalCompanion> {
  const chat = await deps.chats.getById(chatId);
  if (!chat) {
    throw notFound("Chat", `Chat '${chatId}' was not found.`);
  }
  const plan = await activeBranchPlanWithEvents(deps, chat);
  return plan !== null ? { plan } : {};
}

// ─── The one registry (G1) ───────────────────────────────────────────────────

/**
 * THE recordType dispatch table (G1 — DIRECTOR_MODE_PLAN DR-5): one exported,
 * typed map from `recordType` to its recognition + apply/reject handlers.
 * The resolution pipeline ({@link resolveSidechatRecordProposal}) is the
 * ONLY caller of these entries — the route never branches on recordType,
 * and a second dispatch over proposal types would be a defect from copy #2.
 *
 * Entries:
 *  - `objective` — SC-11's behavior: no plan → the tracker add for the
 *    Accept-time mode (byte-identical); a plan with events on the ACTIVE
 *    branch → `StoryPlanSync.insertNextEvent` with the goal text (R3),
 *    never a tracker item.
 *  - `story-plan` — `StoryPlanSync.applyPlan(chatId, payload-branch, plan)`
 *    (normalize-or-422 + save + ACTIVE-branch projection); `enableAutoCheck`
 *    in the apply body also sets the tracker's auto-check frequency to 1 (A6).
 *  - `tracker-scene` — the insights adapter's shared template tail with
 *    `{ scene, objective: null }` (scene only — goals come from the plan, A9).
 *  - `message-edit` / `message-variant` (DMT-22) — defined in
 *    `director/director-message-proposals.ts` and spread in here: the
 *    ordinary guarded chat edit / add-variant services over the thread's own
 *    branch, with the transactional selected-variant + reviewed-base guards.
 */
export const SIDECHAT_RECORD_PROPOSAL_REGISTRY: Readonly<
  Record<string, SidechatRecordProposalEntry>
> = {
  [OBJECTIVE_RECORD_TYPE]: {
    toolName: SIDECHAT_OBJECTIVE_TOOL_NAME,
    matches: (proposal) =>
      proposal.op === "create" &&
      typeof proposal.payload === "object" &&
      proposal.payload !== null &&
      typeof (proposal.payload as { description?: unknown }).description === "string",
    apply: async ({ deps, chatId, proposal }) => {
      // Accept-time tracker resolution — read NOW, not at proposal time
      // (the user may have switched modes or turned the tracker off since).
      const chat = await deps.chats.getById(chatId);
      if (!chat) {
        throw notFound("Chat", `Chat '${chatId}' was not found.`);
      }
      if (!chat.insightsConfig.objectiveEnabled) {
        throw conflict(
          "The Objective Tracker is disabled for this chat; the proposal cannot be applied.",
          { code: OBJECTIVE_TRACKER_DISABLED_CODE },
        );
      }
      const description = (proposal.payload as { description: string }).description;
      // R3 (DR-5): under a plan with events on the ACTIVE branch, the
      // proposal becomes the NEXT plan event — inserted after the current
      // one and applied through the plan (save + projection), never a
      // tracker item. The event's title is the goal text verbatim; the body
      // stays empty so the projected goal text equals what a tracker add
      // would have written (A3's rule).
      const plan = await activeBranchPlanWithEvents(deps, chat);
      if (plan !== null) {
        const nextPlan = await deps.insertNextStoryEvent(
          chat.id,
          chat.activeBranchId,
          { title: description, body: "" },
        );
        return { plan: nextPlan };
      }
      if (chat.insightsObjectiveState.mode === OBJECTIVE_MODE.goals) {
        await deps.addShortTermGoal(chat.id, description);
      } else {
        await deps.addObjectiveTask(chat.id, { description });
      }
      return undefined;
    },
    reject: async ({ deps, chatId }) => objectivePlanCompanion(deps, chatId),
  },

  [STORY_PLAN_RECORD_TYPE]: {
    toolName: SIDECHAT_PROPOSE_PLAN_TOOL_NAME,
    matches: (proposal) =>
      proposal.op === "update" &&
      typeof proposal.targetId === "string" &&
      typeof proposal.payload === "object" &&
      proposal.payload !== null &&
      typeof (proposal.payload as { plan?: unknown }).plan === "object" &&
      (proposal.payload as { plan?: unknown }).plan !== null,
    apply: async ({ deps, chatId, proposal, body }) => {
      // The payload-branch is the proposal's targetId — the branch the
      // director's tool recorded when proposing (applyPlan's own ownership
      // check 404s a foreign/vanished branch BEFORE any write).
      const branchId = proposal.targetId as string;
      const plan = await deps.applyStoryPlan(
        chatId,
        branchId,
        (proposal.payload as { plan: unknown }).plan,
      );
      // A6: the apply-time auto-check switch — only when the body asked for
      // it; a missing body or `false` leaves the config untouched.
      if (body.enableAutoCheck === true) {
        await deps.updateObjectiveConfig(chatId, { autoCheckFrequency: 1 });
      }
      return { plan };
    },
    reject: async ({ deps, chatId, proposal }) => ({
      plan:
        (await deps.agentPlans.get({
          kind: "chatBranch",
          chatId,
          branchId: (proposal.targetId as string),
        })) ?? EMPTY_AGENT_PLAN,
    }),
  },

  [TRACKER_SCENE_RECORD_TYPE]: {
    toolName: SIDECHAT_PROPOSE_TRACKER_TEMPLATE_TOOL_NAME,
    matches: (proposal) =>
      proposal.op === "update" &&
      typeof proposal.payload === "object" &&
      proposal.payload !== null &&
      isSceneTemplateShape((proposal.payload as { scene?: unknown }).scene),
    apply: async ({ deps, chatId, proposal }) => {
      const patch = await deps.applyTrackerScene(
        chatId,
        (proposal.payload as { scene: NonNullable<TrackerTemplate["scene"]> }).scene,
      );
      return { patch };
    },
    reject: async ({ deps, chatId }) => ({ patch: await deps.readInsightsPatch(chatId) }),
  },

  // DMT-22: the Director's two reviewable message tools resolve through the
  // SAME pipeline — the entries (recognition via the DMT-11 payload schemas,
  // the ordinary guarded edit / add-variant services, the target-scoped
  // message companion) live in the handlers' own module.
  ...DIRECTOR_MESSAGE_PROPOSAL_ENTRIES,
};

/** Structural check for a scene template half (the tracker-scene payload):
 * an object with a boolean `enabled` and an object `config`. The full
 * config normalization happens inside the apply tail, as for every
 * template apply. */
function isSceneTemplateShape(value: unknown): value is NonNullable<TrackerTemplate["scene"]> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { enabled?: unknown; config?: unknown };
  return (
    typeof candidate.enabled === "boolean" &&
    typeof candidate.config === "object" &&
    candidate.config !== null
  );
}

/** Parse the proposal out of a persisted tool row and resolve its registry
 *  entry. A row that is not a proposal result (foreign tool, hand-corrupted
 *  payload, an unknown record type for the wrong tool) is a 404: the route
 *  addresses proposals, and this row is not one it can resolve. A
 *  well-formed record proposal whose `recordType` has NO registry entry is
 *  the typed 422 {@link SIDECHAT_UNKNOWN_RECORD_TYPE_CODE} — refused before
 *  any write (DR-5). */
function parseRecordProposal(
  row: ExperienceCopilotMessage,
): { proposal: RecordProposal; entry: SidechatRecordProposalEntry } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.content);
  } catch {
    throw notFound(
      "ExperienceCopilotThread",
      `Tool row '${row.toolCallId ?? row.id}' carries no sidechat objective proposal.`,
    );
  }
  const wrapper = typeof parsed === "object" && parsed !== null
    ? (parsed as { toolName?: unknown; output?: unknown })
    : null;
  const output = wrapper?.output;
  if (wrapper === null || !isRecordProposalShape(output)) {
    throw notFound(
      "ExperienceCopilotThread",
      `Tool row '${row.toolCallId ?? row.id}' carries no sidechat objective proposal.`,
    );
  }
  const entry = SIDECHAT_RECORD_PROPOSAL_REGISTRY[output.recordType];
  if (entry === undefined) {
    throw unprocessable(
      `Record type '${output.recordType}' is not a known proposal type.`,
      { code: SIDECHAT_UNKNOWN_RECORD_TYPE_CODE, recordType: output.recordType },
    );
  }
  if (wrapper.toolName !== entry.toolName) {
    throw notFound(
      "ExperienceCopilotThread",
      `Tool call '${row.toolCallId ?? row.id}' is not a ${entry.toolName} call.`,
    );
  }
  if (!entry.matches(output)) {
    throw notFound(
      "ExperienceCopilotThread",
      `Tool row '${row.toolCallId ?? row.id}' carries no sidechat objective proposal.`,
    );
  }
  return { proposal: output, entry };
}

// fork #1 of ObjectiveKeyedCoordinator
// (services/api/src/domain/insights/objective-service.ts — a private class;
// forks: 2 there) — the same promise-tail FIFO, lifted here because the
// source is private and generic enough to be worth one copy per consumer.
// Correspondence: previous/tail chaining, slot release, map cleanup on the
// tail identity — verbatim shape; the key is per-proposal, not per-chat.
const resolutionLocks = new Map<string, Promise<unknown>>();

/** Serialize the resolution of ONE proposal (see CONCURRENCY above). */
async function withProposalLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = resolutionLocks.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => slot);
  resolutionLocks.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release?.();
    if (resolutionLocks.get(key) === tail) resolutionLocks.delete(key);
  }
}

/** One resolution's outcome: the proposal with its final status plus the
 *  recordType's companion data (absent for the no-plan objective path). */
export interface SidechatRecordProposalResolution {
  readonly proposal: RecordProposal;
  readonly companion?: SidechatProposalCompanion;
}

/**
 * Resolve one sidechat record proposal through the ONE pipeline (see the
 * module header): `apply` runs the recordType's registry handler (the
 * domain write) and marks the row `applied`; `reject` only marks it
 * `rejected`. Returns the proposal with its final status and the handler's
 * companion data (the caller's response payload).
 */
export async function resolveSidechatRecordProposal(
  deps: SidechatRecordProposalDeps,
  threadId: string,
  toolCallId: string,
  decision: SidechatRecordProposalDecision,
  body: AgentThreadProposalApplyRequest = {},
): Promise<SidechatRecordProposalResolution> {
  return withProposalLock(`${threadId}:${toolCallId}`, async () => {
    const thread = await loadSidechatThread(deps, threadId);
    // The row lookup mirrors setToolResultOutput's own scoping (this thread,
    // role "tool", the given toolCallId) — a foreign id finds nothing here.
    const messages = await deps.store.listMessages(threadId);
    const row = messages.find((m) => m.role === "tool" && m.toolCallId === toolCallId);
    if (!row) {
      throw notFound(
        "ExperienceCopilotThread",
        `Tool call '${toolCallId}' was not found in thread '${threadId}'.`,
      );
    }
    const { proposal, entry } = parseRecordProposal(row);
    if (proposal.status !== "pending") {
      throw conflict(
        `This objective proposal was already ${proposal.status}.`,
        { code: OBJECTIVE_PROPOSAL_ALREADY_RESOLVED_CODE, status: proposal.status },
      );
    }
    const nextStatus = decision === "apply" ? "applied" : "rejected";

    const ctx: SidechatProposalHandlerContext = {
      deps,
      chatId: thread.chatId,
      // The thread row's OWN branch — the DMT-22 message handlers'
      // ownership scope (never request-supplied). Null on corrupt rows;
      // the handlers that need it refuse the same 404 then.
      branchId: thread.branchId,
      proposal,
      body,
    };
    // The domain write (apply) / the read-only companion (reject) runs
    // BEFORE the status write — a failed write leaves the row pending.
    const companion =
      decision === "apply" ? await entry.apply(ctx) : await entry.reject(ctx);

    const rewritten = await deps.store.setToolResultOutput(threadId, toolCallId, {
      toolName: entry.toolName,
      output: { ...proposal, status: nextStatus },
    });
    if (!rewritten) {
      // The row vanished between the list read and this write: report it the
      // same way a stale toolCallId reports (see the module header's order
      // note for why the domain write is allowed to stand).
      throw notFound(
        "ExperienceCopilotThread",
        `Tool call '${toolCallId}' was not found in thread '${threadId}'.`,
      );
    }
    const resolved: RecordProposal = { ...proposal, status: nextStatus };
    return companion === undefined ? { proposal: resolved } : { proposal: resolved, companion };
  });
}
