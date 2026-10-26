/**
 * Sidechat objective-proposal resolution (SIDECHAT_PLAN Wave 3 / SC-11) —
 * the apply/reject logic behind
 * `POST /api/agent/threads/:threadId/proposals/:toolCallId/{apply,reject}`.
 *
 * Both decisions share one resolution pipeline, in this order:
 *
 * 1. the THREAD: loaded by id; it must be a CHAT-OWNED `sidechat-ooc`
 *    thread — anything else (missing, script-owned, another kind) is a 404
 *    (a thread this kind cannot own is not this route's proposal source).
 * 2. the TOOL ROW: `toolCallId` must address a `role: "tool"` row of THAT
 *    thread whose persisted `{ toolName, output }` payload is a
 *    `propose_objective` result shaped as an `objective`/`create`
 *    `RecordProposal` — a foreign toolCallId, a non-proposal row, or a
 *    corrupt payload is a 404, never a 5xx.
 * 3. the STATUS: only a `pending` proposal may be resolved — an already
 *    `applied`/`rejected` one is the typed 409
 *    `objective_proposal_already_resolved` (double click, second tab), and
 *    nothing is written anywhere.
 * 4. the DECISION: `reject` writes ONLY the status. `apply` reads the
 *    tracker at ACCEPT time — `chat.insightsConfig.objectiveEnabled` (off →
 *    the typed 409 `objective_tracker_disabled`) and
 *    `chat.insightsObjectiveState.mode` (the CURRENT mode wins over the
 *    proposal-time one) — then reuses the insights services verbatim:
 *    `route` the add-task service (`runtime.addObjectiveTask`), `goals` the
 *    add-short-term-goal service (`ObjectiveService.addShortTermGoal`).
 *    The services are injected (never re-implemented here, never altered in
 *    the insights area).
 * 5. the WRITE: the status rides back into the SAME tool row through
 *    `setToolResultOutput`, preserving the row's parseable
 *    `{ toolName, output }` wrapper and every proposal field (only `status`
 *    changes) — so a reload shows the resolution.
 *
 * The tracker write happens BEFORE the status write on purpose: a status
 * write followed by a failed service call would strand the proposal as
 * `applied` with nothing added. The reverse (service success, status write
 * returning null because the row vanished mid-flight) leaves the tracker
 * item standing with no pending row left to re-apply — the 404 the caller
 * then gets reports the vanished row, and the item is visible in the
 * tracker UI either way.
 *
 * CONCURRENCY: the pending-check and the writes are serialized per
 * (thread, toolCallId) by an in-process FIFO — the single-process server
 * makes one process the whole world for a proposal row, so a racing double
 * click always resolves sequentially and the second caller observes the
 * first's status (409), never a second tracker write.
 */

import { OBJECTIVE_MODE } from "@vibe-tavern/domain";
import type { Chat, ExperienceCopilotMessage, ExperienceCopilotThread } from "@vibe-tavern/db";
import type { RecordProposal } from "@vibe-tavern/api-contracts";
import { conflict, notFound } from "../../shared/errors.js";
import { SIDECHAT_OBJECTIVE_TOOL_NAME } from "../agent/kinds/sidechat/sidechat-objective-tools.js";

/** Typed 409 code for a tracker that is off at Accept time (the plan's own
 *  spelling — lowercase, the `not_an_rp_chat` family). */
export const OBJECTIVE_TRACKER_DISABLED_CODE = "objective_tracker_disabled";

/** Typed 409 code for resolving an already-resolved proposal (the repeat
 *  apply/reject refusal — same lowercase family). */
export const OBJECTIVE_PROPOSAL_ALREADY_RESOLVED_CODE = "objective_proposal_already_resolved";

/** Which decision the route carries. */
export type SidechatObjectiveProposalDecision = "apply" | "reject";

/** Structural deps — the stores by their method shapes (the concrete
 *  `ExperienceCopilotStore` / `ChatStore` satisfy them without adapters)
 *  and the two REUSED insights services. `addObjectiveTask` is the runtime
 *  member behind `POST /api/chats/:chatId/insights/objective/tasks`;
 *  `addShortTermGoal` is `ObjectiveService.addShortTermGoal` — the service
 *  behind `POST /api/chats/:chatId/insights/objective/short-term`. Both
 *  take plain strings; the branded id is applied HERE (the db-edge rule). */
export interface SidechatObjectiveProposalDeps {
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
  readonly addObjectiveTask: (chatId: string, body: { description: string }) => Promise<unknown>;
  readonly addShortTermGoal: (chatId: string, description: string) => Promise<unknown>;
}

/** Load the thread and confirm it is a chat-owned `sidechat-ooc` row — the
 *  kind whose proposals this module resolves. Everything else is the same
 *  404 a missing thread gets: this route has no proposal to name there. */
async function loadSidechatThread(
  deps: SidechatObjectiveProposalDeps,
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

/** Parse the proposal out of a persisted tool row. A row that is not a
 *  `propose_objective` result (foreign tool, hand-corrupted payload, or a
 *  proposal over another record type) is a 404: the route addresses
 *  proposals, and this row is not one. */
function parseObjectiveProposal(row: ExperienceCopilotMessage): RecordProposal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.content);
  } catch {
    throw notFound(
      "ExperienceCopilotThread",
      `Tool row '${row.toolCallId ?? row.id}' carries no sidechat objective proposal.`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { toolName?: unknown }).toolName !== SIDECHAT_OBJECTIVE_TOOL_NAME
  ) {
    throw notFound(
      "ExperienceCopilotThread",
      `Tool call '${row.toolCallId ?? row.id}' is not a ${SIDECHAT_OBJECTIVE_TOOL_NAME} call.`,
    );
  }
  const output = (parsed as { output?: unknown }).output;
  const payload = typeof output === "object" && output !== null ? (output as { payload?: unknown }).payload : undefined;
  if (
    !isRecordProposalShape(output) ||
    output.recordType !== "objective" ||
    output.op !== "create" ||
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as { description?: unknown }).description !== "string"
  ) {
    throw notFound(
      "ExperienceCopilotThread",
      `Tool row '${row.toolCallId ?? row.id}' carries no sidechat objective proposal.`,
    );
  }
  return output;
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

// fork #1 of ObjectiveKeyedCoordinator
// (services/api/src/domain/insights/objective-service.ts — a private class;
// forks: 1 there) — the same promise-tail FIFO, lifted here because the
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

/**
 * Resolve one sidechat objective proposal: `apply` adds the item through
 * the reused insights service (tracker read at ACCEPT time) and marks the
 * row `applied`; `reject` only marks it `rejected`. Returns the proposal
 * with its final status (the caller's response payload).
 */
export async function resolveSidechatObjectiveProposal(
  deps: SidechatObjectiveProposalDeps,
  threadId: string,
  toolCallId: string,
  decision: SidechatObjectiveProposalDecision,
): Promise<RecordProposal> {
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
    const proposal = parseObjectiveProposal(row);
    if (proposal.status !== "pending") {
      throw conflict(
        `This objective proposal was already ${proposal.status}.`,
        { code: OBJECTIVE_PROPOSAL_ALREADY_RESOLVED_CODE, status: proposal.status },
      );
    }
    const nextStatus = decision === "apply" ? "applied" : "rejected";

    if (decision === "apply") {
      // Accept-time tracker resolution — read NOW, not at proposal time
      // (the user may have switched modes or turned the tracker off since).
      const chat = await deps.chats.getById(thread.chatId);
      if (!chat) {
        throw notFound("Chat", `Chat '${thread.chatId}' was not found.`);
      }
      if (!chat.insightsConfig.objectiveEnabled) {
        throw conflict(
          "The Objective Tracker is disabled for this chat; the proposal cannot be applied.",
          { code: OBJECTIVE_TRACKER_DISABLED_CODE },
        );
      }
      const description = (proposal.payload as { description: string }).description;
      if (chat.insightsObjectiveState.mode === OBJECTIVE_MODE.goals) {
        await deps.addShortTermGoal(chat.id, description);
      } else {
        await deps.addObjectiveTask(chat.id, { description });
      }
    }

    const rewritten = await deps.store.setToolResultOutput(threadId, toolCallId, {
      toolName: SIDECHAT_OBJECTIVE_TOOL_NAME,
      output: { ...proposal, status: nextStatus },
    });
    if (!rewritten) {
      // The row vanished between the list read and this write: report it the
      // same way a stale toolCallId reports (see the module header's order
      // note for why the tracker write is allowed to stand).
      throw notFound(
        "ExperienceCopilotThread",
        `Tool call '${toolCallId}' was not found in thread '${threadId}'.`,
      );
    }
    return { ...proposal, status: nextStatus };
  });
}
