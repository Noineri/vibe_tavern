/**
 * Agent-feed paged read client (AGENT_FEED_PERFORMANCE_PLAN, Wave 3 / AFP-12)
 * — the typed twin of the AFP-11 routes:
 *
 *   GET /api/agent/threads/:threadId/feed
 *   GET /api/agent/threads/:threadId/events/:eventId
 *
 * Thread-scoped like the events list (`agent-chat-api.ts`): the routes
 * dispatch by the thread's own kind, so ONE client serves every host — the
 * registry's optional `transport.feed` member (AFP-12) wires these exact fns,
 * and a custom transport without it keeps the legacy full-list fallback
 * (`listMessages` + `listEvents`) until explicitly migrated.
 *
 * Query typing: callers pass the PARSED AFP-7 query (`AgentFeedQuery` —
 * `limit` is a number); the wire edge stringifies it (the schema coerces
 * back, non-numeric strings are rejected server-side, never sent). The
 * opaque cursor strings echo verbatim — clients never decode them.
 *
 * Typed outcomes: a 409 carrying the AFP-7 stale codes
 * (`AGENT_FEED_STALE_WINDOW` / `AGENT_EVENT_CURSOR_STALE`) becomes
 * {@link AgentFeedStaleError} with the CURRENT epoch (AFP-13's reconcile keys
 * on it to revalidate instead of silently restarting); every other failure is
 * the shared `RpcError` (404 missing, 400 malformed/foreign cursor, 422
 * corrupt frozen payload) through the unwrap convention.
 */
import { client } from "./client.js";
import { errorFromBody, unwrapRpc } from "./unwrap.js";
import type { RpcBody, RpcErrorBody, RpcResponse } from "./unwrap.js";
import type { AgentEventDetailResponse, AgentFeedQuery, AgentFeedResponse } from "@vibe-tavern/api-contracts";

/** The two AFP-7 stale-window 409 codes — which paging surface went stale. */
export type AgentFeedStaleCode = "AGENT_FEED_STALE_WINDOW" | "AGENT_EVENT_CURSOR_STALE";

/** A 409 whose window no longer matches the thread's history epoch (an
 *  invalidating write bumped it under the cursor). Carries the code
 *  discriminant plus the CURRENT epoch — the caller revalidates its retained
 *  neighborhood and newest state, never silently restarts at newest. */
export class AgentFeedStaleError extends Error {
  constructor(message: string, readonly code: AgentFeedStaleCode, readonly historyEpoch: number) {
    super(message);
    this.name = "AgentFeedStaleError";
  }
}

/** Read-once 409 handling: the typed stale outcome (the body is consumed
 *  HERE), everything else falls through to the shared error mapping over the
 *  SAME already-read body — the `errorFromBody` seam exists for exactly this
 *  split. Non-409 failures ride `unwrapRpc` untouched. */
async function unwrapFeedRpc<R extends RpcResponse>(response: R): Promise<RpcBody<R>> {
  if (!response.ok && response.status === 409) {
    const body = await response.json().catch(() => null) as RpcErrorBody | null;
    const error = typeof body?.error === "object" && body.error !== null ? body.error : undefined;
    const details = error?.details as { code?: unknown; historyEpoch?: unknown } | undefined;
    if (
      (details?.code === "AGENT_FEED_STALE_WINDOW" || details?.code === "AGENT_EVENT_CURSOR_STALE")
      && typeof details?.historyEpoch === "number"
    ) {
      throw new AgentFeedStaleError(error?.message ?? "The requested feed window is stale.", details.code, details.historyEpoch);
    }
    throw errorFromBody(body, response.status);
  }
  return unwrapRpc(response);
}

/** One coherent bounded feed page: newest/default window with no paging
 *  param, or exactly one of `before` / `after` / `aroundMessageId` (the AFP-7
 *  schema enforces exclusivity server-side; the query type carries it
 *  structurally — every field optional). */
export async function getAgentFeedPage(
  threadId: string,
  query: AgentFeedQuery = {},
): Promise<AgentFeedResponse> {
  const response = await client.api.agent.threads[":threadId"].feed.$get({
    param: { threadId },
    query: {
      ...(query.before !== undefined ? { before: query.before } : {}),
      ...(query.after !== undefined ? { after: query.after } : {}),
      ...(query.aroundMessageId !== undefined ? { aroundMessageId: query.aroundMessageId } : {}),
      ...(query.limit !== undefined ? { limit: String(query.limit) } : {}),
    },
  });
  return unwrapFeedRpc(response);
}

/** One frozen event's immutable DETAIL page — the first page with no cursor
 *  (opening a summary fetches only its first page), continuation pages echo
 *  the previous response's `nextCursor` verbatim. Page size is
 *  policy-owned; callers never choose it. */
export async function getAgentEventDetail(
  threadId: string,
  eventId: string,
  cursor?: string,
): Promise<AgentEventDetailResponse> {
  const response = await client.api.agent.threads[":threadId"].events[":eventId"].$get({
    param: { threadId, eventId },
    query: { ...(cursor !== undefined ? { cursor } : {}) },
  });
  return unwrapFeedRpc(response);
}
