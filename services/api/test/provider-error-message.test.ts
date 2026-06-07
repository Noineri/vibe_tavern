import { describe, expect, it } from "bun:test";
import { extractProviderErrorMessage } from "../src/ai/provider-error-message.js";

describe("extractProviderErrorMessage", () => {
  it("extracts provider message from AI SDK APICallError data", () => {
    const error = {
      data: {
        error: {
          code: "1308",
          message: "Usage limit reached for 5 hour. Your limit will reset at 2026-06-06 23:50:45",
        },
      },
      message: "Failed after 3 attempts. Last error: noisy wrapper",
    };

    expect(extractProviderErrorMessage(error)).toBe(
      "Usage limit reached for 5 hour. Your limit will reset at 2026-06-06 23:50:45",
    );
  });

  it("unwraps RetryError errors and returns the last provider message", () => {
    const retryError = {
      errors: [
        new Error("first"),
        {
          responseBody: JSON.stringify({
            error: { message: "Provider quota exceeded" },
          }),
        },
      ],
      message: "Failed after 3 attempts. Last error: Provider quota exceeded",
    };

    expect(extractProviderErrorMessage(retryError)).toBe("Provider quota exceeded");
  });

  it("strips local wrapper prefixes from plain Error messages", () => {
    expect(extractProviderErrorMessage(new Error("Provider stream error: Failed after 3 attempts. Last error: boom"))).toBe("boom");
  });
});
