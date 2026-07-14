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
      toolCalls: [{ toolCallId: "tc_1", toolName: "edit_profile", input: {} }],
      toolResults: [],
    }]);

    expect(result.toolCalls).toEqual([{
      toolCallId: "tc_1",
      toolName: "edit_profile",
      args: {},
    }]);
  });
});
