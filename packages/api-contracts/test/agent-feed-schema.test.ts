import { describe, test, expect } from "bun:test";
import {
  AGENT_FEED_CURSOR_VERSION,
  AGENT_FEED_INITIAL_RECORDS,
  AGENT_FEED_OLDER_RECORDS,
  AGENT_FEED_SERVER_MAX_RECORDS,
  AGENT_EVENT_DETAIL_CACHE_MAX_ENTRIES,
  AGENT_EVENT_DETAIL_CACHE_MAX_BYTES,
  AGENT_EVENT_DETAIL_PAGE_ITEMS,
} from "../src/agent-feed-policy.js";
import {
  agentFeedOrderPositionSchema,
  agentFeedCursorPayloadSchema,
  agentFeedQuerySchema,
  resolveAgentFeedMode,
  agentFeedDefaultLimit,
  agentFeedEventSummarySchema,
  agentFeedBoundarySchema,
  agentFeedResponseSchema,
  agentFeedStaleWindowErrorSchema,
  agentEventDetailQuerySchema,
  agentEventDetailCursorPayloadSchema,
  agentEventDetailResponseSchema,
  agentEventDetailErrorSchema,
  AGENT_EVENT_DETAIL_ERROR_CODES,
} from "../src/schemas/agent-feed-schema.js";
import type { AgentFeedOrderPosition } from "../src/schemas/agent-feed-schema.js";

// AFP-7 contract pins (AGENT_FEED_PERFORMANCE_PLAN Wave 2): invalid modes /
// limits, cursor ownership identity, and response invariants of the additive
// feed + detail schemas. Pure zod parses — no globals, no restores needed.

// ─── shared fixtures ──────────────────────────────────────────────────────────

// Contextual annotation keeps the literal union members from widening to
// string/number in object-literal properties (TS widens fresh literals).
const position: AgentFeedOrderPosition = {
  record: "message",
  seq: 12,
  createdAt: "2026-11-04T10:00:00.000Z",
  id: "m12",
};

const message = (id: string, createdAt = "2026-11-04T10:00:00.000Z") => ({
  id,
  threadId: "t1",
  role: "assistant",
  content: "body",
  toolCallsJson: null,
  toolCallId: null,
  reasoning: null,
  reasoningDurationMs: null,
  createdAt,
});

const summary = {
  id: "e7",
  seq: 11,
  createdAt: "2026-11-04T09:59:00.000Z",
  beforeMessageId: "m12",
  detailAvailable: true,
};

const boundary = {
  startsMidTurn: false,
  endsMidTurn: false,
  turnOpenerMessageId: null,
  continuedToolCalls: [],
  lastUserMessageId: "m9",
  digest: {
    totalInThread: 1,
    unloadedOlderCount: 1,
    lastAnchor: "unloaded",
  },
};

const feedResponse = {
  threadId: "t1",
  historyEpoch: 3,
  head: { record: "message", seq: 20, createdAt: "2026-11-04T11:00:00.000Z", id: "m20" },
  range: {
    oldest: { record: "message", seq: 10, createdAt: "2026-11-04T09:00:00.000Z", id: "m10" },
    newest: { record: "message", seq: 20, createdAt: "2026-11-04T11:00:00.000Z", id: "m20" },
  },
  messages: [message("m12"), message("m20", "2026-11-04T11:00:00.000Z")],
  events: [{ ...summary, kind: "rp_sync", fromPosition: 0, toPosition: 9, messageCount: 9 }],
  hasOlder: true,
  hasNewer: false,
  cursors: { before: "cursor-older", after: null },
  boundary,
};

test("AFP-15 additive page facts retain coordinates and reject negative covered counts", () => {
  const pageFacts = { lastUserPosition: position, lastDigestAnchorPosition: position,
    firstAssistantMessageId: "m12", messagePositions: [position], digestCounts: [{ id: "d", coveredCount: 7 }] };
  expect(agentFeedResponseSchema.parse({ ...feedResponse, boundary: { ...boundary, pageFacts } }).boundary.pageFacts).toEqual(pageFacts);
  expect(agentFeedBoundarySchema.safeParse({ ...boundary, pageFacts: { ...pageFacts, digestCounts: [{ id: "d", coveredCount: -1 }] } }).success).toBe(false);
});

// ─── policy numbers (the plan's fixed values) ─────────────────────────────────

describe("agent-feed policy (AFP-7)", () => {
  test("owns the plan's paging, cursor and cache numbers", () => {
    expect(AGENT_FEED_INITIAL_RECORDS).toBe(100);
    expect(AGENT_FEED_OLDER_RECORDS).toBe(40);
    expect(AGENT_FEED_SERVER_MAX_RECORDS).toBe(200);
    expect(AGENT_FEED_CURSOR_VERSION).toBe(1);
    expect(AGENT_EVENT_DETAIL_CACHE_MAX_ENTRIES).toBe(32);
    expect(AGENT_EVENT_DETAIL_CACHE_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(AGENT_EVENT_DETAIL_PAGE_ITEMS).toBe(50);
  });
});

// ─── feed query ───────────────────────────────────────────────────────────────

describe("agentFeedQuerySchema", () => {
  test("accepts the bare query (newest/default mode)", () => {
    expect(agentFeedQuerySchema.parse({})).toEqual({});
  });

  test("accepts each paging mode alone", () => {
    expect(agentFeedQuerySchema.parse({ before: "c1" })).toEqual({ before: "c1" });
    expect(agentFeedQuerySchema.parse({ after: "c1" })).toEqual({ after: "c1" });
    expect(agentFeedQuerySchema.parse({ aroundMessageId: "m12" })).toEqual({ aroundMessageId: "m12" });
  });

  test("rejects every combination of two paging modes", () => {
    expect(() => agentFeedQuerySchema.parse({ before: "c1", after: "c2" })).toThrow();
    expect(() => agentFeedQuerySchema.parse({ before: "c1", aroundMessageId: "m1" })).toThrow();
    expect(() => agentFeedQuerySchema.parse({ after: "c1", aroundMessageId: "m1" })).toThrow();
  });

  test("rejects all three paging modes together", () => {
    expect(() =>
      agentFeedQuerySchema.parse({ before: "c1", after: "c2", aroundMessageId: "m1" }),
    ).toThrow();
  });

  test("coerces a numeric limit string", () => {
    expect(agentFeedQuerySchema.parse({ limit: "40" })).toEqual({ limit: 40 });
  });

  test("accepts the limit bounds and rejects beyond them", () => {
    expect(agentFeedQuerySchema.parse({ limit: "1" })).toEqual({ limit: 1 });
    expect(agentFeedQuerySchema.parse({ limit: String(AGENT_FEED_SERVER_MAX_RECORDS) }))
      .toEqual({ limit: AGENT_FEED_SERVER_MAX_RECORDS });
    expect(() => agentFeedQuerySchema.parse({ limit: "0" })).toThrow();
    expect(() => agentFeedQuerySchema.parse({ limit: String(AGENT_FEED_SERVER_MAX_RECORDS + 1) })).toThrow();
  });

  test("rejects non-numeric, negative and fractional limits", () => {
    expect(() => agentFeedQuerySchema.parse({ limit: "abc" })).toThrow();
    expect(() => agentFeedQuerySchema.parse({ limit: "-3" })).toThrow();
    expect(() => agentFeedQuerySchema.parse({ limit: "1.5" })).toThrow();
  });

  test("rejects an empty cursor param", () => {
    expect(() => agentFeedQuerySchema.parse({ before: "" })).toThrow();
    expect(() => agentFeedQuerySchema.parse({ aroundMessageId: "" })).toThrow();
  });
});

describe("resolveAgentFeedMode + agentFeedDefaultLimit", () => {
  test("resolves the newest/default mode and its initial target", () => {
    expect(resolveAgentFeedMode(agentFeedQuerySchema.parse({}))).toBe("newest");
    expect(agentFeedDefaultLimit("newest")).toBe(AGENT_FEED_INITIAL_RECORDS);
  });

  test("resolves each paging mode with the older target", () => {
    expect(resolveAgentFeedMode(agentFeedQuerySchema.parse({ before: "c1" }))).toBe("before");
    expect(resolveAgentFeedMode(agentFeedQuerySchema.parse({ after: "c1" }))).toBe("after");
    expect(resolveAgentFeedMode(agentFeedQuerySchema.parse({ aroundMessageId: "m1" }))).toBe("around");
    for (const mode of ["before", "after", "around"] as const) {
      expect(agentFeedDefaultLimit(mode)).toBe(AGENT_FEED_OLDER_RECORDS);
    }
  });
});

// ─── ordering position + cursor ownership ─────────────────────────────────────

describe("agentFeedOrderPositionSchema", () => {
  test("accepts a seq position and the legacy NULL-seq prefix", () => {
    expect(agentFeedOrderPositionSchema.parse(position)).toEqual(position);
    expect(agentFeedOrderPositionSchema.parse({ ...position, seq: null })).toEqual({ ...position, seq: null });
  });

  test("rejects an unknown record table and non-integer seq", () => {
    expect(() => agentFeedOrderPositionSchema.parse({ ...position, record: "digest" })).toThrow();
    expect(() => agentFeedOrderPositionSchema.parse({ ...position, seq: 1.5 })).toThrow();
  });
});

describe("agentFeedCursorPayloadSchema (cursor ownership identity)", () => {
  const cursor = { v: AGENT_FEED_CURSOR_VERSION, threadId: "t1", epoch: 3, position };

  test("accepts a complete cursor payload", () => {
    expect(agentFeedCursorPayloadSchema.parse(cursor)).toEqual(cursor);
  });

  test("rejects a cursor from another cursor version", () => {
    expect(() => agentFeedCursorPayloadSchema.parse({ ...cursor, v: 2 })).toThrow();
    expect(() => agentFeedCursorPayloadSchema.parse({ ...cursor, v: "1" })).toThrow();
  });

  test("rejects a cursor without thread ownership identity", () => {
    const { threadId, ...withoutThread } = cursor;
    expect(threadId).toBe("t1");
    expect(() => agentFeedCursorPayloadSchema.parse(withoutThread)).toThrow();
    expect(() => agentFeedCursorPayloadSchema.parse({ ...cursor, threadId: "" })).toThrow();
  });

  test("rejects a cursor without the epoch or the full ordering position", () => {
    const { epoch, ...withoutEpoch } = cursor;
    expect(epoch).toBe(3);
    expect(() => agentFeedCursorPayloadSchema.parse(withoutEpoch)).toThrow();
    const { position: omitted, ...withoutPosition } = cursor;
    expect(omitted).toBeDefined();
    expect(() => agentFeedCursorPayloadSchema.parse(withoutPosition)).toThrow();
  });

  test("is strict — no foreign keys ride a cursor", () => {
    expect(() => agentFeedCursorPayloadSchema.parse({ ...cursor, extra: true })).toThrow();
  });
});

// ─── event summaries ──────────────────────────────────────────────────────────

describe("agentFeedEventSummarySchema", () => {
  test("parses each of the five stored kinds", () => {
    expect(agentFeedEventSummarySchema.parse({
      ...summary, kind: "rp_sync", fromPosition: 0, toPosition: 9, messageCount: 9,
    })).toBeDefined();
    expect(agentFeedEventSummarySchema.parse({
      ...summary, kind: "variants_attached", position: 4, variantCount: 2,
    })).toBeDefined();
    expect(agentFeedEventSummarySchema.parse({
      ...summary, kind: "selection_changed", position: 4, messageId: "m4",
    })).toBeDefined();
    expect(agentFeedEventSummarySchema.parse({ ...summary, kind: "branch_forked", at: 4 })).toBeDefined();
    expect(agentFeedEventSummarySchema.parse({
      ...summary, kind: "profile_changed", fromLabel: "Default", toLabel: "Sharp",
    })).toBeDefined();
  });

  test("parses a corrupt-payload projection: null facts, detail unavailable", () => {
    const parsed = agentFeedEventSummarySchema.parse({
      ...summary,
      kind: "rp_sync",
      fromPosition: null,
      toPosition: null,
      messageCount: null,
      detailAvailable: false,
    });
    expect(parsed.detailAvailable).toBe(false);
    if (parsed.kind === "rp_sync") {
      expect(parsed.messageCount).toBeNull();
    } else {
      throw new Error("expected the rp_sync arm");
    }
  });

  test("structurally refuses an RP text body on a summary (no frozen texts)", () => {
    expect(() => agentFeedEventSummarySchema.parse({
      ...summary,
      kind: "rp_sync",
      fromPosition: 0,
      toPosition: 9,
      messageCount: 9,
      text: "frozen RP message body",
    })).toThrow();
    expect(() => agentFeedEventSummarySchema.parse({
      ...summary,
      kind: "variants_attached",
      position: 4,
      variantCount: 2,
      variants: [{ text: "v", selected: true, number: null, model: null, preset: null }],
    })).toThrow();
  });

  test("rejects a non-integer count and an unknown kind", () => {
    expect(() => agentFeedEventSummarySchema.parse({
      ...summary, kind: "rp_sync", fromPosition: 0, toPosition: 9, messageCount: 1.5,
    })).toThrow();
    expect(() => agentFeedEventSummarySchema.parse({ ...summary, kind: "rp_summary" })).toThrow();
  });
});

// ─── boundary context ─────────────────────────────────────────────────────────

describe("agentFeedBoundarySchema", () => {
  test("parses a full boundary with a split tool pair", () => {
    const parsed = agentFeedBoundarySchema.parse({
      ...boundary,
      startsMidTurn: true,
      turnOpenerMessageId: "m9",
      continuedToolCalls: [{ toolCallId: "tc-1", toolName: "plan" }],
    });
    expect(parsed.continuedToolCalls[0]?.toolName).toBe("plan");
  });

  test("accepts every digest anchor tri-state and rejects an unknown one", () => {
    for (const lastAnchor of ["loaded", "unloaded", "dangling"] as const) {
      expect(agentFeedBoundarySchema.parse({
        ...boundary,
        digest: { ...boundary.digest, lastAnchor },
      }).digest.lastAnchor).toBe(lastAnchor);
    }
    expect(() => agentFeedBoundarySchema.parse({
      ...boundary,
      digest: { ...boundary.digest, lastAnchor: "missing" },
    })).toThrow();
  });

  test("is strict at both levels", () => {
    expect(() => agentFeedBoundarySchema.parse({ ...boundary, extra: 1 })).toThrow();
    expect(() => agentFeedBoundarySchema.parse({
      ...boundary,
      continuedToolCalls: [{ toolCallId: "tc-1", toolName: null, extra: 1 }],
    })).toThrow();
  });
});

// ─── feed response ────────────────────────────────────────────────────────────

describe("agentFeedResponseSchema", () => {
  test("parses a coherent full page and keeps its fixture invariants", () => {
    const parsed = agentFeedResponseSchema.parse(feedResponse);
    // Documented invariants (the schema describes; the fixture pins):
    // cursors.before non-null IFF hasOlder; cursors.after non-null IFF hasNewer.
    expect(parsed.hasOlder).toBe(true);
    expect(parsed.cursors.before).not.toBeNull();
    expect(parsed.hasNewer).toBe(false);
    expect(parsed.cursors.after).toBeNull();
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.events).toHaveLength(1);
  });

  test("parses the empty-thread page (null head/range, zeroed boundary)", () => {
    const parsed = agentFeedResponseSchema.parse({
      threadId: "t1",
      historyEpoch: 0,
      head: null,
      range: { oldest: null, newest: null },
      messages: [],
      events: [],
      hasOlder: false,
      hasNewer: false,
      cursors: { before: null, after: null },
      boundary: {
        startsMidTurn: false,
        endsMidTurn: false,
        turnOpenerMessageId: null,
        continuedToolCalls: [],
        lastUserMessageId: null,
        digest: { totalInThread: 0, unloadedOlderCount: 0, lastAnchor: null },
      },
    });
    expect(parsed.head).toBeNull();
    expect(parsed.range.oldest).toBeNull();
  });

  test("reuses the legacy message wire — a message missing role is rejected", () => {
    const { role, ...withoutRole } = message("m12");
    expect(role).toBe("assistant");
    expect(() => agentFeedResponseSchema.parse({
      ...feedResponse,
      messages: [withoutRole],
    })).toThrow();
  });

  test("is strict — the coherent-read surface is closed", () => {
    expect(() => agentFeedResponseSchema.parse({ ...feedResponse, mode: "newest" })).toThrow();
  });

  test("requires the thread identity echo, epoch and boundary block", () => {
    const { threadId, ...withoutThread } = feedResponse;
    expect(threadId).toBe("t1");
    expect(() => agentFeedResponseSchema.parse(withoutThread)).toThrow();
    const { historyEpoch, ...withoutEpoch } = feedResponse;
    expect(historyEpoch).toBe(3);
    expect(() => agentFeedResponseSchema.parse(withoutEpoch)).toThrow();
    const { boundary: b, ...withoutBoundary } = feedResponse;
    expect(b).toBeDefined();
    expect(() => agentFeedResponseSchema.parse(withoutBoundary)).toThrow();
  });
});

// ─── stale-window outcome ─────────────────────────────────────────────────────

describe("agentFeedStaleWindowErrorSchema", () => {
  test("parses the typed stale-window body with the current epoch", () => {
    expect(agentFeedStaleWindowErrorSchema.parse({
      error: "feed window is stale",
      code: "AGENT_FEED_STALE_WINDOW",
      historyEpoch: 7,
    }).historyEpoch).toBe(7);
  });

  test("rejects any other code", () => {
    expect(() => agentFeedStaleWindowErrorSchema.parse({
      error: "x",
      code: "AGENT_EVENT_CORRUPT",
      historyEpoch: 7,
    })).toThrow();
  });
});

// ─── frozen-event detail ──────────────────────────────────────────────────────

describe("agentEventDetailQuerySchema", () => {
  test("first page needs no cursor; continuation carries one", () => {
    expect(agentEventDetailQuerySchema.parse({})).toEqual({});
    expect(agentEventDetailQuerySchema.parse({ cursor: "d1" })).toEqual({ cursor: "d1" });
    expect(() => agentEventDetailQuerySchema.parse({ cursor: "" })).toThrow();
  });
});

describe("agentEventDetailCursorPayloadSchema", () => {
  const detailCursor = {
    v: AGENT_FEED_CURSOR_VERSION,
    threadId: "t1",
    eventId: "e7",
    epoch: 3,
    offset: 50,
  };

  test("accepts a complete detail cursor", () => {
    expect(agentEventDetailCursorPayloadSchema.parse(detailCursor)).toEqual(detailCursor);
  });

  test("rejects a wrong version, a foreign event and a negative offset", () => {
    expect(() => agentEventDetailCursorPayloadSchema.parse({ ...detailCursor, v: 2 })).toThrow();
    const { eventId, ...withoutEvent } = detailCursor;
    expect(eventId).toBe("e7");
    expect(() => agentEventDetailCursorPayloadSchema.parse(withoutEvent)).toThrow();
    expect(() => agentEventDetailCursorPayloadSchema.parse({ ...detailCursor, offset: -1 })).toThrow();
  });
});

describe("agentEventDetailResponseSchema", () => {
  const base = { threadId: "t1", eventId: "e7", epoch: 3 };

  test("parses a paged rp_sync first page and its continuation", () => {
    const first = agentEventDetailResponseSchema.parse({
      ...base,
      kind: "rp_sync",
      fromPosition: 0,
      toPosition: 120,
      offset: 0,
      messages: [
        { id: "rp1", position: 1, role: "user", authorName: null, variantId: null, model: null, preset: null, text: "hi" },
      ],
      nextCursor: "d2",
    });
    expect(first.nextCursor).toBe("d2");
    const rest = agentEventDetailResponseSchema.parse({
      ...base,
      kind: "rp_sync",
      fromPosition: 0,
      toPosition: 120,
      offset: 50,
      messages: [],
      nextCursor: null,
    });
    expect(rest.nextCursor).toBeNull();
  });

  test("parses the four small kinds as atomic single pages", () => {
    expect(agentEventDetailResponseSchema.parse({
      ...base,
      kind: "variants_attached",
      position: 4,
      offset: 0,
      variants: [{ text: "v", selected: true, number: 2, model: null, preset: null }],
      nextCursor: null,
    })).toBeDefined();
    expect(agentEventDetailResponseSchema.parse({
      ...base,
      kind: "selection_changed",
      position: 4,
      messageId: "m4",
      previous: { variantId: "v1", text: "old", model: null, preset: null },
      current: { variantId: "v2", text: "new", model: null, preset: null },
      nextCursor: null,
    })).toBeDefined();
    expect(agentEventDetailResponseSchema.parse({
      ...base,
      kind: "branch_forked",
      at: 4,
      nextCursor: null,
    })).toBeDefined();
    expect(agentEventDetailResponseSchema.parse({
      ...base,
      kind: "profile_changed",
      from: { id: "p1", name: "Default" },
      to: { id: "p2", name: "Sharp" },
      nextCursor: null,
    })).toBeDefined();
  });

  test("variant items share the frozen payload shape — missing selected is rejected", () => {
    expect(() => agentEventDetailResponseSchema.parse({
      ...base,
      kind: "variants_attached",
      position: 4,
      offset: 0,
      variants: [{ text: "v", number: 2, model: null, preset: null }],
      nextCursor: null,
    })).toThrow();
  });

  test("is strict — no foreign keys on a detail page", () => {
    expect(() => agentEventDetailResponseSchema.parse({
      ...base,
      kind: "branch_forked",
      at: 4,
      nextCursor: null,
      beforeMessageId: "m12",
    })).toThrow();
  });
});

describe("agentEventDetailErrorSchema", () => {
  test("accepts every typed outcome code", () => {
    for (const code of AGENT_EVENT_DETAIL_ERROR_CODES) {
      expect(agentEventDetailErrorSchema.parse({ error: "x", code }).code).toBe(code);
    }
  });

  test("rejects an unknown code", () => {
    expect(() => agentEventDetailErrorSchema.parse({ error: "x", code: "AGENT_EVENT_GONE" })).toThrow();
  });

  test("carries the current epoch optionally (stale outcome)", () => {
    expect(agentEventDetailErrorSchema.parse({
      error: "x",
      code: "AGENT_EVENT_CURSOR_STALE",
      historyEpoch: 9,
    }).historyEpoch).toBe(9);
  });
});
