import { describe, expect, test } from "bun:test";
import {
  splitReasoningFromText,
  type AiAssistantStreamChunk,
  type ReasoningSplitState,
} from "../src/domain/ai-assistant/reasoning-split.js";

function makeState(): ReasoningSplitState {
  return { buffer: "", insideThinkTag: false };
}

function collect(chunks: string[]): AiAssistantStreamChunk[] {
  const state = makeState();
  const out: AiAssistantStreamChunk[] = [];
  for (const chunk of chunks) out.push(...splitReasoningFromText(state, chunk));
  out.push(...splitReasoningFromText(state, "", { flush: true }));
  return out;
}

describe("AI assistant reasoning split", () => {

  test("moves streamed think tags to reasoning instead of code", () => {
    const chunks = collect(["before<th", "ink>hidden", "</thi", "nk>after"]);

    expect(chunks).toEqual([
      { type: "text", text: "before" },
      { type: "reasoning", text: "hidden" },
      { type: "text", text: "after" },
    ]);
  });

  test("strips <thinking> tags (long form) as reasoning", () => {
    // Gemini/Qwen emit <thinking>…</thinking>. The THINK_END prefix ("</think")
    // must match both </think> and </thinking>, else the whole block leaks.
    const chunks = collect([
      "<thinking>Let me describe this.</thinking>A woman takes a selfie.",
    ]);

    expect(chunks).toEqual([
      { type: "reasoning", text: "Let me describe this." },
      { type: "text", text: "A woman takes a selfie." },
    ]);
  });
});
