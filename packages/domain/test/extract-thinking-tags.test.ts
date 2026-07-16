import { describe, expect, it } from "bun:test";
import { extractThinkingTags } from "../src/extract-thinking-tags.js";

describe("extractThinkingTags", () => {
  it("extracts tagged reasoning from visible content", () => {
    expect(extractThinkingTags("<thinking>inspect context</thinking>Final answer")).toEqual({
      mainContent: "Final answer",
      reasoning: "inspect context",
    });
  });

  it("does not duplicate reasoning already extracted by the provider adapter", () => {
    expect(extractThinkingTags(
      "<thinking>inspect context</thinking>Final answer",
      "inspect context",
    )).toEqual({
      mainContent: "Final answer",
      reasoning: "inspect context",
    });
  });

  it("preserves distinct native and tagged reasoning fragments", () => {
    expect(extractThinkingTags(
      "<thinking>second fragment</thinking>Final answer",
      "first fragment",
    )).toEqual({
      mainContent: "Final answer",
      reasoning: "first fragment\n\nsecond fragment",
    });
  });
});
