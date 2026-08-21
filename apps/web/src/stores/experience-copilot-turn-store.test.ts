import { describe, expect, it, beforeEach } from "bun:test";
import {
  extractHistoricalTurnActivities,
  extractPersistedExperienceCopilotActivities,
  parseCopilotAskState,
  parseTodoToolArgs,
  parseTodoToolResult,
  useExperienceCopilotTurnStore,
  wireToToolSource,
} from "./experience-copilot-turn-store.js";
import type { AppMessage } from "../api/types.js";
import type { CopilotTodoItem } from "@vibe-tavern/api-contracts";
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";

describe("useExperienceCopilotTurnStore", () => {
  beforeEach(() => {
    // Reset to a clean state before each case (the store is process-global).
    useExperienceCopilotTurnStore.setState({ turnsByThread: {}, feedByThread: {}, todoByThread: {} });
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

// ─── CD-1: real persisted wrapper + historical turn extraction ────────────────

function wire(over: Partial<ExperienceCopilotMessageWire>): ExperienceCopilotMessageWire {
  return {
    id: "w1",
    threadId: "thread-1",
    role: "user",
    content: "hello",
    toolCallsJson: null,
    toolCallId: null,
    createdAt: "",
    ...over,
  };
}

describe("persisted tool-content wrapper (persistTurn shape)", () => {
  it("unwraps the {toolName, output} wrapper the backend actually persists", () => {
    // persistTurn serializes {toolName, output} into the tool row's content.
    // The extractor must parse the INNER output, not the wrapper (a wrapper
    // fed to the proposal schema would flag every real proposal as an error).
    const messages = [
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
          toolName: "write_buffer",
          output: { target: "rules", proposed: "# RULES v2", summary: "rewrote" },
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
      proposed: "# RULES v2",
      summary: "rewrote",
    }]);
  });

  it("recovers the tool name from the wrapper when the carrier assistant row is missing", () => {
    const messages = [
      { id: "user_new", role: "user", content: "go" },
      {
        id: "tool_orphan",
        role: "tool",
        toolCallId: "call_orphan",
        content: JSON.stringify({
          toolName: "read_skill_file",
          output: { path: "general-writing/SKILL.md", content: "# write" },
        }),
      },
    ] as AppMessage[];

    expect(extractPersistedExperienceCopilotActivities(messages)).toEqual([{
      toolCallId: "call_orphan",
      toolName: "read_skill_file",
      args: undefined,
      status: "done",
      readPath: "general-writing/SKILL.md",
    }]);
  });
});

describe("wireToToolSource", () => {
  it("maps toolCallsJson entries {toolCallId, toolName, input} to {id, name, args}", () => {
    const source = wireToToolSource(
      wire({
        role: "assistant",
        content: "",
        toolCallsJson: JSON.stringify([
          { type: "tool-call", toolCallId: "c1", toolName: "edit_buffer", input: { buffer: "rules" } },
        ]),
      }),
    );
    expect(source.toolCalls).toEqual([{ id: "c1", name: "edit_buffer", args: { buffer: "rules" } }]);
  });

  it("degrades to no toolCalls on invalid JSON", () => {
    const source = wireToToolSource(wire({ role: "assistant", toolCallsJson: "{not json" }));
    expect(source.toolCalls).toBeUndefined();
  });
});

describe("extractHistoricalTurnActivities", () => {
  it("returns one audit entry per turn, anchored before each turn's final assistant reply", () => {
    const messages = [
      wire({ id: "u1", role: "user", content: "first request" }),
      wire({
        id: "carrier1",
        role: "assistant",
        content: "",
        toolCallsJson: JSON.stringify([
          { type: "tool-call", toolCallId: "c1", toolName: "write_buffer", input: { buffer: "rules" } },
        ]),
      }),
      wire({
        id: "tool1",
        role: "tool",
        toolCallId: "c1",
        content: JSON.stringify({
          toolName: "write_buffer",
          output: { target: "rules", proposed: "# R1", summary: "first pass" },
        }),
      }),
      wire({ id: "a1", role: "assistant", content: "first reply" }),
      wire({ id: "u2", role: "user", content: "second request" }),
      wire({
        id: "carrier2",
        role: "assistant",
        content: "",
        toolCallsJson: JSON.stringify([
          { type: "tool-call", toolCallId: "c2", toolName: "edit_buffer", input: { buffer: "visual" } },
        ]),
      }),
      wire({
        id: "tool2",
        role: "tool",
        toolCallId: "c2",
        content: JSON.stringify({
          toolName: "edit_buffer",
          output: { target: "visual", proposed: "# V2", summary: "second pass" },
        }),
      }),
      wire({ id: "a2", role: "assistant", content: "second reply" }),
    ];

    const turns = extractHistoricalTurnActivities(messages);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ anchorId: "a1", placement: "before" });
    expect(turns[0]!.activities).toHaveLength(1);
    expect(turns[0]!.activities[0]).toMatchObject({ toolCallId: "c1", toolName: "write_buffer", status: "done", target: "rules" });
    expect(turns[1]).toMatchObject({ anchorId: "a2", placement: "before" });
    expect(turns[1]!.activities[0]).toMatchObject({ toolCallId: "c2", toolName: "edit_buffer", target: "visual" });
  });

  it("anchors after the user bubble when the turn ended without an assistant reply", () => {
    const messages = [
      wire({ id: "u1", role: "user", content: "do it" }),
      wire({
        id: "tool1",
        role: "tool",
        toolCallId: "c1",
        content: JSON.stringify({
          toolName: "run_test",
          output: { passed: false, failures: ["x"] },
        }),
      }),
      // No final assistant row (the turn failed mid-tools).
    ];

    const turns = extractHistoricalTurnActivities(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ anchorId: "u1", placement: "after" });
    expect(turns[0]!.activities[0]).toMatchObject({ toolCallId: "c1", toolName: "run_test", status: "done" });
  });

  it("emits nothing for toolless turns and skips digest rows as anchors", () => {
    const messages = [
      wire({ id: "u1", role: "user", content: "hi" }),
      wire({ id: "a1", role: "assistant", content: "hello" }),
      wire({ id: "d1", role: "digest", content: "compacted", toolCallId: "u1" }),
    ];
    expect(extractHistoricalTurnActivities(messages)).toEqual([]);
  });
});

describe("feed (TF-4)", () => {
  beforeEach(() => {
    // This describe lives outside the first describe's reset — restore here.
    useExperienceCopilotTurnStore.setState({ turnsByThread: {}, feedByThread: {}, todoByThread: {} });
  });

  const feedOf = (threadId: string) =>
    useExperienceCopilotTurnStore.getState().feedByThread[threadId] ?? [];

  it("accumulates deltas into one open text segment (id is a fresh text-N)", () => {
    const { appendTextDelta } = useExperienceCopilotTurnStore.getState();
    appendTextDelta("t1", "He");
    appendTextDelta("t1", "llo");
    const feed = feedOf("t1");
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ kind: "text", text: "Hello", closed: false });
    expect(feed[0]!.id).toMatch(/^text-\d+$/);
  });

  it("closeTextSegment closes the open segment; repeat close and close-without-open are noops", () => {
    const s = () => useExperienceCopilotTurnStore.getState();
    s().closeTextSegment("t1"); // noop — nothing open
    expect(feedOf("t1")).toEqual([]);
    s().appendTextDelta("t1", "Hi");
    const opened = feedOf("t1")[0]!;
    expect(opened).toMatchObject({ kind: "text", text: "Hi", closed: false });
    s().closeTextSegment("t1");
    expect(feedOf("t1")).toEqual([{ kind: "text", id: opened.id, text: "Hi", closed: true }]);
    // repeat close — noop (nothing open now)
    const before = feedOf("t1");
    s().closeTextSegment("t1");
    expect(feedOf("t1")).toEqual(before);
  });

  it("appendActivityRef appends once per toolCallId (idempotent) and adds new ids", () => {
    const s = () => useExperienceCopilotTurnStore.getState();
    s().appendTextDelta("t1", "a");
    s().appendActivityRef("t1", "c1");
    s().appendActivityRef("t1", "c1"); // duplicate — noop
    s().appendActivityRef("t1", "c2");
    const feed = feedOf("t1");
    expect(feed.filter((e) => e.kind === "activity").map((e) => e.id)).toEqual(["c1", "c2"]);
    expect(feed[feed.length - 1]).toEqual({ kind: "activity", id: "c2" });
  });

  it("text after an activity opens a NEW segment (the old one is not written into)", () => {
    const s = () => useExperienceCopilotTurnStore.getState();
    s().appendTextDelta("t1", "first");
    s().appendActivityRef("t1", "c1");
    s().appendTextDelta("t1", "second");
    const feed = feedOf("t1");
    expect(feed).toHaveLength(3);
    expect(feed[0]).toMatchObject({ kind: "text", text: "first", closed: false });
    expect(feed[1]).toEqual({ kind: "activity", id: "c1" });
    expect(feed[2]).toMatchObject({ kind: "text", text: "second", closed: false });
    expect(feed[0]!.id).not.toBe(feed[2]!.id);
  });

  it("an empty delta is a noop (no empty segment)", () => {
    const s = () => useExperienceCopilotTurnStore.getState();
    s().appendTextDelta("t1", "");
    expect(feedOf("t1")).toEqual([]);
    s().appendTextDelta("t1", "x");
    s().appendTextDelta("t1", "");
    expect(feedOf("t1")).toHaveLength(1);
    expect(feedOf("t1")[0]).toMatchObject({ kind: "text", text: "x", closed: false });
  });

  it("clearTurn drops both feed and activities for one thread only", () => {
    const s = () => useExperienceCopilotTurnStore.getState();
    s().upsertActivity("t1", { toolCallId: "c1", toolName: "write_buffer", status: "done" });
    s().appendTextDelta("t1", "text");
    s().appendTextDelta("t2", "other");
    s().clearTurn("t1");
    expect(useExperienceCopilotTurnStore.getState().turnsByThread["t1"]).toBeUndefined();
    expect(feedOf("t1")).toEqual([]);
    expect(feedOf("t2")).toHaveLength(1);
    expect(feedOf("t2")[0]).toMatchObject({ kind: "text", text: "other" });
  });

  it("two threads keep independent feeds", () => {
    const s = () => useExperienceCopilotTurnStore.getState();
    s().appendTextDelta("t1", "one");
    s().appendTextDelta("t2", "two");
    expect(feedOf("t1")).toHaveLength(1);
    expect(feedOf("t2")).toHaveLength(1);
    expect(feedOf("t1")[0]).toMatchObject({ kind: "text", text: "one" });
    expect(feedOf("t2")[0]).toMatchObject({ kind: "text", text: "two" });
  });
});

// ─── TAG-7: todo/ask parsers, extractor branches, todoByThread state ───────

const TODO_ITEMS: CopilotTodoItem[] = [
  { title: "Draft the rules skeleton", status: "completed" },
  { title: "Write the visual header", status: "active" },
  { title: "Wire the score action", status: "pending" },
];

const TODO_ENVELOPE = {
  ok: true,
  items: TODO_ITEMS,
  activeTitle: "Write the visual header",
  remaining: 2,
};

const ASK_ARGS = {
  question: "Which deck suits the tone?",
  options: ["tarot", "playing cards"],
  recommended: "tarot",
};

describe("parseTodoToolArgs (2026-08-21 incident fix: object root `{items}`)", () => {
  it("accepts the object wrapper and returns the list", () => {
    expect(parseTodoToolArgs({ items: TODO_ITEMS })).toEqual(TODO_ITEMS);
    expect(parseTodoToolArgs({ items: [] })).toEqual([]);
  });

  it("returns null for a bare array, `{}`, partial args, and non-objects — silently skipped by the caller", () => {
    // The tool input is an OBJECT root; these shapes fail the model-facing
    // contract and the live preview must not fire on them (the tool-result
    // envelope is the fallback path).
    expect(parseTodoToolArgs(TODO_ITEMS)).toBeNull();
    expect(parseTodoToolArgs({})).toBeNull();
    expect(parseTodoToolArgs({ items: [{ title: "half-streamed" }] })).toBeNull();
    expect(parseTodoToolArgs(null)).toBeNull();
    expect(parseTodoToolArgs("items")).toBeNull();
  });
});

describe("parseTodoToolResult (TAG-7)", () => {
  it("accepts the success envelope and echoes items/remaining/activeTitle", () => {
    expect(parseTodoToolResult(TODO_ENVELOPE)).toEqual({
      items: TODO_ITEMS,
      remaining: 2,
      activeTitle: "Write the visual header",
    });
  });

  it("recomputes remaining/activeTitle from the items when the envelope omits them", () => {
    const parsed = parseTodoToolResult({ ok: true, items: TODO_ITEMS });
    expect(parsed).toEqual({ items: TODO_ITEMS, remaining: 2, activeTitle: "Write the visual header" });
  });

  it("returns null for a failed save (ok:false), a non-array items value, and an item with a bad status", () => {
    expect(parseTodoToolResult({ ok: false, error: "db down" })).toBeNull();
    expect(parseTodoToolResult({ ok: true, items: "not-a-list" })).toBeNull();
    expect(parseTodoToolResult({ ok: true, items: [{ title: "x", status: "nope" }] })).toBeNull();
    expect(parseTodoToolResult("junk")).toBeNull();
  });
});

describe("parseCopilotAskState (TAG-7)", () => {
  it("parses the awaiting marker verbatim (question/options/recommended from the output)", () => {
    expect(parseCopilotAskState(ASK_ARGS, { status: "awaiting_answer", ...ASK_ARGS })).toEqual({
      question: "Which deck suits the tone?",
      options: ["tarot", "playing cards"],
      recommended: "tarot",
      status: "awaiting_answer",
    });
  });

  it("parses the answered rewrite: status/answer from the output, question/options/recommended recovered from the carrier args", () => {
    expect(parseCopilotAskState(ASK_ARGS, { status: "answered", answer: "tarot, definitely" })).toEqual({
      question: "Which deck suits the tone?",
      options: ["tarot", "playing cards"],
      recommended: "tarot",
      status: "answered",
      answer: "tarot, definitely",
    });
  });

  it("parses the skipped rewrite (no answer field)", () => {
    expect(parseCopilotAskState(ASK_ARGS, { status: "skipped" })).toEqual({
      question: "Which deck suits the tone?",
      options: ["tarot", "playing cards"],
      recommended: "tarot",
      status: "skipped",
    });
  });

  it("an answered rewrite with no carrier args degrades to an empty question", () => {
    expect(parseCopilotAskState(undefined, { status: "answered", answer: "yes" })).toEqual({
      question: "",
      status: "answered",
      answer: "yes",
    });
  });

  it("returns null for an unknown status, an awaiting marker with no question anywhere, and an answered output with no answer", () => {
    expect(parseCopilotAskState(ASK_ARGS, { status: "done" })).toBeNull();
    expect(parseCopilotAskState(undefined, { status: "awaiting_answer" })).toBeNull();
    expect(parseCopilotAskState(ASK_ARGS, { status: "answered" })).toBeNull();
    expect(parseCopilotAskState(ASK_ARGS, null)).toBeNull();
  });
});

describe("extractor todo/ask branches (TAG-7, persisted shapes)", () => {
  it("a todo row (wrapped envelope) becomes a done activity carrying the card payload", () => {
    const messages = [
      { id: "u1", role: "user", content: "plan it" },
      {
        id: "carrier",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_todo", name: "todo", args: TODO_ITEMS }],
      },
      {
        id: "tool_todo",
        role: "tool",
        toolCallId: "call_todo",
        content: JSON.stringify({ toolName: "todo", output: TODO_ENVELOPE }),
      },
    ] as AppMessage[];

    expect(extractPersistedExperienceCopilotActivities(messages)).toEqual([{
      toolCallId: "call_todo",
      toolName: "todo",
      args: TODO_ITEMS,
      status: "done",
      todo: { items: TODO_ITEMS, remaining: 2, activeTitle: "Write the visual header" },
    }]);
  });

  it("a failed todo save (ok:false) renders the error card with the raw content", () => {
    const messages = [
      { id: "u1", role: "user", content: "plan it" },
      {
        id: "tool_todo",
        role: "tool",
        toolCallId: "call_todo",
        content: JSON.stringify({ toolName: "todo", output: { ok: false, error: "db down" } }),
      },
    ] as AppMessage[];

    const [activity] = extractPersistedExperienceCopilotActivities(messages);
    expect(activity).toMatchObject({ toolCallId: "call_todo", toolName: "todo", status: "error" });
    expect(activity!.todo).toBeUndefined();
    expect(activity!.summary).toBe(JSON.stringify({ toolName: "todo", output: { ok: false, error: "db down" } }));
  });

  it("ask rows parse into awaiting/answered/skipped ask states (question recovered from carrier args)", () => {
    const awaiting = { status: "awaiting_answer", ...ASK_ARGS };
    const answered = { status: "answered", answer: "tarot, definitely" };
    const skipped = { status: "skipped" };
    const messages = [
      { id: "u1", role: "user", content: "grill me" },
      {
        id: "carrier",
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "ask_user", args: ASK_ARGS },
          { id: "c2", name: "ask_user", args: ASK_ARGS },
          { id: "c3", name: "ask_user", args: ASK_ARGS },
        ],
      },
      { id: "t1", role: "tool", toolCallId: "c1", content: JSON.stringify({ toolName: "ask_user", output: awaiting }) },
      { id: "t2", role: "tool", toolCallId: "c2", content: JSON.stringify({ toolName: "ask_user", output: answered }) },
      { id: "t3", role: "tool", toolCallId: "c3", content: JSON.stringify({ toolName: "ask_user", output: skipped }) },
    ] as AppMessage[];

    const acts = extractPersistedExperienceCopilotActivities(messages);
    expect(acts.map((a) => a.ask!.status)).toEqual(["awaiting_answer", "answered", "skipped"]);
    expect(acts[0]!.ask).toEqual({
      question: "Which deck suits the tone?",
      options: ["tarot", "playing cards"],
      recommended: "tarot",
      status: "awaiting_answer",
    });
    expect(acts[1]!.ask).toEqual({
      question: "Which deck suits the tone?",
      options: ["tarot", "playing cards"],
      recommended: "tarot",
      status: "answered",
      answer: "tarot, definitely",
    });
    expect(acts[2]!.ask).toMatchObject({ status: "skipped" });
    expect(acts[2]!.ask!.answer).toBeUndefined();
    expect(acts.every((a) => a.status === "done")).toBe(true);
  });
});

describe("todoByThread panel state (TAG-7)", () => {
  beforeEach(() => {
    useExperienceCopilotTurnStore.setState({ turnsByThread: {}, feedByThread: {}, todoByThread: {} });
  });

  it("setTodo is a full-rewrite replace (the newest list IS the state)", () => {
    const s = () => useExperienceCopilotTurnStore.getState();
    s().setTodo("t1", TODO_ITEMS);
    expect(s().getTodo("t1")).toEqual(TODO_ITEMS);
    s().setTodo("t1", [{ title: "Only step", status: "active" }]);
    expect(s().getTodo("t1")).toEqual([{ title: "Only step", status: "active" }]);
    // Seeding the empty list (a wire todo of []) clears the panel state.
    s().setTodo("t1", []);
    expect(s().getTodo("t1")).toEqual([]);
  });

  it("getTodo defaults to [] and threads are isolated", () => {
    const s = () => useExperienceCopilotTurnStore.getState();
    expect(s().getTodo("unknown")).toEqual([]);
    s().setTodo("t1", TODO_ITEMS);
    expect(s().getTodo("t2")).toEqual([]);
  });

  it("clearTurn does NOT drop todoByThread (session lifetime, not turn lifetime)", () => {
    // «время жизни туду должно быть на всю сессию» — clearTurn fires at every
    // turn start; wiping the panel state there would blank the pinned panel
    // during every generation until the settle refetch re-seeds it.
    const s = () => useExperienceCopilotTurnStore.getState();
    s().setTodo("t1", TODO_ITEMS);
    s().upsertActivity("t1", { toolCallId: "c1", toolName: "todo", status: "done" });
    s().clearTurn("t1");
    expect(s().getActivities("t1")).toEqual([]);
    expect(s().getTodo("t1")).toEqual(TODO_ITEMS);
  });
});
