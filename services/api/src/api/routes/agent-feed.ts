/**
 * Agent-feed read routes (AGENT_FEED_PERFORMANCE_PLAN, Wave 2 / AFP-11):
 *
 *   GET /api/agent/threads/:threadId/feed
 *   GET /api/agent/threads/:threadId/events/:eventId
 *
 * The additive paged pair beside the unchanged legacy reads — the array-shaped
 * `GET /api/experience-copilot/:threadId/messages` (no `seq`, feeds every
 * shell `listMessages`) and the frozen-events list
 * `GET /api/agent/threads/:threadId/events` (SC-19a) keep serving exactly what
 * they served; new consumers migrate to this pair (AFP-12's transports).
 *
 * The routes carry the HTTP shape only: the query enters through the AFP-7
 * schemas (`zValidator` — an invalid query is the validator's 400 before any
 * store I/O), the member call delegates to the `AgentFeedAdapter` slice, and
 * outcomes surface as DomainErrors through the app-level mapping (404 missing
 * thread/message/event, 400 malformed/foreign cursor, 409 stale window/detail
 * cursor with the AFP-7 typed codes + current epoch, 422 corrupt frozen
 * payload). Authentication is inherited unchanged — the pair mounts through
 * the same app middleware family as every `/api/*` route (origin guard +
 * mobile token), never a private bypass.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";
import type { AgentFeedRuntimeApi } from "../contract/agent-feed-api.js";

export function createAgentFeedRoutes(runtime: AgentFeedRuntimeApi) {
  return new Hono()
    .get(
      "/api/agent/threads/:threadId/feed",
      zValidator("query", schemas.agentFeedQuerySchema),
      async (c) => {
        const threadId = c.req.param("threadId");
        return c.json(await runtime.agentThreadFeedPage(threadId, c.req.valid("query")));
      },
    )
    .get(
      "/api/agent/threads/:threadId/events/:eventId",
      zValidator("query", schemas.agentEventDetailQuerySchema),
      async (c) => {
        const { threadId, eventId } = c.req.param();
        return c.json(await runtime.agentThreadEventDetail(threadId, eventId, c.req.valid("query")));
      },
    );
}
