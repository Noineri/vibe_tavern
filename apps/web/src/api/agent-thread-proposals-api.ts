/**
 * Thread proposal resolution client (SIDECHAT_PLAN SC-13c) — the web client
 * for SC-11's apply/reject routes:
 *
 *   POST /api/agent/threads/:threadId/proposals/:toolCallId/apply
 *   POST /api/agent/threads/:threadId/proposals/:toolCallId/reject
 *
 * Body-less (the proposal payload lives in the addressed tool row); the
 * resolved proposal (with its final `applied` / `rejected` status) comes back
 * as the `{ proposal }` envelope. Typed 409s surface through
 * {@link ObjectiveProposalApiError} — the shared `unwrapRpc` collapses the
 * backend's `error.details` (which carries the `code` the review card
 * branches on), so this module reads the body once itself (the `unwrapDice`
 * precedent in `dice-api.ts`), preserving the status, the code, and — for an
 * already-resolved proposal — the server's final `status`.
 */
import type { RecordProposal } from "@vibe-tavern/api-contracts";
import { client } from "./client.js";
import type { RpcBody, RpcData, RpcResponse } from "./unwrap.js";

/** Route-inferred wire shapes: the Hono route is the only declaration. */
type Api = typeof client.api;

/** The SC-11 apply/reject response: the resolved proposal with its final status. */
export type ObjectiveProposalResolveResponse = RpcData<
  Api["agent"]["threads"][":threadId"]["proposals"][":toolCallId"]["apply"]["$post"]
>;

/** The 409 code when the objective tracker is off at Accept time. */
export const OBJECTIVE_TRACKER_DISABLED_CODE = "objective_tracker_disabled";

/** The 409 code when the proposal already resolved (double click, second tab). */
export const OBJECTIVE_PROPOSAL_ALREADY_RESOLVED_CODE = "objective_proposal_already_resolved";

/**
 * Structured proposal-resolution API error. Carries the HTTP status, the
 * typed 409 `code` (`details.code`), and — for
 * `objective_proposal_already_resolved` — the server's final proposal
 * `status` (`details.status`), so the card can show it without refetching.
 * Every other failure is a plain `Error` with the server's message.
 */
export class ObjectiveProposalApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly resolvedStatus?: RecordProposal["status"];

  constructor(status: number, message: string, code?: string, resolvedStatus?: RecordProposal["status"]) {
    super(message);
    this.name = "ObjectiveProposalApiError";
    this.status = status;
    this.code = code;
    this.resolvedStatus = resolvedStatus;
  }
}

async function unwrapProposal<R extends RpcResponse>(response: R): Promise<RpcBody<R>> {
  if (response.ok) return response.json() as Promise<RpcBody<R>>;
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string; details?: { code?: unknown; status?: unknown } };
  } | null;
  const err = body?.error;
  const code = typeof err?.details?.code === "string" ? err.details.code : undefined;
  const rawStatus = err?.details?.status;
  const resolvedStatus =
    rawStatus === "applied" || rawStatus === "rejected" ? rawStatus : undefined;
  throw new ObjectiveProposalApiError(
    response.status,
    err?.message ?? `Request failed: ${response.status}`,
    code,
    resolvedStatus,
  );
}

/** Apply one pending objective proposal: the item lands in the RP objective tracker. */
export async function applyObjectiveProposal(
  threadId: string,
  toolCallId: string,
): Promise<ObjectiveProposalResolveResponse> {
  const response = await client.api.agent.threads[":threadId"].proposals[":toolCallId"].apply.$post({
    param: { threadId, toolCallId },
  });
  return unwrapProposal(response);
}

/** Reject one pending objective proposal: nothing lands in the tracker. */
export async function rejectObjectiveProposal(
  threadId: string,
  toolCallId: string,
): Promise<ObjectiveProposalResolveResponse> {
  const response = await client.api.agent.threads[":threadId"].proposals[":toolCallId"].reject.$post({
    param: { threadId, toolCallId },
  });
  return unwrapProposal(response);
}
