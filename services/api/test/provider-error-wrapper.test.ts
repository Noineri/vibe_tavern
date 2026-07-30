import { describe, expect, it } from "bun:test";
import { wrapProviderExecutionError } from "../src/infrastructure/ai/provider-error-wrapper.js";
import { ProviderExecutionError } from "../src/infrastructure/ai/provider-execution-types.js";
import { normalizeProviderType } from "@vibe-tavern/domain";

/**
 * Coverage for Layer 2 of the provider-error-categorization reanimation: the
 * execution-boundary wrapper that composes Layer 1 outputs (category +
 * statusCode + message) into a {@link ProviderExecutionError}.
 *
 * The individual Layer 1 pieces are covered in:
 *   - `provider-error-classifier.test.ts` — classifyProviderError / extractProviderErrorStatusCode
 *   - `provider-error-message.test.ts` — extractProviderErrorMessage
 * This file pins the ASSEMBLY contract: that errors thrown inside either
 * provider executor (streaming or non-streaming) get normalized into a
 * ProviderExecutionError with the correct category, providerType, statusCode,
 * and cause.
 *
 * Replaces the old `prefill-executor.test.ts`, which mocked the `ai` package
 * via `mock.module("ai", …)`. That mock is process-global under bun:test and
 * leaked into every other test file in the same run, replacing the real
 * `generateText` with a fake and breaking `openai-compatible-reasoning.test.ts`
 * (AGENTS.md "mock.module() is process-global" gotcha). Testing the wrapper
 * directly needs no `ai` mock and exercises the same boundary at its natural
 * seam — the function both executors call in their catch blocks.
 *
 * The prefill-injection coverage that lived (skipped) in the old file is
 * already covered in `provider-executor-utils.test.ts` (`prepareSdkMessages`
 * prefill tests, lines 179–260), so nothing was lost by dropping those
 * describe.skip blocks.
 */
describe("wrapProviderExecutionError", () => {
  // ── Assembled ProviderExecutionError shape ───────────────────────────────

  it("returns a ProviderExecutionError instance", () => {
    const wrapped = wrapProviderExecutionError(new Error("boom"), "openai_compat");
    expect(wrapped).toBeInstanceOf(ProviderExecutionError);
    expect(wrapped.name).toBe("ProviderExecutionError");
  });

  it("normalizes the providerPreset into a ProviderType via normalizeProviderType", () => {
    const wrapped = wrapProviderExecutionError(new Error("boom"), "openai_compat");
    expect(wrapped.providerType).toBe(normalizeProviderType("openai_compat"));
  });

  // ── Status-code → category mapping (the executor boundary contract) ──────
  // These are the cases the SSE/HTTP emit sites and global error handler read.

  it("wraps a 401 as ProviderExecutionError{authentication}", () => {
    const error = Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    const wrapped = wrapProviderExecutionError(error, "openai_compat");
    expect(wrapped.category).toBe("authentication");
    expect(wrapped.statusCode).toBe(401);
  });

  it("wraps a 403 as ProviderExecutionError{authentication}", () => {
    // Mirrors the streaming setup-error case (streamText threw Forbidden).
    const error = Object.assign(new Error("Forbidden"), { statusCode: 403 });
    const wrapped = wrapProviderExecutionError(error, "openai_compat");
    expect(wrapped.category).toBe("authentication");
    expect(wrapped.statusCode).toBe(403);
  });

  it("wraps a 429 as ProviderExecutionError{rate_limit}", () => {
    const error = Object.assign(new Error("Too Many Requests"), { statusCode: 429 });
    const wrapped = wrapProviderExecutionError(error, "openai_compat");
    expect(wrapped.category).toBe("rate_limit");
    expect(wrapped.statusCode).toBe(429);
  });

  // ── Network errno classification ─────────────────────────────────────────

  it("wraps a Node ENOTFOUND errno as ProviderExecutionError{network}", () => {
    const error = Object.assign(new Error("fetch failed"), { code: "ENOTFOUND" });
    const wrapped = wrapProviderExecutionError(error, "ollama");
    expect(wrapped.category).toBe("network");
  });

  // ── Cause preservation (the original error must not be lost) ─────────────

  it("preserves the original error as `cause` with its identity intact", () => {
    const original = Object.assign(new Error("Too Many Requests"), { statusCode: 429 });
    const wrapped = wrapProviderExecutionError(original, "openai_compat");
    expect(wrapped.cause).toBe(original);
  });

  it("preserves the original error as `cause` even for network errors with no statusCode", () => {
    const original = Object.assign(new Error("getaddrinfo ENOTFOUND api.example.com"), { code: "ENOTFOUND" });
    const wrapped = wrapProviderExecutionError(original, "ollama");
    expect(wrapped.cause).toBe(original);
    expect(wrapped.statusCode).toBeUndefined();
  });

  // ── Message extraction (delegated to extractProviderErrorMessage) ─────────

  it("uses the error's message as the ProviderExecutionError message", () => {
    const error = Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    const wrapped = wrapProviderExecutionError(error, "openai_compat");
    expect(wrapped.message).toBe("Unauthorized");
  });

  it("falls back to the default message when the error carries none", () => {
    // null/undefined errors reach the boundary only if the AI SDK or a
    // downstream lib throws a non-Error value; the wrapper must still produce
    // a usable ProviderExecutionError rather than crashing.
    const wrapped = wrapProviderExecutionError(undefined, "openai_compat");
    expect(wrapped.message).toBe("Provider request failed");
    expect(wrapped.category).toBe("unknown");
  });

  // ── Provider preset flows through to providerType ────────────────────────

  it("carries the normalized providerType for each executor caller", () => {
    // Both executors call wrapProviderExecutionError with their own profile's
    // providerPreset; the SSE error event surfaces this as providerType.
    const error = Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    expect(wrapProviderExecutionError(error, "openai_compat").providerType).toBe(normalizeProviderType("openai_compat"));
    expect(wrapProviderExecutionError(error, "ollama").providerType).toBe(normalizeProviderType("ollama"));
    expect(wrapProviderExecutionError(error, "anthropic").providerType).toBe(normalizeProviderType("anthropic"));
  });
});
