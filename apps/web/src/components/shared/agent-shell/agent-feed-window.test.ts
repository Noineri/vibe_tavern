import { describe, expect, it } from "bun:test";
import type { AgentThreadEventWire, ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { buildAgentFeedModel, EMPTY_AGENT_FEED_EVENTS, EMPTY_AGENT_FEED_LIVE_TOOL_CALL_IDS } from "./agent-feed-model.js";
import {
  agentFeedRenderUnits,
  agentFeedUnitIds,
  isNullCarrierMessage,
  partitionAgentFeedWindow,
  type AgentFeedRenderUnit,
} from "./agent-feed-window.js";

// AFP-3 (AGENT_FEED_PERFORMANCE_PLAN Wave 1 step 4): pins for the render-unit
// model and the stable-append-coordinate window partition. The unit-order
// pins mirror the AFP-1 characterization document order at the data level —
// the AFP-6 port renders THESE units and must reproduce that DOM order.
// Pure T0 — no DOM, no doubles.

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

function carrier(id: string, calls: string): ExperienceCopilotMessageWire {
  return message({ id, role: "assistant", content: "", toolCallsJson: calls });
}

function toolRow(id: string, toolCallId: string, content: string): ExperienceCopilotMessageWire {
  return message({ id, role: "tool", toolCallId, content });
}

function rpSyncEvent(id: string, beforeMessageId: string | null): AgentThreadEventWire {
  return { id, kind: "rp_sync", beforeMessageId, payload: { fromPosition: 0, toPosition: 1, messages: [] } };
}

function branchForkedEvent(id: string): AgentThreadEventWire {
  return { id, kind: "branch_forked", beforeMessageId: null, payload: { at: 12 } };
}

const EMPTY_CALLS = JSON.stringify([]);

function compositeUnits() {
  const model = buildAgentFeedModel({
    messages: [
      message({ id: "u1", role: "user", content: "first question" }),
      carrier("carrier1", JSON.stringify([
        { type: "tool-call", toolCallId: "c1", toolName: "write_buffer", input: { buffer: "rules" } },
      ])),
      toolRow("tool1", "c1", JSON.stringify({
        toolName: "write_buffer",
        output: { target: "rules", proposed: "# R1", summary: "first pass" },
      })),
      message({ id: "a1", role: "assistant", content: "first reply" }),
      message({ id: "u2", role: "user", content: "second question" }),
      carrier("carrier2", JSON.stringify([
        { type: "tool-call", toolCallId: "c-perm", toolName: "read_message_prompt", input: { position: 5 } },
      ])),
      toolRow("toolp", "c-perm", JSON.stringify({
        toolName: "read_message_prompt",
        output: { status: "awaiting_permission", position: 5, variantNumber: 2, replyFirstLine: "x", promptTokens: 1200 },
      })),
      carrier("carriera", JSON.stringify([
        { type: "tool-call", toolCallId: "tc-ask", toolName: "ask_user", input: { question: "Which buffer?" } },
      ])),
      toolRow("toola", "tc-ask", JSON.stringify({
        toolName: "ask_user",
        output: { status: "awaiting_answer", question: "Which buffer?", options: ["Rules", "Visual"] },
      })),
      message({ id: "a4", role: "assistant", content: "second reply" }),
      message({ id: "d1", role: "digest", content: "summary", toolCallId: "u2" }),
    ],
    events: [rpSyncEvent("e-rp", "u2"), branchForkedEvent("e-branch"), rpSyncEvent("e-orphan", "no-such-row")],
    liveToolCallIds: EMPTY_AGENT_FEED_LIVE_TOOL_CALL_IDS,
  });
  return model;
}

function kindSeq(units: readonly AgentFeedRenderUnit[]): string[] {
  return units.map((u) => u.kind);
}

describe("agent-feed-window — render units (AFP-3)", () => {
  it("reproduces the AFP-1 composite document order with namespaced stable unit ids", () => {
    const units = agentFeedRenderUnits({
      model: compositeUnits(),
      tail: { hasPendingUser: true },
    });

    expect(units.map((u) => u.unitId)).toEqual([
      // Turn 1: the carrier produces NO unit; its turn's caption+accordion
      // anchor at a1 (the next flow row with content).
      "msg:u1",
      "caption:a1",
      "card:accordion:c1",
      "msg:a1",
      // Turn 2: the anchored event precedes the anchor's row; the caption
      // sits above the anchored card cluster (at the carrier's slot).
      "event:e-rp",
      "msg:u2",
      "caption:carriera",
      "card:permission:c-perm",
      "card:ask:tc-ask",
      "msg:a4",
      // The digest at its own slot; trailing events (null + unknown anchor)
      // in events order, BEFORE the optimistic pending row.
      "msg:d1",
      "event:e-branch",
      "event:e-orphan",
      "pending-user",
    ]);
    // One caption per assistant turn — exactly two caption units.
    expect(units.filter((u) => u.kind === "caption")).toHaveLength(2);
  });

  it("null carriers are excluded from render units (never zero-height virtual items)", () => {
    const units = agentFeedRenderUnits({ model: compositeUnits() });
    const ids = agentFeedUnitIds(units);
    expect(ids).not.toContain("msg:carrier1");
    expect(ids).not.toContain("msg:carrier2");
    expect(ids).not.toContain("msg:carriera");
    // …while the cards/captions anchored AT a carrier keep their slot.
    expect(ids).toContain("caption:carriera");
    expect(ids).toContain("card:permission:c-perm");
    // The carrier predicate itself (empty assistant text + tool calls).
    expect(isNullCarrierMessage(carrier("c", EMPTY_CALLS))).toBe(true);
    expect(isNullCarrierMessage(message({ id: "a", role: "assistant", content: "" }))).toBe(false);
    expect(isNullCarrierMessage(message({ id: "u", role: "user", content: "" }))).toBe(false);
  });

  it("keeps attachment-only carrier bodies but omits every truly empty body without losing its events", () => {
    const attached = carrier("attached", EMPTY_CALLS);
    attached.attachments = [{ id: "attachment", type: "image", assetId: "asset", mimeType: "image/png", name: "photo.png", sizeBytes: 100 }];
    const model = buildAgentFeedModel({
      messages: [message({ id: "empty-user", content: "" }),
        message({ id: "empty-assistant", role: "assistant", content: "" }), attached],
      events: [branchForkedEvent("trailing"), rpSyncEvent("anchored", "empty-assistant")],
      liveToolCallIds: EMPTY_AGENT_FEED_LIVE_TOOL_CALL_IDS,
    });
    expect(isNullCarrierMessage(attached)).toBe(false);
    expect(agentFeedUnitIds(agentFeedRenderUnits({ model }))).toEqual([
      "event:anchored", "msg:attached", "event:trailing",
    ]);
  });

  it("hidden anchors (AP-29 regenerate cut) drop their whole fragment; trailing events survive", () => {
    const units = agentFeedRenderUnits({
      model: compositeUnits(),
      hiddenMessageIds: new Set(["carriera", "a4"]),
      hideTrailingAnchors: true,
    });
    expect(agentFeedUnitIds(units)).toEqual([
      "msg:u1",
      "caption:a1",
      "card:accordion:c1",
      "msg:a1",
      "event:e-rp",
      "msg:u2",
      "msg:d1",
      "event:e-branch",
      "event:e-orphan",
    ]);
  });

  it("the mid-turn tail renders in the flat list's fixed order", () => {
    const units = agentFeedRenderUnits({
      model: compositeUnits(),
      tail: {
        hasPendingUser: true,
        hasLiveCaption: true,
        liveRows: [
          { kind: "ask", id: "tc-live" },
          { kind: "accordion", id: "c9" },
          { kind: "text", id: "seg-1", streaming: true },
          { kind: "text", id: "seg-2" },
        ],
        hasPendingAssistant: true,
        hasFailure: true,
      },
    });
    expect(kindSeq(units.slice(-8))).toEqual([
      "pending-user", "live-caption", "live", "live", "live", "live", "pending-assistant", "failure",
    ]);
    expect(units.slice(-8).map((u) => u.unitId)).toEqual([
      "pending-user", "live-caption", "live:ask:tc-live", "live:accordion:c9",
      "live:seg-1", "live:seg-2", "pending-assistant", "turn-failure",
    ]);
    // The streaming flag rides the text segment's unit (AFP-6 streams the
    // open segment only).
    const streaming = units.find((u) => u.unitId === "live:seg-1");
    expect(streaming !== undefined && streaming.kind === "live" && streaming.row.streaming).toBe(true);
  });

  it("a trailing tool group renders after the flow, before trailing events", () => {
    const model = buildAgentFeedModel({
      messages: [
        message({ id: "u1", role: "user", content: "go" }),
        message({ id: "r1", role: "assistant", content: "", reasoning: "thinking" }),
        toolRow("tool1", "c1", JSON.stringify({ toolName: "write_buffer", output: { target: "rules" } })),
      ],
      events: [branchForkedEvent("e-b")],
      liveToolCallIds: EMPTY_AGENT_FEED_LIVE_TOOL_CALL_IDS,
    });
    const units = agentFeedRenderUnits({ model });
    expect(agentFeedUnitIds(units)).toEqual([
      "msg:u1",
      "caption:trailing",
      "card:accordion:c1",
      "event:e-b",
    ]);
  });
});

describe("agent-feed-window — partition in stable append coordinates (AFP-3)", () => {
  // The partition is pure over the unit array (that is its boundary), so
  // the math pins use synthetic message units with explicit ids — the
  // render-unit derivation above is pinned separately.
  function syntheticUnits(ids: string[]): AgentFeedRenderUnit[] {
    return ids.map((id) => ({
      kind: "message" as const,
      unitId: `msg:${id}`,
      message: message({ id }),
    }));
  }

  function manyIds(count: number, prefix = "m"): string[] {
    return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);
  }

  it("prepending 50 older units does NOT repartition the suffix (the m100 pin)", () => {
    const units = syntheticUnits(manyIds(200));
    const before = partitionAgentFeedWindow(units, 0);
    // 200 units on the 20-grid, 5-page tail: the tail is coordinates
    // 100..199 — the last 100 units.
    expect(before.stableTailStartIndex).toBe(100);
    expect(before.virtualizedUnits).toHaveLength(100);
    expect(before.firstItemIndex).toBe(0);
    const tailIdsBefore = agentFeedUnitIds(before.stableTailUnits);

    // 50 older units prepend: firstItemIndex drops by exactly 50, existing
    // coordinates are unchanged — the SAME units stay mounted.
    const prepended = [...syntheticUnits(manyIds(50, "old")), ...units];
    const after = partitionAgentFeedWindow(prepended, -50);
    expect(after.firstItemIndex).toBe(-50);
    expect(agentFeedUnitIds(after.stableTailUnits)).toEqual(tailIdsBefore);
    // The prepended page is fully virtualized; the core's inverse-scroll
    // contract (firstItemIndex drop == prepended virtual rows) holds.
    expect(after.virtualizedUnits).toHaveLength(150);
    expect(agentFeedUnitIds(after.virtualizedUnits.slice(0, 50)).every((id) => id.startsWith("msg:old"))).toBe(true);
  });

  it("appends retire the OLDEST tail page (page-aligned grid, measured from the head)", () => {
    const base = partitionAgentFeedWindow(syntheticUnits(manyIds(200)), 0);
    const grown = partitionAgentFeedWindow(syntheticUnits(manyIds(221)), 0);
    // 221 units: raw tail start 121 → aligned down to the 20-grid → 120.
    expect(grown.stableTailStartIndex).toBe(120);
    expect(grown.stableTailUnits[0]!.unitId).toBe("msg:m121");
    expect(base.stableTailUnits[0]!.unitId).toBe("msg:m101");
  });

  it("a short feed keeps everything mounted (no virtualized prefix)", () => {
    const window = partitionAgentFeedWindow(syntheticUnits(manyIds(60)), 0);
    expect(window.virtualizedUnits).toHaveLength(0);
    expect(window.stableTailUnits).toHaveLength(60);
    expect(window.stableTailStartIndex).toBe(0);
    // …also when the short feed started after prepends (negative base).
    const negative = partitionAgentFeedWindow(syntheticUnits(manyIds(60)), -40);
    expect(negative.stableTailStartIndex).toBe(0);
    expect(negative.firstItemIndex).toBe(-40);
  });

  it("prepend stability holds on an unaligned head too (coordinates, not array length)", () => {
    const before = partitionAgentFeedWindow(syntheticUnits(manyIds(243)), 0);
    expect(before.stableTailStartIndex).toBe(140);
    const tailIds = agentFeedUnitIds(before.stableTailUnits);
    const after = partitionAgentFeedWindow(
      [...syntheticUnits(manyIds(17, "old")), ...syntheticUnits(manyIds(243))],
      -17,
    );
    expect(agentFeedUnitIds(after.stableTailUnits)).toEqual(tailIds);
  });
});
