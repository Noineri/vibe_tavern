/**
 * AFP-13 — pins for the pure feed-state core (`agent-feed-reconcile.ts`):
 * the ordering contract's ties (the web-side twin of the db comparator), the
 * authoritative in-range reconcile (anchors, stable refs, vanish/insert,
 * request-adjacent coalescing), epoch invalidation (stale windows, dead
 * cursors, revalidation clearing), bridge-target planning and local-mutation
 * invalidation. Pure T0 — no DOM, no doubles; every fixture is a literal
 * AFP-7 `AgentFeedResponse`.
 */
import { describe, expect, it } from "bun:test";
import type {
  AgentFeedBoundary,
  AgentFeedEventSummary,
  AgentFeedOrderPosition,
  AgentFeedResponse,
  ExperienceCopilotMessageWire,
} from "@vibe-tavern/api-contracts";
import {
  agentFeedBridgeTarget,
  agentFeedCanLoadOlder,
  agentFeedFlattened,
  agentFeedOldestMessageId,
  applyAgentFeedLocalMutation,
  applyAgentFeedPage,
  compareAgentFeedOrderPositions,
  initAgentFeedState,
  staleAgentFeedWindows,
} from "./agent-feed-reconcile.js";

const BASE = Date.parse("2026-11-05T12:00:00.000Z");
/** Distinct per-index timestamps — legacy createdAt+id ordering must not
 *  silently agree with seq ordering (the AFP-11 fixture lesson). */
function ts(seq: number): string {
  return new Date(BASE + seq * 1000).toISOString();
}

function message(id: string, seq: number, over: Partial<ExperienceCopilotMessageWire> = {}): ExperienceCopilotMessageWire {
  return {
    id,
    threadId: "t1",
    role: "assistant",
    content: `body of ${id}`,
    toolCallsJson: null,
    toolCallId: null,
    reasoning: null,
    reasoningDurationMs: null,
    createdAt: ts(seq),
    ...over,
  };
}

function msgPos(id: string, seq: number | null, createdAt = ts(seq ?? 0)): AgentFeedOrderPosition {
  return { record: "message", seq, createdAt, id };
}

function eventSummary(id: string, seq: number): AgentFeedEventSummary {
  return { kind: "branch_forked", id, seq, createdAt: ts(seq), beforeMessageId: null, detailAvailable: true, at: seq };
}

const BOUNDARY: AgentFeedBoundary = {
  startsMidTurn: false,
  endsMidTurn: false,
  turnOpenerMessageId: null,
  continuedToolCalls: [],
  lastUserMessageId: "u1",
  digest: { totalInThread: 0, unloadedOlderCount: 0, lastAnchor: null },
};

/** A schema-shaped feed page over the given message seq range. */
function pageOf(seqs: number[], over: Partial<AgentFeedResponse> = {}): AgentFeedResponse {
  const messages = seqs.map((seq) => message(`m${seq}`, seq));
  const first = seqs[0];
  const last = seqs[seqs.length - 1];
  return {
    threadId: "t1",
    historyEpoch: 0,
    head: last === undefined ? null : msgPos(`m${last}`, last),
    range: {
      oldest: first === undefined ? null : msgPos(`m${first}`, first),
      newest: last === undefined ? null : msgPos(`m${last}`, last),
    },
    messages,
    events: [],
    hasOlder: first !== undefined && first > 0,
    hasNewer: false,
    cursors: { before: first !== undefined && first > 0 ? `cb-${first}` : null, after: null },
    boundary: BOUNDARY,
    ...over,
  };
}

// ─── The ordering contract's ties ────────────────────────────────────────────

describe("compareAgentFeedOrderPositions — the wire ordering contract", () => {
  it("seq ascending; the legacy NULL-seq prefix sorts before every numbered seq", () => {
    const legacy = msgPos("m-old", null);
    const first = msgPos("m0", 0);
    expect(compareAgentFeedOrderPositions(legacy, first)).toBeLessThan(0);
    expect(compareAgentFeedOrderPositions(first, legacy)).toBeGreaterThan(0);
    expect(compareAgentFeedOrderPositions(msgPos("a", 3), msgPos("b", 7))).toBeLessThan(0);
  });

  it("same seq: createdAt breaks the tie, then id", () => {
    const early = msgPos("z", 5, ts(5));
    const late = msgPos("a", 5, ts(9));
    expect(compareAgentFeedOrderPositions(early, late)).toBeLessThan(0);
    const sameTimeA = msgPos("a", 5, ts(5));
    const sameTimeB = msgPos("b", 5, ts(5));
    expect(compareAgentFeedOrderPositions(sameTimeA, sameTimeB)).toBeLessThan(0);
    expect(compareAgentFeedOrderPositions(sameTimeB, sameTimeA)).toBeGreaterThan(0);
  });

  it("an all-NULL-seq thread degenerates to (createdAt, id) — legacy listMessages order", () => {
    const older = msgPos("z", null, ts(1));
    const newer = msgPos("a", null, ts(2));
    expect(compareAgentFeedOrderPositions(older, newer)).toBeLessThan(0);
    expect(compareAgentFeedOrderPositions(msgPos("x", null, ts(3)), msgPos("a", null, ts(3)))).toBeGreaterThan(0);
  });

  it("a full key tie orders message before event (the merged-timeline collection order)", () => {
    const m = msgPos("same", 4, ts(4));
    const e: AgentFeedOrderPosition = { record: "event", seq: 4, createdAt: ts(4), id: "same" };
    expect(compareAgentFeedOrderPositions(m, e)).toBeLessThan(0);
    expect(compareAgentFeedOrderPositions(e, m)).toBeGreaterThan(0);
    expect(compareAgentFeedOrderPositions(m, { ...m })).toBe(0);
  });
});

// ─── Page application ────────────────────────────────────────────────────────

describe("applyAgentFeedPage — the authoritative reconcile", () => {
  it("the first newest page creates ONE window carrying epoch, head and the page-cut facts", () => {
    const state = applyAgentFeedPage(initAgentFeedState("t1"), pageOf([8, 9, 10]));
    expect(state.windows).toHaveLength(1);
    expect(state.historyEpoch).toBe(0);
    expect(state.head).toEqual(msgPos("m10", 10));
    const window = state.windows[0]!;
    expect(window.messages.map((m) => m.id)).toEqual(["m8", "m9", "m10"]);
    expect(window.before).toBe("cb-8");
    expect(window.hasOlder).toBe(true);
    expect(window.stale).toBe(false);
  });

  it("a foreign-thread page never stitches rows: the SAME state reference returns", () => {
    const state = applyAgentFeedPage(initAgentFeedState("t1"), pageOf([1, 2]));
    const foreign = pageOf([3, 4], { threadId: "t2" });
    expect(applyAgentFeedPage(state, foreign)).toBe(state);
  });

  it("a page from an older epoch is a late pre-bump result: refused, same reference", () => {
    const state = applyAgentFeedPage(initAgentFeedState("t1"), pageOf([1, 2], { historyEpoch: 5 }));
    const late = pageOf([1, 2, 3], { historyEpoch: 4 });
    expect(applyAgentFeedPage(state, late)).toBe(state);
  });

  it("a before-page fetched through the target COALESCES: one window, extents union, mixed edges", () => {
    let state = applyAgentFeedPage(initAgentFeedState("t1"), pageOf([8, 9, 10]));
    const target = state.windows[0]!;
    const older = pageOf([5, 6, 7], {
      boundary: { ...BOUNDARY, startsMidTurn: true, turnOpenerMessageId: "m5" },
    });
    state = applyAgentFeedPage(state, older, { target });
    expect(state.windows).toHaveLength(1);
    const window = state.windows[0]!;
    expect(window.messages.map((m) => m.id)).toEqual(["m5", "m6", "m7", "m8", "m9", "m10"]);
    expect(window.oldest).toEqual(msgPos("m5", 5));
    expect(window.newest).toEqual(msgPos("m10", 10));
    // Start-side facts from the OLDER page, end-side from the NEWEST one.
    expect(window.boundary.startsMidTurn).toBe(true);
    expect(window.boundary.turnOpenerMessageId).toBe("m5");
    expect(window.before).toBe("cb-5");
    expect(window.after).toBeNull();
    expect(window.hasOlder).toBe(true);
  });

  it("a disjoint page with NO target inserts as its own window, ordered by extent", () => {
    let state = applyAgentFeedPage(initAgentFeedState("t1"), pageOf([8, 9, 10]));
    state = applyAgentFeedPage(state, pageOf([2, 3]));
    expect(state.windows).toHaveLength(2);
    expect(state.windows.map((w) => w.messages[0]!.id)).toEqual(["m2", "m8"]);
  });

  it("an overlapping re-read reconciles in-range: refs retained, edits swapped, vanish removed, insert added", () => {
    let state = applyAgentFeedPage(initAgentFeedState("t1"), pageOf([1, 2, 3, 4, 5]));
    const retainedRows = state.windows[0]!.messages;
    const unchanged = retainedRows[0]!; // m1
    const editedRow = { ...message("m3", 3), content: "edited body" };
    const reRead = pageOf([1, 2, 3, 5, 6], {
      messages: [message("m1", 1), message("m2", 2), editedRow, message("m5", 5), message("m6", 6)],
      head: msgPos("m6", 6),
      hasOlder: true,
      hasNewer: false,
      cursors: { before: "cb-1", after: null },
    });
    state = applyAgentFeedPage(state, reRead);
    const rows = state.windows[0]!.messages;
    expect(rows.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m5", "m6"]); // m4 vanished, m6 inserted
    expect(rows[0]).toBe(unchanged); // equal row keeps the RETAINED reference
    expect(rows[2]).toBe(editedRow); // changed row takes the incoming object
    expect(rows[2]!.content).toBe("edited body");
    expect(state.head).toEqual(msgPos("m6", 6));
  });

  it("event summaries reconcile in the same range walk: vanish and ref retention included", () => {
    const first = pageOf([1, 3], {
      events: [eventSummary("e1", 2), eventSummary("e2", 4)],
      range: { oldest: msgPos("m1", 1), newest: msgPos("e2", 4) },
      head: msgPos("e2", 4),
      hasOlder: true,
    });
    let state = applyAgentFeedPage(initAgentFeedState("t1"), first);
    const retained = state.windows[0]!.events[0]!;
    const reRead = pageOf([1, 3], {
      events: [eventSummary("e1", 2), eventSummary("e3", 4)],
      range: { oldest: msgPos("m1", 1), newest: msgPos("e3", 4) },
      head: msgPos("e3", 4),
      hasOlder: true,
    });
    state = applyAgentFeedPage(state, reRead);
    expect(state.windows[0]!.events.map((e) => e.id)).toEqual(["e1", "e3"]); // e2 vanished
    expect(state.windows[0]!.events[0]).toBe(retained);
  });

  it("zero anchors over an overlapped window is the post-epoch mass replacement: the window drops", () => {
    let state = applyAgentFeedPage(initAgentFeedState("t1"), pageOf([1, 2, 3]));
    // Same extents, entirely new row ids — only an epoch change can produce this.
    state = applyAgentFeedPage(state, pageOf([1, 2, 3], { historyEpoch: 2, messages: [message("n1", 1), message("n2", 2), message("n3", 3)] }));
    expect(state.windows).toHaveLength(1);
    expect(state.windows[0]!.messages.map((m) => m.id)).toEqual(["n1", "n2", "n3"]);
    expect(state.windows[0]!.stale).toBe(false);
  });

  it("an epoch bump stales every UNTOUCHED window (cursors die, rows stay) and not the touched one", () => {
    let state = applyAgentFeedPage(initAgentFeedState("t1"), pageOf([1, 2, 3])); // older island
    state = applyAgentFeedPage(state, pageOf([20, 21])); // head window
    state = applyAgentFeedPage(state, pageOf([20, 21], { historyEpoch: 1 })); // re-read touches ONLY the head
    expect(state.windows).toHaveLength(2);
    const [older, head] = state.windows;
    expect(older!.stale).toBe(true); // untouched by the epoch-1 page
    expect(older!.before).toBeNull();
    expect(older!.after).toBeNull();
    expect(older!.messages.length).toBe(3); // rows retained for display
    expect(head!.stale).toBe(false);
    expect(state.historyEpoch).toBe(1);
  });

  it("a fresh page fully re-covering a stale window CLEARS staleness; a partial re-read keeps it", () => {
    let state = applyAgentFeedPage(initAgentFeedState("t1"), pageOf([1, 2, 3, 4, 5]));
    state = staleAgentFeedWindows(state, 3);
    expect(state.windows[0]!.stale).toBe(true);
    // Full re-read of the same extent under the new epoch:
    state = applyAgentFeedPage(state, pageOf([1, 2, 3, 4, 5], { historyEpoch: 3 }));
    expect(state.windows[0]!.stale).toBe(false);
    // A partial (older-half) re-read leaves retained newer-side rows suspect:
    state = staleAgentFeedWindows(state, 4);
    state = applyAgentFeedPage(state, pageOf([1, 2, 3], { historyEpoch: 4 }));
    expect(state.windows).toHaveLength(1);
    expect(state.windows[0]!.stale).toBe(true);
  });

  it("an EMPTY page settles the target's requested edge — it never empties the feed", () => {
    let state = applyAgentFeedPage(initAgentFeedState("t1"), pageOf([1, 2]));
    const target = state.windows[0]!;
    const empty = pageOf([], {
      messages: [],
      range: { oldest: null, newest: null },
      head: msgPos("m2", 2),
      hasOlder: true,
      hasNewer: false,
      cursors: { before: "cb-x", after: "ca-x" },
    });
    state = applyAgentFeedPage(state, empty, { target, emptyPageEdge: "older" });
    expect(state.windows[0]!.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(state.windows[0]!.hasOlder).toBe(false);
    expect(state.windows[0]!.before).toBeNull();
    // No-target no-change empty page: same reference.
    expect(applyAgentFeedPage(state, empty)).toBe(state);
  });
});

// ─── Bridge planning ─────────────────────────────────────────────────────────

describe("agentFeedBridgeTarget — settle-continuity gap planning", () => {
  it("connected coverage (one window) has nothing to bridge", () => {
    const state = applyAgentFeedPage(initAgentFeedState("t1"), pageOf([1, 2, 3]));
    expect(agentFeedBridgeTarget(state)).toBeNull();
  });

  it("a fresh gap between the head window and the fresh window below bridges via head.before", () => {
    let state = applyAgentFeedPage(initAgentFeedState("t1"), pageOf([1, 2, 3])); // old retained top
    state = applyAgentFeedPage(state, pageOf([20, 21])); // disjoint newest read — gap 4..19
    const bridge = agentFeedBridgeTarget(state);
    expect(bridge).not.toBeNull();
    expect(bridge!.window.messages[0]!.id).toBe("m20");
    expect(bridge!.cursor).toBe("cb-20"); // the head window's own before cursor
    // And the oldest window keeps its own live cursor for loadOlder.
    expect(agentFeedCanLoadOlder(state)).toBe(true);
    expect(agentFeedOldestMessageId(state)).toBe("m1");
  });

  it("stale windows below the head never trigger a bridge — only fresh continuity counts", () => {
    let state = applyAgentFeedPage(initAgentFeedState("t1"), pageOf([1, 2, 3]));
    state = staleAgentFeedWindows(state, 1);
    state = applyAgentFeedPage(state, pageOf([20, 21], { historyEpoch: 1 })); // fresh head, stale island below
    expect(state.windows).toHaveLength(2);
    expect(agentFeedBridgeTarget(state)).toBeNull();
  });

  it("a head window without an older cursor cannot bridge", () => {
    let state = applyAgentFeedPage(initAgentFeedState("t1"), pageOf([1, 2, 3]));
    state = applyAgentFeedPage(state, pageOf([20, 21], { hasOlder: false, cursors: { before: null, after: null } }));
    expect(agentFeedBridgeTarget(state)).toBeNull();
  });
});

// ─── Typed stale outcome + local mutations ───────────────────────────────────

describe("staleAgentFeedWindows / applyAgentFeedLocalMutation — the invalidation path", () => {
  it("adopting a newer epoch stales every window and nulls its cursors; a no-op returns the same reference", () => {
    let state = applyAgentFeedPage(initAgentFeedState("t1"), pageOf([1, 2, 3]));
    const second = applyAgentFeedPage(state, pageOf([9, 10]));
    state = staleAgentFeedWindows(second, 2);
    expect(state.historyEpoch).toBe(2);
    for (const window of state.windows) {
      expect(window.stale).toBe(true);
      expect(window.before).toBeNull();
      expect(window.after).toBeNull();
    }
    // Rows survive for display:
    expect(agentFeedFlattened(state).messages).toHaveLength(5);
    // Re-invalidation at a non-newer epoch changes nothing:
    expect(staleAgentFeedWindows(state, 2)).toBe(state);
    expect(staleAgentFeedWindows(state, 1)).toBe(state);
  });

  it("a local deletion removes the row now, stales the owning window, leaves other windows untouched", () => {
    let state = applyAgentFeedPage(initAgentFeedState("t1"), pageOf([1, 2, 3]));
    state = applyAgentFeedPage(state, pageOf([9, 10]));
    const newer = state.windows[1]!;
    state = applyAgentFeedLocalMutation(state, { deletedMessageIds: ["m2"] });
    expect(state.windows[0]!.messages.map((m) => m.id)).toEqual(["m1", "m3"]);
    expect(state.windows[0]!.stale).toBe(true);
    expect(state.windows[0]!.before).toBeNull();
    // The untouched window keeps its reference:
    expect(state.windows[1]).toBe(newer);
  });

  it("a local edit keeps the row (old text) but marks the owning window stale", () => {
    let state = applyAgentFeedPage(initAgentFeedState("t1"), pageOf([1, 2, 3]));
    state = applyAgentFeedLocalMutation(state, { editedMessageIds: ["m2"] });
    expect(state.windows[0]!.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(state.windows[0]!.messages[1]!.content).toBe("body of m2");
    expect(state.windows[0]!.stale).toBe(true);
  });

  it("a mutation naming no loaded row is a no-op (same reference)", () => {
    const state = applyAgentFeedPage(initAgentFeedState("t1"), pageOf([1, 2]));
    expect(applyAgentFeedLocalMutation(state, { deletedMessageIds: ["m999"] })).toBe(state);
    expect(applyAgentFeedLocalMutation(state, {})).toBe(state);
  });
});

// ─── Read-side helpers ───────────────────────────────────────────────────────

describe("agentFeedFlattened — the model input over every covered window", () => {
  it("concatenates windows oldest → newest, messages and events each in window order", () => {
    let state = applyAgentFeedPage(initAgentFeedState("t1"), pageOf([1, 2]));
    state = applyAgentFeedPage(state, pageOf([7, 8]));
    const flat = agentFeedFlattened(state);
    expect(flat.messages.map((m) => m.id)).toEqual(["m1", "m2", "m7", "m8"]);
    expect(agentFeedOldestMessageId(state)).toBe("m1");
    expect(agentFeedCanLoadOlder(state)).toBe(true);
  });

  it("an oldest window that is stale or cursor-less cannot page right now", () => {
    let state = applyAgentFeedPage(initAgentFeedState("t1"), pageOf([1, 2], { hasOlder: false, cursors: { before: null, after: null } }));
    expect(agentFeedCanLoadOlder(state)).toBe(false);
    state = applyAgentFeedPage(initAgentFeedState("t1"), pageOf([1, 2]));
    state = staleAgentFeedWindows(state, 1);
    expect(agentFeedCanLoadOlder(state)).toBe(false);
  });
});
