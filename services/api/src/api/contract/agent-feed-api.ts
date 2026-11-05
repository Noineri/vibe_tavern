import type {
  AgentEventDetailQuery,
  AgentEventDetailResponse,
  AgentFeedQuery,
  AgentFeedResponse,
} from "@vibe-tavern/api-contracts";

/**
 * Agent-feed read contract (AGENT_FEED_PERFORMANCE_PLAN, Wave 2 / AFP-11) —
 * the ADDITIVE paged feed/detail pair behind:
 *
 *   GET /api/agent/threads/:threadId/feed
 *   GET /api/agent/threads/:threadId/events/:eventId
 *
 * Everything the pair serves is already decided by the time a member runs:
 * the wire shapes come from the AFP-7 contracts, the page/boundary/cursor
 * projection and the frozen re-validation from the AFP-10 domain service
 * (`domain/agent/agent-feed-service.ts`), and the bounded SQL reads from the
 * AFP-9 store seam. This interface is only the route-facing slice of that
 * pipeline (the SC-11 layering: logic in the domain module, the adapter wires
 * the store, the route carries the HTTP shape).
 *
 * The legacy full-list reads stay untouched beside it — the array-shaped
 * `GET /api/experience-copilot/:threadId/messages` (no `seq`, feeds every
 * shell `listMessages`) and the frozen-events list
 * `GET /api/agent/threads/:threadId/events` (SC-19a) keep serving exactly
 * what they served; this pair is what new consumers migrate to.
 *
 * Outcomes are DomainErrors mapped by the app-level handler (AFP-11 owns no
 * mapping of its own): missing thread/message/event → 404, a malformed or
 * foreign cursor → 400 Validation, an epoch-invalidated window or detail
 * cursor → 409 Conflict carrying the AFP-7 typed codes
 * (`AGENT_FEED_STALE_WINDOW` / `AGENT_EVENT_CURSOR_STALE`) plus the CURRENT
 * epoch, and a corrupt frozen payload → 422 `AGENT_EVENT_CORRUPT`. A query
 * that fails the AFP-7 schema never reaches a member — the route's zValidator
 * answers its 400 first. Authentication is unchanged: the pair mounts through
 * the same `/api/*` app middleware family (origin guard + mobile token).
 */
export interface AgentFeedRuntimeApi {
	/**
	 * One coherent bounded feed page (AFP-7 `agentFeedResponseSchema`):
	 * ordered message wire rows (the SAME per-message wire the legacy array
	 * route serves — mapped by the adapter through the one `toMessageWire`
	 * derivation), lightweight event summaries, range/coverage facts, opaque
	 * adjacent-page cursors, the history epoch/head watermark and the
	 * boundary block. `query` is the PARSED AFP-7 feed query (exactly what
	 * the route's zValidator produces): one of newest/default, `before`,
	 * `after` or `aroundMessageId`, with a bounded `limit` resolved to the
	 * policy defaults when absent.
	 */
	agentThreadFeedPage: (
		threadId: string,
		query: AgentFeedQuery,
	) => Promise<AgentFeedResponse>;

	/**
	 * One frozen event's immutable DETAIL (AFP-7
	 * `agentEventDetailResponseSchema`): first page when `query.cursor` is
	 * absent (opening a summary fetches only its first page), continuation
	 * pages echo the previous response's `nextCursor`. Page size is
	 * policy-owned (`AGENT_EVENT_DETAIL_PAGE_ITEMS`); the slice is
	 * re-validated through the shared frozen parser before serving, scoped to
	 * the owning thread (a wrong-thread event id is the missing-event 404,
	 * never a cross-thread body).
	 */
	agentThreadEventDetail: (
		threadId: string,
		eventId: string,
		query: AgentEventDetailQuery,
	) => Promise<AgentEventDetailResponse>;
}
