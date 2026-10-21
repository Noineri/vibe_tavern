/**
 * Agent-thread frozen-events route (SIDECHAT_PLAN Wave 5 / SC-19a):
 *
 *   GET /api/agent/threads/:threadId/events
 *
 * For a chat-owned thread, its frozen context events in merged-timeline
 * order, each `{ id, kind, payload, beforeMessageId }` — the payload mapped
 * through the SAME parser the context loader uses, the anchor naming the
 * first message row after the event (null when the event is the newest
 * row). Changing the shared messages route instead would break every
 * assistant (`GET /api/experience-copilot/:threadId/messages` feeds the
 * shell's `listMessages` for scripts and mini-apps too), and the message
 * wire carries no `seq` to interleave events by — hence this dedicated
 * route; the messages route is unchanged.
 *
 * A script-owned / draft thread answers `[]` (no frozen events exist for
 * it); a missing thread is the 404 `notFound` DomainError the sibling
 * per-thread routes (agent-thread-proposals.ts, the SC-11 family) surface
 * through the app-level mapping. The read itself lives in
 * domain/sidechat/sidechat-events.ts (the SC-11 layering: logic in the
 * domain module, the adapter member wires the store, this route only
 * carries the HTTP shape).
 */
import { Hono } from "hono";
import type { ExperienceCopilotRuntimeApi } from "../contract/runtime-api.js";

export function createAgentThreadEventsRoutes(runtime: ExperienceCopilotRuntimeApi) {
  return new Hono()
    .get("/api/agent/threads/:threadId/events", async (c) => {
      const threadId = c.req.param("threadId");
      return c.json(await runtime.agentThreadListEvents(threadId));
    });
}
