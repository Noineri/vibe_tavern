import { describe, expect, it } from "bun:test";
import { classifyProviderError } from "../src/infrastructure/ai/provider-error-classifier.js";
import { DomainError } from "../src/shared/errors.js";

/**
 * Coverage for Layer 1 of the provider-error-categorization reanimation.
 * Every category arm of ProviderErrorCategory has at least one mapping case,
 * plus the unwrap (RetryError → lastError), short-circuit (DomainError), and
 * conservative fall-through (unknown) paths. Error inputs are plain objects /
 * Error instances duck-typed to match AI SDK shapes — no `ai` import, mirroring
 * provider-error-message.test.ts.
 */
describe("classifyProviderError", () => {
  // ── 1. DomainError short-circuit (VT wrapper) ──────────────────────────

  it("maps DomainError Cancelled → aborted", () => {
    expect(classifyProviderError(new DomainError({ kind: "Cancelled", message: "aborted by user" }))).toBe("aborted");
  });

  it("maps DomainError Unauthorized → authentication", () => {
    expect(classifyProviderError(new DomainError({ kind: "Unauthorized", message: "no key" }))).toBe("authentication");
  });

  it("returns unknown for DomainError Provider (cause not preserved on the wrapper)", () => {
    expect(classifyProviderError(new DomainError({ kind: "Provider", message: "provider failed" }))).toBe("unknown");
  });

  // ── 2. RetryError unwrap ───────────────────────────────────────────────

  it("unwraps RetryError to its lastError and classifies that", () => {
    const retry = {
      errors: [new Error("first"), { statusCode: 429 }],
      lastError: { statusCode: 429 },
      reason: "maxRetriesExceeded",
    };
    expect(classifyProviderError(retry)).toBe("rate_limit");
  });

  it("honors RetryError reason='abort' over unwrapping", () => {
    const retry = {
      errors: [{ statusCode: 500 }],
      lastError: { statusCode: 500 },
      reason: "abort",
    };
    expect(classifyProviderError(retry)).toBe("aborted");
  });

  it("falls back to errors[last] when lastError is absent", () => {
    const retry = {
      errors: [{ statusCode: 401 }],
      reason: "maxRetriesExceeded",
    };
    expect(classifyProviderError(retry)).toBe("authentication");
  });

  // ── 3. Abort ───────────────────────────────────────────────────────────

  it("classifies AbortError by name", () => {
    const err = new Error("The user aborted a request");
    err.name = "AbortError";
    expect(classifyProviderError(err)).toBe("aborted");
  });

  it("classifies DOMException(Aborted) by name+message", () => {
    const err = new Error("Aborted");
    err.name = "DOMException";
    expect(classifyProviderError(err)).toBe("aborted");
  });

  it("classifies Node ABORT_ERR code", () => {
    const err = new Error("aborted") as Error & { code: string };
    err.code = "ABORT_ERR";
    expect(classifyProviderError(err)).toBe("aborted");
  });

  it("classifies bare { name: 'AbortError' } object", () => {
    expect(classifyProviderError({ name: "AbortError" })).toBe("aborted");
  });

  // ── 4. Empty response ──────────────────────────────────────────────────

  it("classifies NoOutputGeneratedError", () => {
    const err = new Error("No output generated. Check the stream for errors.");
    err.name = "NoOutputGeneratedError";
    expect(classifyProviderError(err)).toBe("empty_response");
  });

  // ── 5. APICallError status-code mapping ────────────────────────────────

  it("maps 401 → authentication", () => {
    expect(classifyProviderError({ statusCode: 401, message: "Unauthorized" })).toBe("authentication");
  });

  it("maps 403 → authentication", () => {
    expect(classifyProviderError({ statusCode: 403 })).toBe("authentication");
  });

  it("maps 429 → rate_limit", () => {
    expect(classifyProviderError({ statusCode: 429 })).toBe("rate_limit");
  });

  it("maps 408 → timeout", () => {
    expect(classifyProviderError({ statusCode: 408 })).toBe("timeout");
  });

  it("maps 504 → timeout", () => {
    expect(classifyProviderError({ statusCode: 504 })).toBe("timeout");
  });

  it("maps 400 → invalid_request", () => {
    expect(classifyProviderError({ statusCode: 400 })).toBe("invalid_request");
  });

  it("maps 422 → invalid_request", () => {
    expect(classifyProviderError({ statusCode: 422 })).toBe("invalid_request");
  });

  it("maps 500 → server_error", () => {
    expect(classifyProviderError({ statusCode: 500 })).toBe("server_error");
  });

  it("maps 503 → server_error", () => {
    expect(classifyProviderError({ statusCode: 503 })).toBe("server_error");
  });

  it("does not match an unmapped status (e.g. 418) to server_error and falls through", () => {
    // 418 is outside [500,600) and not in the auth/rate/timeout/invalid set;
    // no other signal present → unknown.
    expect(classifyProviderError({ statusCode: 418 })).toBe("unknown");
  });

  // ── 6. Network errors ──────────────────────────────────────────────────

  it("classifies Node ENOTFOUND via code", () => {
    const err = new Error("getaddrinfo ENOTFOUND api.example.com") as Error & { code: string };
    err.code = "ENOTFOUND";
    expect(classifyProviderError(err)).toBe("network");
  });

  it("classifies ECONNREFUSED via code", () => {
    const err = new Error("connect ECONNREFUSED") as Error & { code: string };
    err.code = "ECONNREFUSED";
    expect(classifyProviderError(err)).toBe("network");
  });

  it("classifies 'fetch failed' message", () => {
    expect(classifyProviderError(new Error("fetch failed"))).toBe("network");
  });

  it("classifies network error nested in APICallError.cause (statusCode 0 / undefined)", () => {
    const apiLike = {
      statusCode: undefined,
      cause: Object.assign(new Error("connect ECONNRESET 127.0.0.1:8080"), { code: "ECONNRESET" }),
    };
    expect(classifyProviderError(apiLike)).toBe("network");
  });

  it("classifies a network message passed as a string", () => {
    expect(classifyProviderError("network error: socket hang up")).toBe("network");
  });

  // ── 7. Parse errors ────────────────────────────────────────────────────

  it("classifies SyntaxError", () => {
    try {
      JSON.parse("{not json");
      throw new Error("should have thrown");
    } catch (err) {
      expect(classifyProviderError(err)).toBe("parse_error");
    }
  });

  it("classifies AI SDK JSONParseError by name", () => {
    const err = new Error("Unexpected token < in JSON");
    err.name = "JSONParseError";
    expect(classifyProviderError(err)).toBe("parse_error");
  });

  it("classifies 'Unexpected token' message as parse_error", () => {
    expect(classifyProviderError(new Error("Unexpected token < in JSON at position 0"))).toBe("parse_error");
  });

  // ── 8. Fall-through / unknown ──────────────────────────────────────────

  it("returns unknown for a plain Error with no recognizable signal", () => {
    expect(classifyProviderError(new Error("something went wrong"))).toBe("unknown");
  });

  it("returns unknown for null", () => {
    expect(classifyProviderError(null)).toBe("unknown");
  });

  it("returns unknown for undefined", () => {
    expect(classifyProviderError(undefined)).toBe("unknown");
  });

  it("returns unknown for a plain object with no statusCode / name / message", () => {
    expect(classifyProviderError({ foo: "bar" })).toBe("unknown");
  });

  // ── 9. Priority / interaction ──────────────────────────────────────────

  it("RetryError unwrap beats a network-shaped outer message (classifies the inner cause)", () => {
    // Outer looks network-ish ("fetch failed"), but the real cause carried in
    // errors[] is a 401. The unwrap must win.
    const retry = {
      message: "fetch failed",
      errors: [{ statusCode: 401 }],
      lastError: { statusCode: 401 },
      reason: "maxRetriesExceeded",
    };
    expect(classifyProviderError(retry)).toBe("authentication");
  });

  it("APICallError with 5xx wins over a parse-error-shaped message", () => {
    // Status code is the primary signal; message heuristic must not override it.
    expect(classifyProviderError({ statusCode: 502, message: "Unexpected token in JSON" })).toBe("server_error");
  });
});
