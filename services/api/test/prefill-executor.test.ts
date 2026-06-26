import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { resolveProtocol, PROTOCOL_CAPABILITIES } from "../src/domain/providers/protocol-registry.js";
import { normalizeProviderType } from "@vibe-tavern/domain";
import type { ProviderType } from "@vibe-tavern/domain";
import type { ProviderExecutionInput } from "../src/infrastructure/ai/provider-execution-types.js";
import { ProviderExecutionError } from "../src/infrastructure/ai/provider-execution-types.js";

// ═══════════════════════════════════════════════════════════════════════════
// Mock the 'ai' module — must be at top level before importing executors
// ═══════════════════════════════════════════════════════════════════════════

let capturedGenerateTextMessages: unknown;
let capturedStreamTextMessages: unknown;

const fakeGenerateText = mock(async (opts: { messages: unknown }) => {
  capturedGenerateTextMessages = opts.messages;
  return {
    text: "Hello from AI",
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
});

const fakeStreamText = mock((opts: { messages: unknown }) => {
  capturedStreamTextMessages = opts.messages;
  return {
    textStream: (async function* () { yield "Hello from stream"; })(),
    text: Promise.resolve("Hello from stream"),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
  };
});

mock.module("ai", () => ({
  generateText: fakeGenerateText,
  streamText: fakeStreamText,
}));

// Import executors after mock is registered
const { nonstreamingProviderExecute } = await import(
  "../src/infrastructure/ai/nonstreaming-provider-executor.js"
);
const { streamProviderExecutor } = await import(
  "../src/infrastructure/ai/stream-provider-executor.js"
);

// ═══════════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════════

function makeInput(providerPreset: string, prefill?: string): ProviderExecutionInput {
  return {
    profile: {
      id: "test",
      name: "Test",
      providerPreset,
      endpoint: "http://localhost:1234/v1",
      apiKey: "test-key",
      defaultModel: null,
      contextBudget: null,
      temperature: 0.7,
      topP: 1,
      maxTokens: 512,
      minP: 0,
      topK: 0,
      topA: 0,
      frequencyPenalty: 0,
      presencePenalty: 0,
      repetitionPenalty: 1,
      stopSequences: [],
      seed: null,
      reasoningEffort: "auto",
      streamResponse: false,
      isActive: true,
      createdAt: "2025-01-01",
      updatedAt: "2025-01-01",
    },
    model: "test-model",
    prompt: {
      finalPayload: {
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hi" },
        ],
      },
    } as unknown as ProviderExecutionInput,
    ...(prefill !== undefined ? { prefill } : {}),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Part 1 — Capability flags (pure data, no mocking needed)
// ═══════════════════════════════════════════════════════════════════════════

describe.skip("provider-capabilities: prefill flags", () => {
  const prefillTrue: ProviderType[] = ["openai_compat", "ollama", "llamacpp"];
  const prefillFalse: ProviderType[] = ["anthropic", "google", "koboldcpp"];

  it("has exactly 6 provider types defined", () => {
    expect(Object.keys(PROTOCOL_CAPABILITIES).length).toBe(6);
  });

  it("has no null prefill values", () => {
    for (const [type, caps] of Object.entries(PROTOCOL_CAPABILITIES)) {
      expect(caps.prefill).not.toBeNull(`${type} still has null prefill`);
    }
  });

  for (const type of prefillTrue) {
    it(`${type}.prefill is true`, () => {
      expect(resolveProtocol(type as ProviderType).capabilities.prefill).toBe(true);
    });
  }

  for (const type of prefillFalse) {
    it(`${type}.prefill is false`, () => {
      expect(resolveProtocol(type as ProviderType).capabilities.prefill).toBe(false);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Part 2 — Nonstreaming executor prefill logic
// ═══════════════════════════════════════════════════════════════════════════

describe.skip("nonstreaming executor: prefill message injection", () => {
  beforeEach(() => {
    capturedGenerateTextMessages = undefined;
    fakeGenerateText.mockClear();
  });

  it("appends assistant message when prefill is set and provider supports it", async () => {
    await nonstreamingProviderExecute(makeInput("openai_compat", "Sure, here is my response:"));
    expect(capturedGenerateTextMessages).toHaveLength(2);
    expect(capturedGenerateTextMessages[0]).toEqual({ role: "user", content: "Hi" });
    expect(capturedGenerateTextMessages[1]).toEqual({ role: "assistant", content: "Sure, here is my response:" });
  });

  it("does NOT append assistant message when prefill is set but provider does NOT support it", async () => {
    await nonstreamingProviderExecute(makeInput("anthropic", "Sure, here is my response:"));
    expect(capturedGenerateTextMessages).toHaveLength(1);
    expect(capturedGenerateTextMessages[0]).toEqual({ role: "user", content: "Hi" });
  });

  it("does NOT append assistant message when prefill is undefined", async () => {
    await nonstreamingProviderExecute(makeInput("openai_compat", undefined));
    expect(capturedGenerateTextMessages).toHaveLength(1);
  });

  it("does NOT append assistant message when prefill is empty string", async () => {
    await nonstreamingProviderExecute(makeInput("openai_compat", ""));
    expect(capturedGenerateTextMessages).toHaveLength(1);
  });

  it("appends prefill for ollama", async () => {
    await nonstreamingProviderExecute(makeInput("ollama", "Prefill text"));
    expect(capturedGenerateTextMessages).toHaveLength(2);
    expect(capturedGenerateTextMessages[1]).toEqual({ role: "assistant", content: "Prefill text" });
  });

  it("appends prefill for llamacpp", async () => {
    await nonstreamingProviderExecute(makeInput("llamacpp", "Begin response"));
    expect(capturedGenerateTextMessages).toHaveLength(2);
    expect(capturedGenerateTextMessages[1]).toEqual({ role: "assistant", content: "Begin response" });
  });

  it("skips prefill for google", async () => {
    await nonstreamingProviderExecute(makeInput("google", "Should be ignored"));
    expect(capturedGenerateTextMessages).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Part 3 — Streaming executor prefill logic
// ═══════════════════════════════════════════════════════════════════════════

describe.skip("streaming executor: prefill message injection", () => {
  beforeEach(() => {
    capturedStreamTextMessages = undefined;
    fakeStreamText.mockClear();
  });

  it("appends assistant message when prefill is set and provider supports it", async () => {
    await streamProviderExecutor(makeInput("openai_compat", "Stream prefill"));
    expect(capturedStreamTextMessages).toHaveLength(2);
    expect(capturedStreamTextMessages[1]).toEqual({ role: "assistant", content: "Stream prefill" });
  });

  it("does NOT append assistant message for unsupported provider (anthropic)", async () => {
    await streamProviderExecutor(makeInput("anthropic", "Ignored"));
    expect(capturedStreamTextMessages).toHaveLength(1);
  });

  it("does NOT append assistant message when prefill is undefined", async () => {
    await streamProviderExecutor(makeInput("openai_compat", undefined));
    expect(capturedStreamTextMessages).toHaveLength(1);
  });

  it("appends prefill for ollama", async () => {
    await streamProviderExecutor(makeInput("ollama", "Ollama prefill"));
    expect(capturedStreamTextMessages).toHaveLength(2);
    expect(capturedStreamTextMessages[1]).toEqual({ role: "assistant", content: "Ollama prefill" });
  });

  it("skips prefill for google", async () => {
    await streamProviderExecutor(makeInput("google", "Ignored"));
    expect(capturedStreamTextMessages).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Part 4 — Error wrapping → ProviderExecutionError (reanimation Layer 2)
// ═════════════════════════════════════════════════════════════════════════
// The executors must normalize AI SDK failures at the execution boundary into
// ProviderExecutionError, pre-classifying the category so it travels as
// structured data to the SSE/HTTP emit sites. These guard that contract.
// ═════════════════════════════════════════════════════════════════════════

describe("executor error wrapping → ProviderExecutionError", () => {
  // mock.module('ai') is process-global (AGENTS.md gotcha): a throwing impl
  // set here would leak into every other test file in the run. Restore the
  // happy-path implementations after each test so the default behavior is
  // exactly what the top-of-file declarations established.
  afterEach(() => {
    fakeGenerateText.mockImplementation(async (opts: { messages: unknown }) => {
      capturedGenerateTextMessages = opts.messages;
      return { text: "Hello from AI", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    });
    fakeStreamText.mockImplementation((opts: { messages: unknown }) => {
      capturedStreamTextMessages = opts.messages;
      return {
        textStream: (async function* () { yield "Hello from stream"; })(),
        text: Promise.resolve("Hello from stream"),
        finishReason: Promise.resolve("stop"),
        usage: Promise.resolve({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
      };
    });
  });

  it("nonstreaming executor wraps a 401 as ProviderExecutionError{authentication}", async () => {
    fakeGenerateText.mockImplementation(() => {
      throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    });
    await expect(nonstreamingProviderExecute(makeInput("openai_compat"))).rejects.toMatchObject({
      name: "ProviderExecutionError",
      category: "authentication",
      providerType: normalizeProviderType("openai_compat"),
      statusCode: 401,
    });
  });

  it("nonstreaming executor wraps a network errno as ProviderExecutionError{network}", async () => {
    fakeGenerateText.mockImplementation(() => {
      return Promise.reject(Object.assign(new Error("fetch failed"), { code: "ENOTFOUND" }));
    });
    await expect(nonstreamingProviderExecute(makeInput("ollama"))).rejects.toMatchObject({
      name: "ProviderExecutionError",
      category: "network",
      providerType: normalizeProviderType("ollama"),
    });
  });

  it("nonstreaming executor preserves the cause and classifies a 429", async () => {
    const original = Object.assign(new Error("Too Many Requests"), { statusCode: 429 });
    fakeGenerateText.mockImplementation(() => {
      throw original;
    });
    try {
      await nonstreamingProviderExecute(makeInput("openai_compat"));
      throw new Error("should have rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderExecutionError);
      expect((err as ProviderExecutionError).category).toBe("rate_limit");
      expect((err as ProviderExecutionError).cause).toBe(original);
    }
  });

  it("streaming executor wraps a setup error (streamText threw) as ProviderExecutionError", async () => {
    fakeStreamText.mockImplementation(() => {
      throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    });
    await expect(streamProviderExecutor(makeInput("openai_compat"))).rejects.toMatchObject({
      name: "ProviderExecutionError",
      category: "authentication",
      providerType: normalizeProviderType("openai_compat"),
      statusCode: 403,
    });
  });
});
