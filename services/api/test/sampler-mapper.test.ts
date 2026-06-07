import { describe, it, expect } from "bun:test";
import { buildSamplerConfig } from "../src/ai/sampler-mapper.js";
import type { StoredProviderProfileRecord } from "@vibe-tavern/domain";

/** Minimal profile factory — override only what matters for the test. */
function profile(
  providerPreset: string,
  overrides: Partial<StoredProviderProfileRecord> = {},
): StoredProviderProfileRecord {
  return {
    id: "test-profile",
    name: "Test",
    providerPreset,
    endpoint: "http://localhost",
    apiKey: null,
    defaultModel: null,
    contextBudget: null,
    temperature: 0.9,
    topP: 0.95,
    maxTokens: 4096,
    minP: 0.05,
    topK: 80,
    topA: 0,
    frequencyPenalty: 0.5,
    presencePenalty: 0.3,
    repetitionPenalty: 1.15,
    stopSequences: ["\\n\\n", "STOP"],
    logitBias: [],
    seed: "42",
    reasoningEffort: "high",
    showReasoning: false,
    streamResponse: false,
    customSamplers: true,
    isActive: true,
    createdAt: "2025-01-01",
    updatedAt: "2025-01-01",
    ...overrides,
  };
}

describe("buildSamplerConfig", () => {
  // ─── Common native params (all provider types) ─────────────────────────

  it("always sets temperature, topP, maxOutputTokens from profile", () => {
    const config = buildSamplerConfig(profile("openai_compat"));
    expect(config.temperature).toBe(0.9);
    expect(config.topP).toBe(0.95);
    expect(config.maxOutputTokens).toBe(4096);
  });

  it("omits temperature/topP/maxTokens when undefined on profile", () => {
    const config = buildSamplerConfig(
      profile("openai_compat", { temperature: undefined, topP: undefined, maxTokens: undefined }),
    );
    expect(config.temperature).toBeUndefined();
    expect(config.topP).toBeUndefined();
    expect(config.maxOutputTokens).toBeUndefined();
  });

  it("passes stopSequences array directly", () => {
    const config = buildSamplerConfig(profile("openai_compat"));
    expect(config.stopSequences).toEqual(["\\n\\n", "STOP"]);
  });

  it("omits stopSequences when empty", () => {
    const config = buildSamplerConfig(
      profile("openai_compat", { stopSequences: [] }),
    );
    expect(config.stopSequences).toBeUndefined();
  });

  // ─── OpenAI-compat ─────────────────────────────────────────────────────

  describe("openai_compat", () => {
    it("sets native frequencyPenalty, presencePenalty, seed", () => {
      const config = buildSamplerConfig(profile("openai_compat"));
      expect(config.frequencyPenalty).toBe(0.5);
      expect(config.presencePenalty).toBe(0.3);
      expect(config.seed).toBe(42);
    });

    it("sets providerOptions.openai_compat with topK, minP, repetitionPenalty, reasoningEffort", () => {
      const config = buildSamplerConfig(profile("openai_compat"));
      expect(config.providerOptions).toBeDefined();
      expect(config.providerOptions!.openai_compat).toEqual({
        top_k: 80,
        min_p: 0.05,
        repetition_penalty: 1.15,
        reasoningEffort: "high",
      });
    });

    it("parses numeric seed string to integer", () => {
      const config = buildSamplerConfig(
        profile("openai_compat", { seed: "123" }),
      );
      expect(config.seed).toBe(123);
    });

    it("handles null seed gracefully", () => {
      const config = buildSamplerConfig(
        profile("openai_compat", { seed: null }),
      );
      expect(config.seed).toBeUndefined();
    });

    it("omits providerOptions when all provider-specific fields are undefined", () => {
      const config = buildSamplerConfig(
        profile("openai_compat", {
          topK: undefined,
          minP: undefined,
          repetitionPenalty: undefined,
          reasoningEffort: undefined,
        }),
      );
      expect(config.providerOptions).toBeUndefined();
    });

    it("includes logit bias only for a known direct provider/model", () => {
      const config = buildSamplerConfig(
        profile("openai", {
          defaultModel: "gpt-4o-mini",
          endpoint: "https://api.openai.com/v1",
          logitBias: [{ tokenId: 123, bias: -100, text: " bad", model: "gpt-4o-mini" }],
        }),
      );
      expect((config.providerOptions!.openai_compat as Record<string, unknown>).logit_bias).toEqual({ "123": -100 });
    });

    it("omits logit bias for mixed/router providers even when entries exist", () => {
      const config = buildSamplerConfig(
        profile("nanogpt", {
          defaultModel: "gpt-4o-mini",
          endpoint: "https://nano-gpt.com/api/v1",
          logitBias: [{ tokenId: 123, bias: -100, text: " bad", model: "gpt-4o-mini" }],
        }),
      );
      expect((config.providerOptions!.openai_compat as Record<string, unknown>).logit_bias).toBeUndefined();
    });
  });

  // ─── Ollama ────────────────────────────────────────────────────────────

  describe("ollama", () => {
    it("sets native frequencyPenalty, presencePenalty, seed", () => {
      const config = buildSamplerConfig(profile("ollama"));
      expect(config.frequencyPenalty).toBe(0.5);
      expect(config.presencePenalty).toBe(0.3);
      expect(config.seed).toBe(42);
    });

    it("sets providerOptions.ollama with topK, minP, repetitionPenalty but NOT reasoningEffort", () => {
      const config = buildSamplerConfig(profile("ollama"));
      expect(config.providerOptions!.ollama).toEqual({
        top_k: 80,
        min_p: 0.05,
        repetition_penalty: 1.15,
      });
    });

    it("does not include reasoningEffort for non-openai_compat", () => {
      const config = buildSamplerConfig(profile("ollama"));
      expect((config.providerOptions!.ollama as Record<string, unknown>).reasoningEffort).toBeUndefined();
    });
  });

  // ─── LlamaCpp ──────────────────────────────────────────────────────────

  describe("llamacpp", () => {
    it("behaves same as ollama — native freqPen/presPen/seed + providerOptions.llamacpp", () => {
      const config = buildSamplerConfig(profile("llamacpp"));
      expect(config.frequencyPenalty).toBe(0.5);
      expect(config.presencePenalty).toBe(0.3);
      expect(config.seed).toBe(42);
      expect(config.providerOptions!.llamacpp).toEqual({
        top_k: 80,
        min_p: 0.05,
        repetition_penalty: 1.15,
      });
    });
  });

  // ─── Anthropic ─────────────────────────────────────────────────────────

  describe("anthropic", () => {
    it("sets native topK from profile.topK", () => {
      const config = buildSamplerConfig(profile("anthropic"));
      expect(config.topK).toBe(80);
    });

    it("does NOT set frequencyPenalty, presencePenalty, or seed", () => {
      const config = buildSamplerConfig(profile("anthropic"));
      expect(config.frequencyPenalty).toBeUndefined();
      expect(config.presencePenalty).toBeUndefined();
      expect(config.seed).toBeUndefined();
    });

    it("does NOT set providerOptions", () => {
      const config = buildSamplerConfig(profile("anthropic"));
      expect(config.providerOptions).toBeUndefined();
    });

    it("still sets common params: temperature, topP, maxOutputTokens, stopSequences", () => {
      const config = buildSamplerConfig(profile("anthropic"));
      expect(config.temperature).toBe(0.9);
      expect(config.topP).toBe(0.95);
      expect(config.maxOutputTokens).toBe(4096);
      expect(config.stopSequences).toEqual(["\\n\\n", "STOP"]);
    });
  });

  // ─── Google ────────────────────────────────────────────────────────────

  describe("google", () => {
    it("sets only temperature, topP, maxOutputTokens, stopSequences", () => {
      const config = buildSamplerConfig(profile("google"));
      expect(config.temperature).toBe(0.9);
      expect(config.topP).toBe(0.95);
      expect(config.maxOutputTokens).toBe(4096);
      expect(config.stopSequences).toEqual(["\\n\\n", "STOP"]);
    });

    it("does NOT set freqPen, presPen, seed, topK, providerOptions", () => {
      const config = buildSamplerConfig(profile("google"));
      expect(config.frequencyPenalty).toBeUndefined();
      expect(config.presencePenalty).toBeUndefined();
      expect(config.seed).toBeUndefined();
      expect(config.topK).toBeUndefined();
      expect(config.providerOptions).toBeUndefined();
    });
  });

  // ─── KoboldCpp / unknown ───────────────────────────────────────────────

  describe("koboldcpp", () => {
    it("sets only common native params", () => {
      const config = buildSamplerConfig(profile("koboldcpp"));
      expect(config.temperature).toBe(0.9);
      expect(config.topP).toBe(0.95);
      expect(config.maxOutputTokens).toBe(4096);
      expect(config.stopSequences).toEqual(["\\n\\n", "STOP"]);
    });

    it("does NOT set any provider-specific fields", () => {
      const config = buildSamplerConfig(profile("koboldcpp"));
      expect(config.frequencyPenalty).toBeUndefined();
      expect(config.presencePenalty).toBeUndefined();
      expect(config.seed).toBeUndefined();
      expect(config.topK).toBeUndefined();
      expect(config.providerOptions).toBeUndefined();
    });
  });

  describe("unknown provider type", () => {
    it("treats unknown providers as OpenAI-compatible but still gates logit bias fail-closed", () => {
      const config = buildSamplerConfig(profile("some_new_provider", {
        defaultModel: "gpt-4o-mini",
        logitBias: [{ tokenId: 123, bias: -100, model: "gpt-4o-mini" }],
      }));
      expect(config.temperature).toBe(0.9);
      expect(config.topP).toBe(0.95);
      expect(config.maxOutputTokens).toBe(4096);
      expect(config.frequencyPenalty).toBe(0.5);
      expect(config.presencePenalty).toBe(0.3);
      expect(config.seed).toBe(42);
      expect((config.providerOptions!.openai_compat as Record<string, unknown>).logit_bias).toBeUndefined();
    });
  });

  // ─── customSamplers disabled ──────────────────────────────────────────

  describe("customSamplers disabled", () => {
    it("omits topP when customSamplers is false", () => {
      const config = buildSamplerConfig(profile("openai_compat", { customSamplers: false }));
      expect(config.topP).toBeUndefined();
    });

    it("omits frequencyPenalty, presencePenalty when customSamplers is false", () => {
      const config = buildSamplerConfig(profile("openai_compat", { customSamplers: false }));
      expect(config.frequencyPenalty).toBeUndefined();
      expect(config.presencePenalty).toBeUndefined();
    });

    it("omits providerOptions when customSamplers is false", () => {
      const config = buildSamplerConfig(profile("openai_compat", { customSamplers: false }));
      expect(config.providerOptions).toBeUndefined();
    });

    it("omits topK for anthropic when customSamplers is false", () => {
      const config = buildSamplerConfig(profile("anthropic", { customSamplers: false }));
      expect(config.topK).toBeUndefined();
    });

    it("still sends temperature, maxOutputTokens, stopSequences when customSamplers is false", () => {
      const config = buildSamplerConfig(profile("openai_compat", { customSamplers: false }));
      expect(config.temperature).toBe(0.9);
      expect(config.maxOutputTokens).toBe(4096);
      expect(config.stopSequences).toEqual(["\\n\\n", "STOP"]);
    });

    it("still passes seed when customSamplers is false", () => {
      const config = buildSamplerConfig(profile("openai_compat", { customSamplers: false, seed: "99" }));
      expect(config.seed).toBe(99);
    });
  });
});
