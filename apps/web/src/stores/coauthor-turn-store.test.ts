import { describe, expect, it, beforeEach } from "vitest";
import { extractPersistedCoauthorActivities, useCoauthorTurnStore } from "./coauthor-turn-store.js";
import type { AppMessage } from "../api/types.js";

describe("useCoauthorTurnStore", () => {
  beforeEach(() => {
    // Reset to a clean state before each case (the store is process-global).
    useCoauthorTurnStore.setState({ turnsByChat: {} });
  });

  it("rebuilds only the latest committed non-streaming turn with tool names and proposals", () => {
    const messages = [
      { id: "user_old", role: "user", content: "old" },
      { id: "tool_old", role: "tool", toolCallId: "call_old", content: "{}" },
      { id: "user_new", role: "user", content: "edit examples" },
      {
        id: "assistant_call",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_new", name: "edit_examples", args: {} }],
      },
      {
        id: "tool_new",
        role: "tool",
        toolCallId: "call_new",
        content: JSON.stringify({
          target: "profile",
          proposed: "# EXAMPLES\nUpdated",
          summary: "Updated examples",
        }),
      },
      { id: "assistant_final", role: "assistant", content: "Done" },
    ] as AppMessage[];

    expect(extractPersistedCoauthorActivities(messages)).toEqual([{
      toolCallId: "call_new",
      toolName: "edit_examples",
      status: "done",
      target: "profile",
      proposed: "# EXAMPLES\nUpdated",
      summary: "Updated examples",
      greetingIndex: undefined,
      isAdd: undefined,
    }]);
  });

  it("normalizes the legacy `edit_profile` tool name to `write_profile` on reload", () => {
    // Historical committed turns (pre-rename) carry toolName "edit_profile".
    // The reload path aliases it so the activity store always sees the canonical name
    // the current label/render map expects.
    const messages = [
      { id: "user_new", role: "user", content: "rewrite the profile" },
      {
        id: "assistant_call",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_legacy", name: "edit_profile", args: {} }],
      },
      {
        id: "tool_legacy",
        role: "tool",
        toolCallId: "call_legacy",
        content: JSON.stringify({ target: "profile", proposed: "---\nname: A\n---\n# PERSONALITY\nX.", summary: "Rewrote." }),
      },
    ] as AppMessage[];

    const acts = extractPersistedCoauthorActivities(messages);
    expect(acts).toHaveLength(1);
    expect(acts[0].toolName).toBe("write_profile");
  });

  it("inserts a new activity for a chat", () => {
    const store = useCoauthorTurnStore.getState();
    store.upsertActivity("chat_1", { toolCallId: "call_1", toolName: "write_profile", status: "streaming" });
    expect(useCoauthorTurnStore.getState().getActivities("chat_1")).toEqual([
      { toolCallId: "call_1", toolName: "write_profile", status: "streaming" },
    ]);
  });

  it("accumulates multiple activities for a chat in insertion order", () => {
    const store = useCoauthorTurnStore.getState();
    store.upsertActivity("chat_1", { toolCallId: "call_a", toolName: "write_profile", status: "streaming" });
    store.upsertActivity("chat_1", { toolCallId: "call_b", toolName: "edit_greeting", status: "streaming" });
    const acts = useCoauthorTurnStore.getState().getActivities("chat_1");
    expect(acts.map((a) => a.toolCallId)).toEqual(["call_a", "call_b"]);
  });

  it("merges by toolCallId so a streaming placeholder is finalized in place by tool-result", () => {
    // Simulates the real event order: tool-call (streaming) → tool-result (done + proposal).
    const store = useCoauthorTurnStore.getState();
    store.upsertActivity("chat_1", { toolCallId: "call_1", toolName: "write_profile", status: "streaming" });
    store.upsertActivity("chat_1", {
      toolCallId: "call_1",
      toolName: "write_profile",
      status: "done",
      target: "profile",
      proposed: "---\nname: A\n---\n# PERSONALITY\nBold.",
      summary: "Made the personality more assertive.",
    });
    const acts = useCoauthorTurnStore.getState().getActivities("chat_1");
    expect(acts).toHaveLength(1);
    expect(acts[0]).toEqual({
      toolCallId: "call_1",
      toolName: "write_profile",
      status: "done",
      target: "profile",
      proposed: "---\nname: A\n---\n# PERSONALITY\nBold.",
      summary: "Made the personality more assertive.",
    });
  });

  it("clearTurn drops the chat's activities", () => {
    const store = useCoauthorTurnStore.getState();
    store.upsertActivity("chat_1", { toolCallId: "call_1", toolName: "write_profile", status: "done" });
    store.upsertActivity("chat_2", { toolCallId: "call_2", toolName: "edit_greeting", status: "done" });
    useCoauthorTurnStore.getState().clearTurn("chat_1");
    expect(useCoauthorTurnStore.getState().getActivities("chat_1")).toEqual([]);
    // Other chats are untouched.
    expect(useCoauthorTurnStore.getState().getActivities("chat_2")).toHaveLength(1);
  });

  it("clearTurn on a chat with no activities is a no-op (state ref unchanged)", () => {
    useCoauthorTurnStore.getState().upsertActivity("chat_1", { toolCallId: "call_1", toolName: "write_profile", status: "done" });
    const before = useCoauthorTurnStore.getState().turnsByChat;
    useCoauthorTurnStore.getState().clearTurn("chat_unknown");
    expect(useCoauthorTurnStore.getState().turnsByChat).toBe(before);
  });

  it("getActivities returns [] for an unknown chat", () => {
    expect(useCoauthorTurnStore.getState().getActivities("never")).toEqual([]);
  });
});
