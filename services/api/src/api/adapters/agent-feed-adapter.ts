/**
 * Agent-feed adapter (AGENT_FEED_PERFORMANCE_PLAN, Wave 2 / AFP-11) — the
 * thin wiring behind `GET /api/agent/threads/:threadId/feed` and
 * `GET /api/agent/threads/:threadId/events/:eventId`.
 *
 * Owns NO read logic: the coherent page, the boundary block, cursor
 * encode/decode and the frozen re-validation all live in the AFP-10 domain
 * service (`domain/agent/agent-feed-service.ts`); the bounded SQL reads live
 * in the AFP-9 store seam (`readFeedPage` / `readEventDetail` on the copilot
 * store). This class is the one place the two meet HTTP:
 *
 * - the ONLY transformation added here is the message wire mapping — the
 *   service returns store-typed messages because the arch gate's ratchet
 *   forbids new domain→api/ dependencies, so `toMessageWire` (the ONE
 *   derivation, experience-copilot-wire-mappers.ts — the same mapper the
 *   legacy array route serves through) runs at this layer. Everything else
 *   on the page is already wire-shaped by the service;
 * - the detail member forwards the optional `cursor` and serves the service's
 *   response verbatim (cursors are opaque strings: encoded once server-side
 *   by the service, echoed here, never re-encoded).
 *
 * A dedicated slice (not a member of `ExperienceCopilotAdapter`) per the
 * adapters' composition rule — "create an adapter and wire it here" — which
 * also keeps the big copilot adapter under its size ratchet (the
 * `AgentThreadProposalAdapter` precedent).
 */
import type { StoreContainer } from "@vibe-tavern/db";
import type {
  AgentEventDetailQuery,
  AgentEventDetailResponse,
  AgentFeedQuery,
  AgentFeedResponse,
} from "@vibe-tavern/api-contracts";
import type { AgentFeedRuntimeApi } from "../contract/agent-feed-api.js";
import {
  loadAgentEventDetail,
  loadAgentFeedPage,
  type AgentFeedServiceDeps,
} from "../../domain/agent/agent-feed-service.js";
import { toMessageWire } from "./experience-copilot-wire-mappers.js";

export class AgentFeedAdapter implements AgentFeedRuntimeApi {
  private readonly deps: AgentFeedServiceDeps;

  constructor(stores: StoreContainer) {
    this.deps = { store: stores.experienceCopilot };
  }

  agentThreadFeedPage = async (
    threadId: string,
    query: AgentFeedQuery,
  ): Promise<AgentFeedResponse> => {
    const page = await loadAgentFeedPage(this.deps, threadId, query);
    // The service's readonly arrays are its immutability guarantee; the wire
    // contract carries plain arrays — the copy happens here, at the boundary.
    return { ...page, messages: page.messages.map(toMessageWire), events: [...page.events] };
  };

  agentThreadEventDetail = async (
    threadId: string,
    eventId: string,
    query: AgentEventDetailQuery,
  ): Promise<AgentEventDetailResponse> =>
    loadAgentEventDetail(this.deps, threadId, eventId, query.cursor);
}
