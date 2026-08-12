import { describe, expect, it, beforeEach } from "bun:test";
import { extractPersistedExperienceCopilotActivities, useExperienceCopilotTurnStore } from "./experience-copilot-turn-store.js";
import type { AppMessage } from "../api/types.js";

describe("useExperienceCopilotTurnStore", () => {
  beforeEach(() => {
    // Reset to a clean state before each case (the store is process-global).
    useExperienceCopilotTurnStore.setState({ turnsByThread: {} });
  });

  it("rebuilds only the latest committed non-streaming turn with tool names and proposals", () => {
    const messages = [
      { id: "user_old", role: "user", content: "old" },
      { id: "tool_old", role: "tool", toolCallId: "call_old", content: "{}" },
      { id: "user_new", role: "user", content: "edit the rules" },
      {
        id: "assistant_call",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_new", name: "write_buffer", args: { buffer: "rules" } }],
      },
      {
        id: "tool_new",
        role: "tool",
        toolCallId: "call_new",
        content: JSON.stringify({
          target: "rules",
          proposed: "---\nname: A\n---\n# RULES\nUpdated",
          summary: "Updated rules",
        }),
      },
      { id: "assistant_final", role: "assistant", content: "Done" },
    ] as AppMessage[];

    expect(extractPersistedExperienceCopilotActivities(messages)).toEqual([{
      toolCallId: "call_new",
      toolName: "write_buffer",
      args: { buffer: "rules" },
      status: "done",
      target: "rules",
      proposed: "---\nname: A\n---\n# RULES\nUpdated",
      summary: "Updated rules",
    }]);
  });

  it("recognizes a read_skill_file result as a done read (not an error card)", () => {
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

    expect(extractPersistedExperienceCopilotActivities(messages)).toEqual([{
      toolCallId: "call_read",
      toolName: "read_skill_file",
      args: { path: "general-writing/SKILL.md" },
      status: "done",
      readPath: "general-writing/SKILL.md",
    }]);
  });

  it("a read activity coexists with a later proposal in the same turn", () => {
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
        toolCalls: [{ id: "call_write", name: "write_buffer", args: { buffer: "rules" } }],
      },
      {
        id: "tool_write",
        role: "tool",
        toolCallId: "call_write",
        content: JSON.stringify({ target: "rules", proposed: "---\n# RULES\nBold", summary: "sharpen" }),
      },
      { id: "assistant_final", role: "assistant", content: "Done" },
    ] as AppMessage[];

    const acts = extractPersistedExperienceCopilotActivities(messages);
    expect(acts).toHaveLength(2);
    expect(acts[0]).toMatchObject({ toolName: "read_skill_file", status: "done", readPath: "general-writing/SKILL.md" });
    expect(acts[1]).toMatchObject({ toolName: "write_buffer", status: "done", target: "rules", proposed: expect.stringContaining("Bold") });
  });

  it("retains the operation input (args) for edit and write tools", () => {
    // The carrier assistant toolCalls entry carries the operation INPUT (args);
    // the extractor correlates it with the tool result so a later operation card
    // can render a scoped SEARCH/REPLACE or buffer-write preview.
    const editArgs = { edits: [{ search: "old", replace: "new" }], summary: "swap" };
    const writeArgs = { content: "# fresh rules", summary: "fill scenario" };
    const messages = [
      { id: "user_new", role: "user", content: "work" },
      {
        id: "assistant_call",
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_edit", name: "edit_buffer", args: editArgs },
          { id: "call_write", name: "write_buffer", args: writeArgs },
        ],
      },
      { id: "tool_edit", role: "tool", toolCallId: "call_edit", content: JSON.stringify({ target: "rules", proposed: "---\n# RULES\nnew", summary: "swap" }) },
      { id: "tool_write", role: "tool", toolCallId: "call_write", content: JSON.stringify({ target: "visual", proposed: "---\n# VISUAL\n# fresh", summary: "fill scenario" }) },
    ] as AppMessage[];

    const acts = extractPersistedExperienceCopilotActivities(messages);
    expect(acts).toHaveLength(2);
    expect(acts[0]).toMatchObject({ toolCallId: "call_edit", toolName: "edit_buffer", args: editArgs });
    expect(acts[1]).toMatchObject({ toolCallId: "call_write", toolName: "write_buffer", args: writeArgs });
  });

  it("routes run_test/simulate/suggest results to a done-with-raw-content card", () => {
    // The read-only, non-proposal tools (run_test, run_simulate,
    // suggest_visual_binding) return digest shapes that never enter proposal
    // aggregation. The extractor's fallback branch emits a graceful done card
    // whose summary is the raw tool-result content.
    const runTestContent = JSON.stringify({ passed: true, failures: [] });
    const messages = [
      { id: "user_new", role: "user", content: "run the tests" },
      {
        id: "assistant_call",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_test", name: "run_test", args: { testName: "smoke" } }],
      },
      { id: "tool_test", role: "tool", toolCallId: "call_test", content: runTestContent },
      { id: "assistant_final", role: "assistant", content: "Done" },
    ] as AppMessage[];

    expect(extractPersistedExperienceCopilotActivities(messages)).toEqual([{
      toolCallId: "call_test",
      toolName: "run_test",
      args: { testName: "smoke" },
      status: "done",
      summary: runTestContent,
    }]);
  });

  it("reconstructs operation input from selected-variant fields used by the real snapshot", () => {
    // The commit path may not flatten variant-scoped tool fields onto the
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
          toolCalls: [{ id: "call_edit", name: "edit_buffer", args: editArgs }],
          toolCallId: null,
        }],
        selectedVariantIndex: 0,
      },
      {
        id: "tool_edit",
        role: "tool",
        content: JSON.stringify({ target: "rules", proposed: "---\n# RULES\nnew", summary: "swap" }),
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

    expect(extractPersistedExperienceCopilotActivities(messages)).toEqual([{
      toolCallId: "call_edit",
      toolName: "edit_buffer",
      args: editArgs,
      status: "done",
      target: "rules",
      proposed: "---\n# RULES\nnew",
      summary: "swap",
    }]);
  });

  it("inserts a new activity for a thread", () => {
    const store = useExperienceCopilotTurnStore.getState();
    store.upsertActivity("thread_1", { toolCallId: "call_1", toolName: "write_buffer", status: "streaming" });
    expect(useExperienceCopilotTurnStore.getState().getActivities("thread_1")).toEqual([
      { toolCallId: "call_1", toolName: "write_buffer", status: "streaming" },
    ]);
  });

  it("accumulates multiple activities for a thread in insertion order", () => {
    const store = useExperienceCopilotTurnStore.getState();
    store.upsertActivity("thread_1", { toolCallId: "call_a", toolName: "write_buffer", status: "streaming" });
    store.upsertActivity("thread_1", { toolCallId: "call_b", toolName: "edit_buffer", status: "streaming" });
    const acts = useExperienceCopilotTurnStore.getState().getActivities("thread_1");
    expect(acts.map((a) => a.toolCallId)).toEqual(["call_a", "call_b"]);
  });

  it("merges by toolCallId so a streaming placeholder is finalized in place by tool-result", () => {
    // Simulates the real event order: tool-call (streaming) → tool-result (done + proposal).
    const store = useExperienceCopilotTurnStore.getState();
    store.upsertActivity("thread_1", { toolCallId: "call_1", toolName: "write_buffer", status: "streaming" });
    store.upsertActivity("thread_1", {
      toolCallId: "call_1",
      toolName: "write_buffer",
      status: "done",
      target: "rules",
      proposed: "---\n# RULES\nBold.",
      summary: "Made the rules more assertive.",
    });
    const acts = useExperienceCopilotTurnStore.getState().getActivities("thread_1");
    expect(acts).toHaveLength(1);
    expect(acts[0]).toEqual({
      toolCallId: "call_1",
      toolName: "write_buffer",
      status: "done",
      target: "rules",
      proposed: "---\n# RULES\nBold.",
      summary: "Made the rules more assertive.",
    });
  });

  it("a tool-result merge preserves the args captured by the earlier tool-call event", () => {
    // Streaming path: onToolCall captures args; onToolResult later merges result
    // fields without re-passing args. The store's merge-by-toolCallId must not
    // erase the already-captured input.
    const store = useExperienceCopilotTurnStore.getState();
    const editArgs = { edits: [{ search: "a", replace: "b" }], summary: "s" };
    store.upsertActivity("thread_1", { toolCallId: "call_1", toolName: "edit_buffer", args: editArgs, status: "streaming" });
    store.upsertActivity("thread_1", {
      toolCallId: "call_1",
      toolName: "edit_buffer",
      status: "done",
      target: "rules",
      proposed: "---\n# RULES\nb",
      summary: "s",
    });
    const acts = useExperienceCopilotTurnStore.getState().getActivities("thread_1");
    expect(acts).toHaveLength(1);
    expect(acts[0].args).toStrictEqual(editArgs);
    expect(acts[0].status).toBe("done");
  });

  it("clearTurn drops the thread's activities", () => {
    const store = useExperienceCopilotTurnStore.getState();
    store.upsertActivity("thread_1", { toolCallId: "call_1", toolName: "write_buffer", status: "done" });
    store.upsertActivity("thread_2", { toolCallId: "call_2", toolName: "edit_buffer", status: "done" });
    useExperienceCopilotTurnStore.getState().clearTurn("thread_1");
    expect(useExperienceCopilotTurnStore.getState().getActivities("thread_1")).toEqual([]);
    // Other threads are untouched.
    expect(useExperienceCopilotTurnStore.getState().getActivities("thread_2")).toHaveLength(1);
  });

  it("clearTurn on a thread with no activities is a no-op (state ref unchanged)", () => {
    useExperienceCopilotTurnStore.getState().upsertActivity("thread_1", { toolCallId: "call_1", toolName: "write_buffer", status: "done" });
    const before = useExperienceCopilotTurnStore.getState().turnsByThread;
    useExperienceCopilotTurnStore.getState().clearTurn("thread_unknown");
    expect(useExperienceCopilotTurnStore.getState().turnsByThread).toBe(before);
  });

  it("getActivities returns [] for an unknown thread", () => {
    expect(useExperienceCopilotTurnStore.getState().getActivities("never")).toEqual([]);
  });
});
