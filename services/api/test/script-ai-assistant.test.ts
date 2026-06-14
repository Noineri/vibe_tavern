import { describe, expect, test } from "bun:test";
import { REASONING_END_MARKER, REASONING_START_MARKER } from "../src/domain/providers/openai-reasoning-fetch.js";
import {
  splitReasoningFromText,
  type AiAssistantStreamChunk,
  type ReasoningSplitState,
} from "../src/domain/ai-assistant/reasoning-split.js";

function makeState(): ReasoningSplitState {
  return { buffer: "", insideMarkerReasoning: false, insideThinkTag: false };
}

function collect(chunks: string[]): AiAssistantStreamChunk[] {
  const state = makeState();
  const out: AiAssistantStreamChunk[] = [];
  for (const chunk of chunks) out.push(...splitReasoningFromText(state, chunk));
  out.push(...splitReasoningFromText(state, "", { flush: true }));
  return out;
}

describe("AI assistant reasoning split", () => {
  test("separates exact reasoning markers without leaking control chars", () => {
    const chunks = collect([
      `code before\n${REASONING_START_MARKER}thinking${REASONING_END_MARKER}\ncode after`,
    ]);

    expect(chunks).toEqual([
      { type: "text", text: "code before\n" },
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "\ncode after" },
    ]);
    expect(chunks.map((chunk) => chunk.text ?? "").join("")).not.toContain("\x02");
    expect(chunks.map((chunk) => chunk.text ?? "").join("")).not.toContain("\x03");
  });

  test("separates markers split across stream chunks", () => {
    const startA = REASONING_START_MARKER.slice(0, 4);
    const startB = REASONING_START_MARKER.slice(4);
    const endA = REASONING_END_MARKER.slice(0, 5);
    const endB = REASONING_END_MARKER.slice(5);

    const chunks = collect(["code", startA, startB, "think", endA, endB, "more"]);

    expect(chunks).toEqual([
      { type: "text", text: "code" },
      { type: "reasoning", text: "think" },
      { type: "text", text: "more" },
    ]);
  });

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
