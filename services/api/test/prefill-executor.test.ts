import { describe, it, expect, mock, beforeEach } from "bun:test";
import { getProviderCapabilities, PROVIDER_CAPABILITIES } from "../src/ai/provider-capabilities.js";
import type { ProviderType } from "@rp-platform/domain";
import type { ProviderExecutionInput } from "../src/ai/provider-execution-types.js";

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
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };
});

const fakeStreamText = mock((opts: { messages: unknown }) => {
  capturedStreamTextMessages = opts.messages;
  return {
    textStream: (async function* () { yield "Hello from stream"; })(),
    text: Promise.resolve("Hello from stream"),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }),
  };
});

mock.module("ai", () => ({
  generateText: fakeGenerateText,
  streamText: fakeStreamText,
}));

// Import executors after mock is registered
const { nonstreamingProviderExecute } = await import(
  "../src/ai/nonstreaming-provider-executor.js"
);
const { streamProviderExecutor } = await import(
  "../src/ai/stream-provider-executor.js"
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
    } as any,
    ...(prefill !== undefined ? { prefill } : {}),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Part 1 — Capability flags (pure data, no mocking needed)
// ═══════════════════════════════════════════════════════════════════════════

describe("provider-capabilities: prefill flags", () => {
  const prefillTrue: ProviderType[] = ["openai_compat", "ollama", "llamacpp"];
  const prefillFalse: ProviderType[] = ["anthropic", "google", "koboldcpp"];

  it("has exactly 6 provider types defined", () => {
    expect(Object.keys(PROVIDER_CAPABILITIES).length).toBe(6);
  });

  it("has no null prefill values", () => {
    for (const [type, caps] of Object.entries(PROVIDER_CAPABILITIES)) {
      expect(caps.prefill).not.toBeNull(`${type} still has null prefill`);
    }
  });

  for (const type of prefillTrue) {
    it(`${type}.prefill is true`, () => {
      expect(getProviderCapabilities(type as ProviderType).prefill).toBe(true);
    });
  }

  for (const type of prefillFalse) {
    it(`${type}.prefill is false`, () => {
      expect(getProviderCapabilities(type as ProviderType).prefill).toBe(false);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Part 2 — Nonstreaming executor prefill logic
// ═══════════════════════════════════════════════════════════════════════════

describe("nonstreaming executor: prefill message injection", () => {
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

describe("streaming executor: prefill message injection", () => {
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
