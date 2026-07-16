import { describe, expect, it } from "bun:test";
import {
  sanitizeResponseHeaders,
  serializeProviderResponseStep,
  toTraceJsonValue,
} from "../src/infrastructure/ai/provider-response-trace.js";

describe("provider response trace serialization", () => {
  it("keeps diagnostic response headers while removing credential-bearing headers", () => {
    expect(sanitizeResponseHeaders({
      "x-ratelimit-remaining-requests": "17",
      "retry-after": "4",
      "x-request-id": "req_123",
      "set-cookie": "session=secret",
      Authorization: "Bearer secret",
      "x-api-key": "secret",
      "x-auth-token": "secret",
      "x-amz-security-token": "secret",
      "x-ratelimit-remaining-tokens": "900",
    })).toEqual({
      "x-ratelimit-remaining-requests": "17",
      "retry-after": "4",
      "x-request-id": "req_123",
      "x-ratelimit-remaining-tokens": "900",
    });
  });

  it("converts cyclic and non-JSON provider values without throwing or silently dropping fields", () => {
    const unsafe: Record<string, unknown> = {
      bigint: 42n,
      nonFinite: Number.POSITIVE_INFINITY,
      missing: undefined,
      callback: function providerCallback() {},
      map: new Map<unknown, unknown>([["remaining", 9]]),
    };
    unsafe.self = unsafe;
    Object.defineProperty(unsafe, "computed", {
      enumerable: true,
      get() {
        throw new Error("getter must not run");
      },
    });

    const converted = toTraceJsonValue(unsafe);
    expect(converted).toEqual({
      bigint: "42n",
      nonFinite: "Infinity",
      missing: "[undefined]",
      callback: "[Function providerCallback]",
      map: { $type: "Map", entries: [["remaining", 9]] },
      self: "[Circular]",
      computed: "[Accessor]",
    });
    expect(() => JSON.stringify(converted)).not.toThrow();
  });

  it("serializes a provider step with raw body, metadata, usage, and sanitized headers", () => {
    const serialized = serializeProviderResponseStep({
      response: {
        id: "resp_1",
        timestamp: new Date("2026-07-16T12:00:00.000Z"),
        modelId: "model-a",
        headers: {
          "x-ratelimit-remaining-tokens": "900",
          "set-cookie": "session=secret",
        },
        body: {
          id: "resp_1",
          choices: [{ message: { role: "assistant", content: "Hello" } }],
        },
      },
      providerMetadata: { openai: { cachedPromptTokens: 25 } },
      finishReason: "stop",
      rawFinishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });

    expect(serialized).toEqual({
      response: {
        id: "resp_1",
        timestamp: "2026-07-16T12:00:00.000Z",
        modelId: "model-a",
        headers: { "x-ratelimit-remaining-tokens": "900" },
        body: {
          id: "resp_1",
          choices: [{ message: { role: "assistant", content: "Hello" } }],
        },
      },
      providerMetadata: { openai: { cachedPromptTokens: 25 } },
      finishReason: "stop",
      rawFinishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
  });
});
