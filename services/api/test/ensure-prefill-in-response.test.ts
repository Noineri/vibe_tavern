import { describe, expect, it } from "bun:test";
import { ensurePrefillInResponse } from "../src/infrastructure/ai/ensure-prefill-in-response.js";

describe("ensurePrefillInResponse", () => {
  it("prepends an ordinary assistant prefill when the provider returns only the continuation", () => {
    expect(ensurePrefillInResponse("continued", "Opening: ")).toBe("Opening: continued");
  });

  it("does not duplicate a prefill echoed by the provider", () => {
    expect(ensurePrefillInResponse("Opening: continued", "Opening: ")).toBe("Opening: continued");
  });

  it("restores an omitted opening thinking tag when the continuation contains its closing tag", () => {
    expect(ensurePrefillInResponse("reasoning</think>Final answer", "<think>Analyze: ")).toBe(
      "<think>Analyze: reasoning</think>Final answer",
    );
  });

  it("does not expose an unclosed thinking prefill when reasoning arrived through a native field", () => {
    expect(ensurePrefillInResponse("Final answer", "<think>Analyze the user input")).toBe("Final answer");
  });
});
