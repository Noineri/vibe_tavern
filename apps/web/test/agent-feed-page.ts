/**
 * AFP-14: fetch-router fixture — one coherent `AgentFeedResponse` built from
 * a plain legacy message array. Suites that mount a REAL shell through a
 * built-in host (whose transports wire `feed` since AFP-12) serve the paged
 * `GET /api/agent/threads/:threadId/feed` from this helper so the shell's
 * windowed lifecycle reads the same rows the legacy `/messages` fixtures
 * carried. All rows are message-record positions at index-derived seqs in
 * array order — the comparator's (seq, createdAt, id) triple stays mutually
 * consistent, so covered-range math and bridging see a well-ordered thread.
 * Shared derivation (never a per-suite copy): both built from the ONE wire
 * schema in `@vibe-tavern/api-contracts`.
 */
import type { AgentFeedBoundary, AgentFeedResponse, ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";

const BOUNDARY: AgentFeedBoundary = {
  startsMidTurn: false,
  endsMidTurn: false,
  turnOpenerMessageId: null,
  continuedToolCalls: [],
  lastUserMessageId: null,
  digest: { totalInThread: 0, unloadedOlderCount: 0, lastAnchor: null },
};

export function agentFeedPageFromMessages(
  threadId: string,
  messages: readonly ExperienceCopilotMessageWire[],
  over: Partial<AgentFeedResponse> = {},
  /** AFP-14 lifecycle: pages of one thread sit at seq offsets — `seqBase`
   *  shifts the derived positions so a later page's rows order after an
   *  earlier one's without hand-built position literals. */
  seqBase = 0,
): AgentFeedResponse {
  const ordered = messages.map((message, index) => {
    const position = { record: "message" as const, seq: seqBase + index, createdAt: message.createdAt, id: message.id };
    return { message, position };
  });
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  return {
    threadId,
    historyEpoch: 0,
    head: last === undefined ? null : last.position,
    range: {
      oldest: first === undefined ? null : first.position,
      newest: last === undefined ? null : last.position,
    },
    messages: [...messages],
    events: [],
    hasOlder: false,
    hasNewer: false,
    cursors: { before: null, after: null },
    boundary: BOUNDARY,
    ...over,
  };
}
