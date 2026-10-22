/**
 * AgentPermissionState (SC-23f) — the `read_message_prompt` permission
 * lifecycle: the awaiting marker parses verbatim, the granted/denied
 * rewrites resolve by status, and the persisted extraction turns marker rows
 * into `permission` activities (ONE parser for the live SSE path and the
 * persisted rows, so the two cannot drift).
 */
import { describe, expect, it } from "bun:test";
import {
  extractPersistedAgentActivities,
  parseAgentPermissionState,
} from "./agent-turn-store.js";

const MARKER = {
  status: "awaiting_permission",
  position: 7,
  variantNumber: 2,
  replyFirstLine: "First line of the swipe",
  promptTokens: 1234,
  presetName: "Preset",
};

describe("parseAgentPermissionState (SC-23f)", () => {
  it("parses the awaiting marker verbatim (everything the card renders)", () => {
    expect(parseAgentPermissionState(MARKER)).toEqual({
      status: "awaiting_permission",
      position: 7,
      variantNumber: 2,
      replyFirstLine: "First line of the swipe",
      promptTokens: 1234,
      presetName: "Preset",
    });
  });

  it("parses the denied rewrite (status only — the card shows the label)", () => {
    expect(parseAgentPermissionState({ status: "denied" })).toEqual({ status: "denied" });
  });

  it("parses the granted rewrite (status plus whatever identity the row kept)", () => {
    expect(
      parseAgentPermissionState({ status: "granted", position: 7, variantNumber: 2, promptTokens: 1234 }),
    ).toEqual({ status: "granted", position: 7, variantNumber: 2, promptTokens: 1234 });
  });

  it("returns null for an unknown status, a non-object, and an awaiting marker missing the card's rendered fields", () => {
    expect(parseAgentPermissionState({ status: "done" })).toBeNull();
    expect(parseAgentPermissionState("junk")).toBeNull();
    expect(parseAgentPermissionState(null)).toBeNull();
    expect(parseAgentPermissionState({ status: "awaiting_permission" })).toBeNull();
    expect(parseAgentPermissionState({ ...MARKER, replyFirstLine: "" })).toBeNull();
    const { variantNumber: _droppedVariant, ...noVariant } = MARKER;
    expect(parseAgentPermissionState(noVariant)).toBeNull();
    const { promptTokens: _droppedTokens, ...noTokens } = MARKER;
    expect(parseAgentPermissionState(noTokens)).toBeNull();
  });
});

describe("extractor read_message_prompt branch (SC-23f, persisted shapes)", () => {
  const carrier = {
    id: "carrier",
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call_perm", name: "read_message_prompt", args: { position: 7, variant: 2 } }],
  };

  it("a marker row (wrapped output) becomes a done activity carrying the permission state", () => {
    const messages = [
      { id: "u1", role: "user", content: "which prompt wrote this swipe?" },
      carrier,
      {
        id: "tool_perm",
        role: "tool",
        toolCallId: "call_perm",
        content: JSON.stringify({ toolName: "read_message_prompt", output: MARKER }),
      },
    ];

    expect(extractPersistedAgentActivities(messages)).toEqual([{
      toolCallId: "call_perm",
      toolName: "read_message_prompt",
      args: { position: 7, variant: 2 },
      status: "done",
      permission: {
        status: "awaiting_permission",
        position: 7,
        variantNumber: 2,
        replyFirstLine: "First line of the swipe",
        promptTokens: 1234,
        presetName: "Preset",
      },
    }]);
  });

  it("a denied row becomes a done activity with the denied status (the card reads the row)", () => {
    const messages = [
      { id: "u1", role: "user", content: "which prompt wrote this swipe?" },
      carrier,
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
      permission: { status: "denied" },
    }]);
  });

  it("a malformed marker row renders the error card with the raw content (never a permission card)", () => {
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
});
