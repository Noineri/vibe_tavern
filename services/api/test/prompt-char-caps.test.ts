import { describe, expect, test } from "bun:test";

import { parsePromptCharCapFromErrorMessage } from "../src/domain/imagegen/prompt-char-caps.js";

// IF-10 — the parser is the ONLY place a provider's prose cap becomes a
// number. Pins: both live-observed nanogpt phrasings (object and string
// envelopes flatten to the same message text), plural/singular, negatives
// (no number, absurd numbers, unrelated failures) never teach a cap.

describe("parsePromptCharCapFromErrorMessage (IF-10)", () => {
  test("qwen-image live shape: 'shorten it to 3000 characters or less'", () => {
    expect(
      parsePromptCharCapFromErrorMessage(
        "NanoGPT generate error: Your prompt is too long. Please shorten it to 3000 characters or less (current: 15199 characters).",
      ),
    ).toBe(3000);
  });

  test("z-image-turbo live shape: model-named variant, same phrasing", () => {
    expect(
      parsePromptCharCapFromErrorMessage(
        "NanoGPT generate error: Your prompt is too long for Z Image Turbo. Please shorten it to 1200 characters or less (current: 5399 characters).",
      ),
    ).toBe(1200);
  });

  test("singular 'character or less' still parses", () => {
    expect(parsePromptCharCapFromErrorMessage("Please shorten it to 512 character or less.")).toBe(512);
  });

  test("unrelated failures return null — never a guess", () => {
    expect(parsePromptCharCapFromErrorMessage("Insufficient credits")).toBeNull();
    expect(parsePromptCharCapFromErrorMessage("`apiKey` is required (the card has no keyless surface)")).toBeNull();
    expect(parsePromptCharCapFromErrorMessage("")).toBeNull();
  });

  test("absurd numbers are rejected as parse artifacts", () => {
    expect(parsePromptCharCapFromErrorMessage("shorten it to 0 characters or less")).toBeNull();
    expect(parsePromptCharCapFromErrorMessage("shorten it to 99999999 characters or less")).toBeNull();
  });
});
