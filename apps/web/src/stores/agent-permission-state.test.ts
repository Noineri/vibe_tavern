/**
 * AgentPermissionState (SC-23f + DMT-31) — BOTH permission families through
 * the ONE shared decoder: the legacy `read_message_prompt` lifecycle
 * (awaiting marker parses verbatim, granted/denied rewrites resolve by
 * status) and the Director's `request_message_swipe` (the proposed
 * instruction while awaiting, the FINAL approved text on the granted
 * receipt). Persisted history rows decode through
 * `extractPersistedAgentActivities`, live SSE through the same
 * `decodeAgentPermissionState` — ONE derivation, so the two projections
 * cannot drift, and the `kind` comes from the TOOL NAME alone (a corrupted
 * row's `instruction` field can never turn a prompt read into a swipe).
 */
import { describe, expect, it } from "bun:test";
import { decodeAgentPermissionState } from "@vibe-tavern/api-contracts";
import {
  extractPersistedAgentActivities,
} from "./agent-turn-store.js";

const PROMPT_MARKER = {
  status: "awaiting_permission",
  position: 7,
  variantNumber: 2,
  replyFirstLine: "First line of the swipe",
  promptTokens: 1234,
  presetName: "Preset",
};

const SWIPE_MARKER = {
  status: "awaiting_permission",
  position: 7,
  variantNumber: 2,
  replyFirstLine: "First line of the swipe",
  messageId: "msg-1",
  variantId: "var-2",
  instruction: "Rewrite the reply spicier, keeping the accent",
};

describe("decodeAgentPermissionState — prompt_read family (SC-23f, legacy)", () => {
  it("parses the awaiting marker verbatim (everything the card renders) with the name-derived kind", () => {
    expect(decodeAgentPermissionState("read_message_prompt", PROMPT_MARKER)).toEqual({
      status: "awaiting_permission",
      kind: "prompt_read",
      position: 7,
      variantNumber: 2,
      replyFirstLine: "First line of the swipe",
      promptTokens: 1234,
      presetName: "Preset",
    });
  });

  it("parses the denied rewrite (status only — the card shows the label)", () => {
    expect(decodeAgentPermissionState("read_message_prompt", { status: "denied" })).toEqual({
      status: "denied",
      kind: "prompt_read",
    });
  });

  it("parses the granted rewrite (status plus whatever identity the row kept)", () => {
    expect(
      decodeAgentPermissionState("read_message_prompt", {
        status: "granted",
        position: 7,
        variantNumber: 2,
        promptTokens: 1234,
      }),
    ).toEqual({ status: "granted", kind: "prompt_read", position: 7, variantNumber: 2, promptTokens: 1234 });
  });

  it("returns null for an unknown status, a non-object, and an awaiting marker missing the card's rendered fields", () => {
    expect(decodeAgentPermissionState("read_message_prompt", { status: "done" })).toBeNull();
    expect(decodeAgentPermissionState("read_message_prompt", "junk")).toBeNull();
    expect(decodeAgentPermissionState("read_message_prompt", null)).toBeNull();
    expect(decodeAgentPermissionState("read_message_prompt", { status: "awaiting_permission" })).toBeNull();
    expect(decodeAgentPermissionState("read_message_prompt", { ...PROMPT_MARKER, replyFirstLine: "" })).toBeNull();
    const { variantNumber: _droppedVariant, ...noVariant } = PROMPT_MARKER;
    expect(decodeAgentPermissionState("read_message_prompt", noVariant)).toBeNull();
    const { promptTokens: _droppedTokens, ...noTokens } = PROMPT_MARKER;
    expect(decodeAgentPermissionState("read_message_prompt", noTokens)).toBeNull();
  });
});

describe("decodeAgentPermissionState — swipe family (DMT-11)", () => {
  it("parses the awaiting marker with the proposed instruction in full plus the frozen target identity", () => {
    expect(decodeAgentPermissionState("request_message_swipe", SWIPE_MARKER)).toEqual({
      status: "awaiting_permission",
      kind: "swipe",
      position: 7,
      variantNumber: 2,
      replyFirstLine: "First line of the swipe",
      messageId: "msg-1",
      variantId: "var-2",
      instruction: "Rewrite the reply spicier, keeping the accent",
    });
  });

  it("parses the granted receipt — the FINAL user-approved instruction text (a granted row without one is malformed)", () => {
    expect(
      decodeAgentPermissionState("request_message_swipe", {
        status: "granted",
        messageId: "msg-1",
        variantId: "var-2",
        variantNumber: 2,
        instruction: "final edited text",
      }),
    ).toEqual({
      status: "granted",
      kind: "swipe",
      messageId: "msg-1",
      variantId: "var-2",
      variantNumber: 2,
      instruction: "final edited text",
    });
    expect(
      decodeAgentPermissionState("request_message_swipe", { status: "granted", messageId: "msg-1" }),
    ).toBeNull();
    expect(
      decodeAgentPermissionState("request_message_swipe", { status: "granted", messageId: "msg-1", instruction: "" }),
    ).toBeNull();
  });

  it("parses the denied receipt (status plus whatever identity the row kept — no instruction required)", () => {
    expect(decodeAgentPermissionState("request_message_swipe", { status: "denied", messageId: "msg-1" })).toEqual({
      status: "denied",
      kind: "swipe",
      messageId: "msg-1",
    });
  });

  it("returns null for an awaiting marker missing the instruction, the first line, or the variant number", () => {
    const { instruction: _noInstruction, ...markerWithoutInstruction } = SWIPE_MARKER;
    expect(decodeAgentPermissionState("request_message_swipe", markerWithoutInstruction)).toBeNull();
    expect(decodeAgentPermissionState("request_message_swipe", { ...SWIPE_MARKER, instruction: "" })).toBeNull();
    expect(decodeAgentPermissionState("request_message_swipe", { ...SWIPE_MARKER, replyFirstLine: "" })).toBeNull();
    const { variantNumber: _noVariant, ...markerWithoutVariant } = SWIPE_MARKER;
    expect(decodeAgentPermissionState("request_message_swipe", markerWithoutVariant)).toBeNull();
    expect(decodeAgentPermissionState("request_message_swipe", { status: "resolved" })).toBeNull();
    expect(decodeAgentPermissionState("request_message_swipe", "junk")).toBeNull();
  });
});

describe("decodeAgentPermissionState — name-derived kind is the only source", () => {
  it("a corrupted prompt-read row carrying swipe fields still decodes as a prompt read (no swipe field leaks in)", () => {
    const decoded = decodeAgentPermissionState("read_message_prompt", {
      ...PROMPT_MARKER,
      instruction: "an injected edit",
      messageId: "msg-x",
      variantId: "var-x",
    });
    expect(decoded).toEqual({
      status: "awaiting_permission",
      kind: "prompt_read",
      position: 7,
      variantNumber: 2,
      replyFirstLine: "First line of the swipe",
      promptTokens: 1234,
      presetName: "Preset",
    });
    expect(decoded && ("instruction" in decoded || "messageId" in decoded || "variantId" in decoded)).toBe(false);
  });

  it("an unknown tool name is not a permission row at all", () => {
    expect(decodeAgentPermissionState("write_buffer", SWIPE_MARKER)).toBeNull();
    expect(decodeAgentPermissionState("", SWIPE_MARKER)).toBeNull();
  });
});

// ─── History ingestion (persisted rows through the extractor) ────────────────

const PROMPT_CARRIER = {
  id: "carrier",
  role: "assistant",
  content: "",
  toolCalls: [{ id: "call_perm", name: "read_message_prompt", args: { position: 7, variant: 2 } }],
};

const SWIPE_CARRIER = {
  id: "carrier-swipe",
  role: "assistant",
  content: "",
  toolCalls: [{ id: "call_swipe", name: "request_message_swipe", args: { messageId: "msg-1", variantId: "var-2" } }],
};

describe("extractor permission branch (DMT-31, persisted shapes)", () => {
  it("a legacy prompt-read marker row (pre-DMT-11 output, no kind) decodes with the kind derived from the name", () => {
    const messages = [
      { id: "u1", role: "user", content: "which prompt wrote this swipe?" },
      PROMPT_CARRIER,
      {
        id: "tool_perm",
        role: "tool",
        toolCallId: "call_perm",
        content: JSON.stringify({ toolName: "read_message_prompt", output: PROMPT_MARKER }),
      },
    ];

    expect(extractPersistedAgentActivities(messages)).toEqual([{
      toolCallId: "call_perm",
      toolName: "read_message_prompt",
      args: { position: 7, variant: 2 },
      status: "done",
      permission: {
        status: "awaiting_permission",
        kind: "prompt_read",
        position: 7,
        variantNumber: 2,
        replyFirstLine: "First line of the swipe",
        promptTokens: 1234,
        presetName: "Preset",
      },
    }]);
  });

  it("a legacy prompt-read denied row becomes a done activity with the denied status (the card reads the row)", () => {
    const messages = [
      { id: "u1", role: "user", content: "which prompt wrote this swipe?" },
      PROMPT_CARRIER,
      {
        id: "tool_perm",
        role: "tool",
        toolCallId: "call_perm",
        content: JSON.stringify({ toolName: "read_message_prompt", output: { status: "denied" } }),
      },
    ];

    expect(extractPersistedAgentActivities(messages)).toEqual([{
      toolCallId: "call_perm",
      toolName: "read_message_prompt",
      args: { position: 7, variant: 2 },
      status: "done",
      permission: { status: "denied", kind: "prompt_read" },
    }]);
  });

  it("a swipe awaiting row becomes a done activity carrying the proposed instruction and the frozen target", () => {
    const messages = [
      { id: "u1", role: "user", content: "give me another variant" },
      SWIPE_CARRIER,
      {
        id: "tool_swipe",
        role: "tool",
        toolCallId: "call_swipe",
        content: JSON.stringify({ toolName: "request_message_swipe", output: SWIPE_MARKER }),
      },
    ];

    expect(extractPersistedAgentActivities(messages)).toEqual([{
      toolCallId: "call_swipe",
      toolName: "request_message_swipe",
      args: { messageId: "msg-1", variantId: "var-2" },
      status: "done",
      permission: {
        status: "awaiting_permission",
        kind: "swipe",
        position: 7,
        variantNumber: 2,
        replyFirstLine: "First line of the swipe",
        messageId: "msg-1",
        variantId: "var-2",
        instruction: "Rewrite the reply spicier, keeping the accent",
      },
    }]);
  });

  it("a swipe granted row carries the FINAL approved instruction (what the generation ran with)", () => {
    const messages = [
      { id: "u1", role: "user", content: "give me another variant" },
      SWIPE_CARRIER,
      {
        id: "tool_swipe",
        role: "tool",
        toolCallId: "call_swipe",
        content: JSON.stringify({
          toolName: "request_message_swipe",
          output: {
            status: "granted",
            messageId: "msg-1",
            variantId: "var-2",
            variantNumber: 2,
            instruction: "final edited text",
          },
        }),
      },
    ];

    expect(extractPersistedAgentActivities(messages)).toEqual([{
      toolCallId: "call_swipe",
      toolName: "request_message_swipe",
      args: { messageId: "msg-1", variantId: "var-2" },
      status: "done",
      permission: {
        status: "granted",
        kind: "swipe",
        messageId: "msg-1",
        variantId: "var-2",
        variantNumber: 2,
        instruction: "final edited text",
      },
    }]);
  });

  it("a swipe denied row keeps only the status and the identity the row retained", () => {
    const messages = [
      { id: "u1", role: "user", content: "give me another variant" },
      SWIPE_CARRIER,
      {
        id: "tool_swipe",
        role: "tool",
        toolCallId: "call_swipe",
        content: JSON.stringify({ toolName: "request_message_swipe", output: { status: "denied" } }),
      },
    ];

    expect(extractPersistedAgentActivities(messages)).toEqual([{
      toolCallId: "call_swipe",
      toolName: "request_message_swipe",
      args: { messageId: "msg-1", variantId: "var-2" },
      status: "done",
      permission: { status: "denied", kind: "swipe" },
    }]);
  });

  it("a malformed prompt-read marker row renders the error card with the raw content (never a permission card)", () => {
    const bad = { status: "awaiting_permission", position: 7 };
    const messages = [
      { id: "u1", role: "user", content: "which prompt wrote this swipe?" },
      {
        id: "tool_perm",
        role: "tool",
        toolCallId: "call_perm",
        content: JSON.stringify({ toolName: "read_message_prompt", output: bad }),
      },
    ];

    const [activity] = extractPersistedAgentActivities(messages);
    expect(activity).toMatchObject({ toolCallId: "call_perm", toolName: "read_message_prompt", status: "error" });
    expect(activity!.permission).toBeUndefined();
    expect(activity!.summary).toBe(JSON.stringify({ toolName: "read_message_prompt", output: bad }));
  });

  it("a corrupted swipe row (awaiting without the proposed instruction) renders the error card too", () => {
    const bad = { status: "awaiting_permission", replyFirstLine: "x", variantNumber: 2 };
    const messages = [
      { id: "u1", role: "user", content: "give me another variant" },
      {
        id: "tool_swipe",
        role: "tool",
        toolCallId: "call_swipe",
        content: JSON.stringify({ toolName: "request_message_swipe", output: bad }),
      },
    ];

    const [activity] = extractPersistedAgentActivities(messages);
    expect(activity).toMatchObject({ toolCallId: "call_swipe", toolName: "request_message_swipe", status: "error" });
    expect(activity!.permission).toBeUndefined();
    expect(activity!.summary).toBe(JSON.stringify({ toolName: "request_message_swipe", output: bad }));
  });
});
