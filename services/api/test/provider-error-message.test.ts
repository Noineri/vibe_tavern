import { describe, expect, it } from "bun:test";
import { extractProviderErrorMessage } from "../src/infrastructure/ai/provider-error-message.js";

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

  it("extracts message from responseBody JSON", () => {
    const error = {
      responseBody: JSON.stringify({ error: { message: "Context window exceeded" } }),
    };
    expect(extractProviderErrorMessage(error)).toBe("Context window exceeded");
  });

  it("extracts top-level message from responseBody when no nested error", () => {
    const error = {
      responseBody: JSON.stringify({ message: "Direct message" }),
    };
    expect(extractProviderErrorMessage(error)).toBe("Direct message");
  });

  it("extracts from data.message when data.error is missing", () => {
    const error = {
      data: { message: "Plain data message" },
    };
    expect(extractProviderErrorMessage(error)).toBe("Plain data message");
  });

  it("returns string error directly (stripped)", () => {
    expect(extractProviderErrorMessage("Provider stream error: timeout")).toBe("timeout");
  });

  it("returns fallback when error is null", () => {
    expect(extractProviderErrorMessage(null)).toBe("Provider request failed");
  });

  it("returns custom fallback", () => {
    expect(extractProviderErrorMessage(undefined, "Custom fallback")).toBe("Custom fallback");
  });

  it("returns fallback for non-object, non-string, non-Error", () => {
    expect(extractProviderErrorMessage(42)).toBe("Provider request failed");
  });

  it("returns fallback for empty string", () => {
    expect(extractProviderErrorMessage("")).toBe("Provider request failed");
  });

  it("returns fallback for whitespace-only string", () => {
    expect(extractProviderErrorMessage("   ")).toBe("Provider request failed");
  });

  it("returns fallback for non-JSON responseBody on plain object", () => {
    const error = {
      responseBody: "not json at all",
    };
    expect(extractProviderErrorMessage(error)).toBe("Provider request failed");
  });

  it("returns fallback for responseBody that parses to non-object", () => {
    const error = {
      responseBody: JSON.stringify("just a string"),
    };
    expect(extractProviderErrorMessage(error)).toBe("Provider request failed");
  });

  it("unwraps RetryError and falls back to Error.message when no data", () => {
    const retryError = {
      errors: [new Error("first attempt"), new Error("second attempt")],
    };
    expect(extractProviderErrorMessage(retryError)).toBe("second attempt");
  });
});
