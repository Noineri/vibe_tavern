import { describe, expect, it } from "bun:test";
import { extractNonstreamingToolInteractions } from "../src/infrastructure/ai/nonstreaming-provider-executor.js";

describe("extractNonstreamingToolInteractions", () => {
  it("preserves Gemini thoughtSignature as replayable providerOptions", () => {
    const result = extractNonstreamingToolInteractions([{
      toolCalls: [{
        toolCallId: "tc_google_1",
        toolName: "edit_examples",
        input: { content: "updated" },
        providerMetadata: { google: { thoughtSignature: "sig_google_1" } },
      }],
      toolResults: [{
        toolCallId: "tc_google_1",
        toolName: "edit_examples",
        input: { content: "updated" },
        output: { target: "profile" },
      }],
    }]);

    expect(result.toolCalls).toEqual([{
      toolCallId: "tc_google_1",
      toolName: "edit_examples",
      args: { content: "updated" },
      providerOptions: { google: { thoughtSignature: "sig_google_1" } },
    }]);
    expect(result.toolResults).toEqual([{
      toolCallId: "tc_google_1",
      toolName: "edit_examples",
      args: { content: "updated" },
      result: { target: "profile" },
      isError: false,
    }]);
  });

  it("keeps provider-neutral tool calls unchanged", () => {
    const result = extractNonstreamingToolInteractions([{
      toolCalls: [{ toolCallId: "tc_1", toolName: "write_profile", input: {} }],
      toolResults: [],
    }]);

    expect(result.toolCalls).toEqual([{
      toolCallId: "tc_1",
      toolName: "write_profile",
      args: {},
    }]);
  });

  it("synthesizes an error result from a tool-error content part (AI SDK v6) so the failed call is not orphaned", () => {
    // AI SDK v6 puts a failed execute() in step.content as a `tool-error` part,
    // NOT in toolResults. The call still appears in toolCalls, so without
    // synthesizing a result it would be persisted as a tool_call with no
    // matching tool_result — and the next turn's history reconstruction throws
    // "Tool result is missing for tool call X", deadlocking the chat.
    const result = extractNonstreamingToolInteractions([{
      toolCalls: [{ toolCallId: "call_a", toolName: "ai_write_lore_entry", input: { entryId: "e1", instruction: "write it" } }],
      toolResults: [],
      content: [{ type: "tool-error", toolCallId: "call_a", toolName: "ai_write_lore_entry", input: { entryId: "e1", instruction: "write it" }, error: "delegate provider not configured" }],
    }]);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolResults).toEqual([{
      toolCallId: "call_a",
      toolName: "ai_write_lore_entry",
      args: { entryId: "e1", instruction: "write it" },
      result: { error: "delegate provider not configured" },
      isError: true,
    }]);
  });

  it("keeps both results when the same tool is called twice and the first execute errors (model retry)", () => {
    // Reproduces the user-reported deadlock: ai_write_lore_entry failed on the
    // first attempt (tool-error), the model retried and the second succeeded.
    // Both calls must carry a result, or the failed first call becomes an
    // orphan that breaks the next send.
    const result = extractNonstreamingToolInteractions([{
      toolCalls: [
        { toolCallId: "call_fail", toolName: "ai_write_lore_entry", input: { entryId: "e1", instruction: "first try" } },
        { toolCallId: "call_ok", toolName: "ai_write_lore_entry", input: { entryId: "e1", instruction: "retry" } },
      ],
      toolResults: [{ toolCallId: "call_ok", toolName: "ai_write_lore_entry", input: { entryId: "e1", instruction: "retry" }, output: { target: "lore_bundle" } }],
      content: [{ type: "tool-error", toolCallId: "call_fail", toolName: "ai_write_lore_entry", input: { entryId: "e1", instruction: "first try" }, error: "rate limited" }],
    }]);

    expect(result.toolCalls.map((c) => c.toolCallId)).toEqual(["call_fail", "call_ok"]);
    expect(result.toolResults).toHaveLength(2);
    const byId = Object.fromEntries(result.toolResults.map((r) => [r.toolCallId, r]));
    expect(byId.call_ok.isError).toBe(false);
    expect(byId.call_fail).toEqual({
      toolCallId: "call_fail",
      toolName: "ai_write_lore_entry",
      args: { entryId: "e1", instruction: "first try" },
      result: { error: "rate limited" },
      isError: true,
    });
  });
});
