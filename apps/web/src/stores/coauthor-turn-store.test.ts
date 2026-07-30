import { describe, expect, it, beforeEach } from "bun:test";
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
      args: {},
      status: "done",
      target: "profile",
      proposed: "# EXAMPLES\nUpdated",
      summary: "Updated examples",
      greetingIndex: undefined,
      isAdd: undefined,
    }]);
  });

  it("CTX-S6: recognizes a read_skill_file result as a done read (not an error card)", () => {
    // A read result is {path, content} — it must NOT fall through the proposal
    // schema (which would flag it error). The extractor keys off the carrier
    // tool name and emits a done read activity carrying readPath.
    const messages = [
      { id: "user_new", role: "user", content: "use general-writing" },
      {
        id: "assistant_call",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_read", name: "read_skill_file", args: { path: "general-writing/SKILL.md" } }],
      },
      {
        id: "tool_read",
        role: "tool",
        toolCallId: "call_read",
        content: JSON.stringify({ path: "general-writing/SKILL.md", content: "# General Writing\nWrite vivid prose." }),
      },
      { id: "assistant_final", role: "assistant", content: "Done" },
    ] as AppMessage[];

    expect(extractPersistedCoauthorActivities(messages)).toEqual([{
      toolCallId: "call_read",
      toolName: "read_skill_file",
      args: { path: "general-writing/SKILL.md" },
      status: "done",
      readPath: "general-writing/SKILL.md",
    }]);
  });

  it("CTX-S6: a read activity coexists with a later proposal in the same turn", () => {
    const messages = [
      { id: "user_new", role: "user", content: "polish it" },
      {
        id: "assistant_read",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_read", name: "read_skill_file", args: { path: "general-writing/SKILL.md" } }],
      },
      {
        id: "tool_read",
        role: "tool",
        toolCallId: "call_read",
        content: JSON.stringify({ path: "general-writing/SKILL.md", content: "# General Writing" }),
      },
      {
        id: "assistant_write",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_write", name: "write_profile", args: {} }],
      },
      {
        id: "tool_write",
        role: "tool",
        toolCallId: "call_write",
        content: JSON.stringify({ target: "profile", proposed: "---\nname: A\n---\n# PERSONALITY\nBold", summary: "sharpen" }),
      },
      { id: "assistant_final", role: "assistant", content: "Done" },
    ] as AppMessage[];

    const acts = extractPersistedCoauthorActivities(messages);
    expect(acts).toHaveLength(2);
    expect(acts[0]).toMatchObject({ toolName: "read_skill_file", status: "done", readPath: "general-writing/SKILL.md" });
    expect(acts[1]).toMatchObject({ toolName: "write_profile", status: "done", target: "profile", proposed: expect.stringContaining("Bold") });
  });

  it("retains the operation input (args) for edit and write tools", () => {
    // The carrier assistant toolCalls entry carries the operation INPUT (args);
    // the extractor correlates it with the tool result so a later operation card
    // can render a scoped SEARCH/REPLACE or section-write preview.
    const editArgs = { edits: [{ search: "old", replace: "new" }], summary: "swap" };
    const writeArgs = { content: "# fresh body", summary: "fill scenario" };
    const messages = [
      { id: "user_new", role: "user", content: "work" },
      {
        id: "assistant_call",
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_edit", name: "edit_personality", args: editArgs },
          { id: "call_write", name: "write_scenario", args: writeArgs },
        ],
      },
      { id: "tool_edit", role: "tool", toolCallId: "call_edit", content: JSON.stringify({ target: "profile", proposed: "---\nname: A\n---\n# PERSONALITY\nnew", summary: "swap" }) },
      { id: "tool_write", role: "tool", toolCallId: "call_write", content: JSON.stringify({ target: "profile", proposed: "---\nname: A\n---\n# SCENARIO\n# fresh body", summary: "fill scenario" }) },
    ] as AppMessage[];

    const acts = extractPersistedCoauthorActivities(messages);
    expect(acts).toHaveLength(2);
    expect(acts[0]).toMatchObject({ toolCallId: "call_edit", toolName: "edit_personality", args: editArgs });
    expect(acts[1]).toMatchObject({ toolCallId: "call_write", toolName: "write_scenario", args: writeArgs });
  });

  it("reconstructs operation input from selected-variant fields used by the real chat snapshot", () => {
    // GET /api/chats/:id does not flatten variant-scoped tool fields onto the
    // AppMessage. Both assistant toolCalls and tool-result toolCallId live on
    // the selected variant. The extractor must follow that real wire shape;
    // otherwise valid persisted args become "operation details unavailable".
    const editArgs = { edits: [{ search: "old", replace: "new" }], summary: "swap" };
    const messages = [
      { id: "user_new", role: "user", content: "work", variants: [], selectedVariantIndex: null },
      {
        id: "assistant_call",
        role: "assistant",
        content: "",
        variants: [{
          id: "variant_call",
          variantIndex: 0,
          isSelected: true,
          toolCalls: [{ id: "call_edit", name: "edit_personality", args: editArgs }],
          toolCallId: null,
        }],
        selectedVariantIndex: 0,
      },
      {
        id: "tool_edit",
        role: "tool",
        content: JSON.stringify({ target: "profile", proposed: "---\nname: A\n---\n# PERSONALITY\nnew", summary: "swap" }),
        variants: [{
          id: "variant_result",
          variantIndex: 0,
          isSelected: true,
          toolCalls: null,
          toolCallId: "call_edit",
        }],
        selectedVariantIndex: 0,
      },
    ] as AppMessage[];

    expect(extractPersistedCoauthorActivities(messages)).toEqual([{
      toolCallId: "call_edit",
      toolName: "edit_personality",
      args: editArgs,
      status: "done",
      target: "profile",
      proposed: "---\nname: A\n---\n# PERSONALITY\nnew",
      summary: "swap",
      greetingIndex: undefined,
      isAdd: undefined,
    }]);
  });

  it("a historical result without a matching carrier call renders with no name/args", () => {
    // Old rows whose assistant toolCalls entry is missing still render safely —
    // they just carry an empty name and no input preview.
    const messages = [
      { id: "user_new", role: "user", content: "work" },
      { id: "orphan_tool", role: "tool", toolCallId: "call_orphan", content: JSON.stringify({ target: "profile", proposed: "---\nname: A\n---\n# PERSONALITY\nX", summary: "orphan" }) },
    ] as AppMessage[];

    const acts = extractPersistedCoauthorActivities(messages);
    expect(acts).toHaveLength(1);
    expect(acts[0]).toEqual({
      toolCallId: "call_orphan",
      toolName: "",
      args: undefined,
      status: "done",
      target: "profile",
      proposed: "---\nname: A\n---\n# PERSONALITY\nX",
      summary: "orphan",
      greetingIndex: undefined,
      isAdd: undefined,
    });
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

  it("a tool-result merge preserves the args captured by the earlier tool-call event", () => {
    // Streaming path: onToolCall captures args; onToolResult later merges result
    // fields without re-passing args. The store's merge-by-toolCallId must not
    // erase the already-captured input (CED-5).
    const store = useCoauthorTurnStore.getState();
    const editArgs = { edits: [{ search: "a", replace: "b" }], summary: "s" };
    store.upsertActivity("chat_1", { toolCallId: "call_1", toolName: "edit_personality", args: editArgs, status: "streaming" });
    store.upsertActivity("chat_1", {
      toolCallId: "call_1",
      toolName: "edit_personality",
      status: "done",
      target: "profile",
      proposed: "---\nname: A\n---\n# PERSONALITY\nb",
      summary: "s",
    });
    const acts = useCoauthorTurnStore.getState().getActivities("chat_1");
    expect(acts).toHaveLength(1);
    expect(acts[0].args).toStrictEqual(editArgs);
    expect(acts[0].status).toBe("done");
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
