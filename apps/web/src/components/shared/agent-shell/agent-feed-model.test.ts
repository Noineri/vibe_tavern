import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentThreadEventWire, ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import {
  buildAgentFeedModel,
  clearAgentFeedModelMemo,
  EMPTY_AGENT_FEED_EVENTS,
  EMPTY_AGENT_FEED_LIVE_TOOL_CALL_IDS,
  memoizedAgentFeedModel,
} from "./agent-feed-model.js";

// AFP-3 (AGENT_FEED_PERFORMANCE_PLAN Wave 1 step 5): pins for the memoized
// feed model. The historical folds are VERBATIM moves of the `useMemo`
// bodies in AgentMessageList.tsx — the fixtures mirror the AFP-1
// characterization suite so the derived model reproduces its pinned
// document semantics (anchor clustering, caption slots, digest ordering,
// event anchoring) at the data level. Pure T0 — no DOM, no doubles.

beforeEach(() => {
  clearAgentFeedModelMemo();
});

function message(over: Partial<ExperienceCopilotMessageWire>): ExperienceCopilotMessageWire {
  return {
    id: "m1",
    threadId: "thread-1",
    role: "user",
    content: "hello",
    toolCallsJson: null,
    toolCallId: null,
    reasoning: null,
    reasoningDurationMs: null,
    createdAt: "",
    ...over,
  };
}

function toolRow(id: string, toolCallId: string, content: string): ExperienceCopilotMessageWire {
  return message({ id, role: "tool", toolCallId, content });
}

function carrier(id: string, toolCallId: string, calls: string): ExperienceCopilotMessageWire {
  return message({ id, role: "assistant", content: "", toolCallsJson: calls });
}

function rpSyncEvent(id: string, beforeMessageId: string | null): AgentThreadEventWire {
  return { id, kind: "rp_sync", beforeMessageId, payload: { fromPosition: 0, toPosition: 1, messages: [] } };
}

function branchForkedEvent(id: string): AgentThreadEventWire {
  return { id, kind: "branch_forked", beforeMessageId: null, payload: { at: 12 } };
}

/** The AFP-1 composite fixture: two turns with tools, a permission, an ask,
 *  an anchored event, a digest, null carriers and trailing events. */
function compositeMessages(): ExperienceCopilotMessageWire[] {
  return [
    message({ id: "u1", role: "user", content: "first question" }),
    carrier("carrier1", "c1", JSON.stringify([
      { type: "tool-call", toolCallId: "c1", toolName: "write_buffer", input: { buffer: "rules" } },
    ])),
    toolRow("tool1", "c1", JSON.stringify({
      toolName: "write_buffer",
      output: { target: "rules", proposed: "# R1", summary: "first pass" },
    })),
    message({ id: "a1", role: "assistant", content: "first reply" }),
    message({ id: "u2", role: "user", content: "second question" }),
    carrier("carrier2", "c-perm", JSON.stringify([
      { type: "tool-call", toolCallId: "c-perm", toolName: "read_message_prompt", input: { position: 5 } },
    ])),
    toolRow("toolp", "c-perm", JSON.stringify({
      toolName: "read_message_prompt",
      output: { status: "awaiting_permission", position: 5, variantNumber: 2, replyFirstLine: "x", promptTokens: 1200 },
    })),
    carrier("carriera", "tc-ask", JSON.stringify([
      { type: "tool-call", toolCallId: "tc-ask", toolName: "ask_user", input: { question: "Which buffer?" } },
    ])),
    toolRow("toola", "tc-ask", JSON.stringify({
      toolName: "ask_user",
      output: { status: "awaiting_answer", question: "Which buffer?", options: ["Rules", "Visual"] },
    })),
    message({ id: "a4", role: "assistant", content: "second reply" }),
    message({ id: "d1", role: "digest", content: "summary", toolCallId: "u2" }),
  ];
}

describe("agent-feed-model — historical folds (AFP-3)", () => {
  it("reproduces the AFP-1 composite semantics: order, boundaries, anchors, captions, events", () => {
    const model = buildAgentFeedModel({
      messages: compositeMessages(),
      events: [rpSyncEvent("e-rp", "u2"), branchForkedEvent("e-branch")],
      liveToolCallIds: EMPTY_AGENT_FEED_LIVE_TOOL_CALL_IDS,
    });

    // Digest-ordered visible flow: tool rows drop out, the digest stays at
    // its own chronological slot (end of the list), carriers REMAIN (they
    // anchor cards; the window omits them as render units, the model keeps
    // them as flow members — exactly like the flat list).
    expect(model.visibleMessages.map((e) => e.message.id)).toEqual([
      "u1", "carrier1", "a1", "u2", "carrier2", "carriera", "a4", "d1",
    ]);
    // Covered count: the digest's anchor is u2 (flow index 3, counting only
    // user/assistant rows) — covers 3 messages (CM-9/AP-33).
    const digest = model.visibleMessages.find((e) => e.message.role === "digest");
    expect(digest?.coveredCount).toBe(3);

    // Boundaries: the last user slot and the digest ANCHOR's slot (not the
    // digest's own — AP-33).
    expect(model.boundaries.lastUserVisibleIndex).toBe(3);
    expect(model.boundaries.lastDigestAnchorVisibleIndex).toBe(3);

    // TA-1 anchor pass: turn 1's single accordion anchors at a1 (the next
    // flow row after the tool); the permission anchors at the carrier
    // carriera; the ask at a4.
    expect([...model.anchorItems.keys()]).toEqual(["a1", "carriera", "a4"]);
    expect(model.anchorItems.get("a1")).toHaveLength(1);
    const turn1Cluster = model.anchorItems.get("a1")![0]!;
    expect(turn1Cluster.kind).toBe("accordion");
    if (turn1Cluster.kind === "accordion") {
      expect(turn1Cluster.activities[0]!.toolCallId).toBe("c1");
    }
    expect(model.anchorItems.get("carriera")![0]!.kind).toBe("permission");
    expect(model.anchorItems.get("a4")![0]!.kind).toBe("ask");
    expect(model.trailingItems).toHaveLength(0);

    // Captions: one per assistant turn — turn 1 at a1 (anchored first),
    // turn 2 at carriera (anchored before its first text a4).
    expect([...model.captions.captionBefore.keys()]).toEqual(["a1", "carriera"]);
    expect(model.captions.trailingCaption).toBeNull();
    expect(model.captions.lastTurnSlotId).toBe("carriera");
    expect(model.captions.lastTurnEarnsCaption).toBe(true);

    // SC-19b events: anchored before u2; the null anchor trails.
    expect([...model.eventAnchors.keys()]).toEqual(["u2"]);
    expect(model.trailingEvents.map((e) => e.id)).toEqual(["e-branch"]);
  });

  it("unknown-anchor events trail; tool rows with no following flow message land in trailingItems", () => {
    const model = buildAgentFeedModel({
      messages: [
        message({ id: "u1", role: "user", content: "go" }),
        message({ id: "r1", role: "assistant", content: "", reasoning: "thinking it over" }),
        toolRow("tool1", "c1", JSON.stringify({ toolName: "write_buffer", output: { target: "rules", proposed: "# R1" } })),
      ],
      events: [rpSyncEvent("e-orphan", "no-such-row")],
      liveToolCallIds: EMPTY_AGENT_FEED_LIVE_TOOL_CALL_IDS,
    });
    expect(model.trailingItems).toHaveLength(1);
    expect(model.trailingItems[0]!.kind).toBe("accordion");
    expect(model.anchoredIds.size).toBe(0);
    expect(model.trailingEvents.map((e) => e.id)).toEqual(["e-orphan"]);
    // A tools-only turn (a reasoning-carrying row, no visible text) earns
    // the TRAILING caption slot — the toggle keeps a site above the
    // trailing group.
    expect(model.captions.trailingCaption).not.toBeNull();
    expect(model.captions.lastTurnSlotId).toBe("trailing");
  });

  it("a live-owned toolCallId suppresses its history card until the live feed clears (dedupe)", () => {
    const model = buildAgentFeedModel({
      messages: [
        message({ id: "u1", role: "user", content: "go" }),
        toolRow("tool1", "c1", JSON.stringify({ toolName: "write_buffer", output: { target: "rules", proposed: "# R1" } })),
        message({ id: "a1", role: "assistant", content: "reply" }),
      ],
      events: EMPTY_AGENT_FEED_EVENTS,
      liveToolCallIds: new Set(["c1"]),
    });
    expect(model.anchorItems.size).toBe(0);
    expect(model.anchoredIds.size).toBe(0);
  });
});

describe("agent-feed-model — memoization (AFP-3)", () => {
  const input = () => ({
    messages: compositeMessages(),
    events: [rpSyncEvent("e-rp", "u2")] as readonly AgentThreadEventWire[],
    liveToolCallIds: EMPTY_AGENT_FEED_LIVE_TOOL_CALL_IDS,
  });

  it("equal input identities return the SAME snapshot object — a live flush reruns no fold", () => {
    const a = input();
    const first = memoizedAgentFeedModel(a);
    // The refetch-shaped rerender: live text/reasoning changed, the data
    // identities did not — the snapshot object must survive.
    expect(memoizedAgentFeedModel(a)).toBe(first);
    expect(memoizedAgentFeedModel(a)).toBe(first);
  });

  it("a changed data identity rebuilds the snapshot with equal derived content", () => {
    const first = memoizedAgentFeedModel(input());
    const second = memoizedAgentFeedModel(input());
    expect(second).not.toBe(first);
    expect(second.visibleMessages.map((e) => e.message.id)).toEqual(
      first.visibleMessages.map((e) => e.message.id),
    );
    expect([...second.anchorItems.keys()]).toEqual([...first.anchorItems.keys()]);
  });

  it("row identities are stable across a prepend of older history", () => {
    const newer = compositeMessages();
    const before = buildAgentFeedModel({
      messages: newer,
      events: EMPTY_AGENT_FEED_EVENTS,
      liveToolCallIds: EMPTY_AGENT_FEED_LIVE_TOOL_CALL_IDS,
    });
    const older: ExperienceCopilotMessageWire[] = [];
    for (let i = 1; i <= 50; i++) {
      older.push(message({ id: `old-u${i}`, role: "user", content: `old ${i}` }));
      older.push(message({ id: `old-a${i}`, role: "assistant", content: `old answer ${i}` }));
    }
    const after = buildAgentFeedModel({
      messages: [...older, ...newer],
      events: EMPTY_AGENT_FEED_EVENTS,
      liveToolCallIds: EMPTY_AGENT_FEED_LIVE_TOOL_CALL_IDS,
    });
    // The previously loaded rows keep their ARRAY POSITIONS relative to the
    // flow's end and their message object references — the prepend only
    // adds rows above them (stable identities across prepend).
    const offset = after.visibleMessages.length - before.visibleMessages.length;
    expect(offset).toBe(100);
    for (let i = 0; i < before.visibleMessages.length; i++) {
      expect(after.visibleMessages[offset + i]!.message).toBe(before.visibleMessages[i]!.message);
    }
  });

  it("the memo holds several feeds' inputs without thrashing (capacity slots)", () => {
    const a = input();
    const b = input();
    const c = input();
    const modelA = memoizedAgentFeedModel(a);
    memoizedAgentFeedModel(b);
    memoizedAgentFeedModel(c);
    // Alternating feeds: both stay warm (capacity 3), same snapshots back.
    expect(memoizedAgentFeedModel(a)).toBe(modelA);
    expect(memoizedAgentFeedModel(b)).toBe(memoizedAgentFeedModel(b));
  });
});
