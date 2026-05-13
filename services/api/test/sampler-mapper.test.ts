import { describe, it, expect } from "bun:test";
import { buildSamplerConfig } from "../src/ai/sampler-mapper.js";
import type { StoredProviderProfileRecord } from "@rp-platform/domain";

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
    seed: "42",
    reasoningEffort: "high",
    streamResponse: false,
    isActive: true,
    createdAt: "2025-01-01",
    updatedAt: "2025-01-01",
    ...overrides,
  };
}

describe("buildSamplerConfig", () => {
  // ─── Common native params (all provider types) ─────────────────────────

  it("always sets temperature, topP, maxTokens from profile", () => {
    const config = buildSamplerConfig(profile("openai_compat"));
    expect(config.temperature).toBe(0.9);
    expect(config.topP).toBe(0.95);
    expect(config.maxTokens).toBe(4096);
  });

  it("omits temperature/topP/maxTokens when undefined on profile", () => {
    const config = buildSamplerConfig(
      profile("openai_compat", { temperature: undefined as any, topP: undefined as any, maxTokens: undefined as any }),
    );
    expect(config.temperature).toBeUndefined();
    expect(config.topP).toBeUndefined();
    expect(config.maxTokens).toBeUndefined();
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

    it("sets providerOptions.openai with topK, minP, repetitionPenalty, reasoningEffort", () => {
      const config = buildSamplerConfig(profile("openai_compat"));
      expect(config.providerOptions).toBeDefined();
      expect(config.providerOptions!.openai).toEqual({
        top_k: 80,
        min_p: 0.05,
        repetition_penalty: 1.15,
        reasoning_effort: "high",
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
          topK: undefined as any,
          minP: undefined as any,
          repetitionPenalty: undefined as any,
          reasoningEffort: undefined as any,
        }),
      );
      expect(config.providerOptions).toBeUndefined();
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

    it("sets providerOptions.openai with topK, minP, repetitionPenalty but NOT reasoningEffort", () => {
      const config = buildSamplerConfig(profile("ollama"));
      expect(config.providerOptions!.openai).toEqual({
        top_k: 80,
        min_p: 0.05,
        repetition_penalty: 1.15,
      });
    });

    it("does not include reasoning_effort for non-openai_compat", () => {
      const config = buildSamplerConfig(profile("ollama"));
      expect((config.providerOptions!.openai as any).reasoning_effort).toBeUndefined();
    });
  });

  // ─── LlamaCpp ──────────────────────────────────────────────────────────

  describe("llamacpp", () => {
    it("behaves same as ollama — native freqPen/presPen/seed + providerOptions.openai", () => {
      const config = buildSamplerConfig(profile("llamacpp"));
      expect(config.frequencyPenalty).toBe(0.5);
      expect(config.presencePenalty).toBe(0.3);
      expect(config.seed).toBe(42);
      expect(config.providerOptions!.openai).toEqual({
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

    it("still sets common params: temperature, topP, maxTokens, stopSequences", () => {
      const config = buildSamplerConfig(profile("anthropic"));
      expect(config.temperature).toBe(0.9);
      expect(config.topP).toBe(0.95);
      expect(config.maxTokens).toBe(4096);
      expect(config.stopSequences).toEqual(["\\n\\n", "STOP"]);
    });
  });

  // ─── Google ────────────────────────────────────────────────────────────

  describe("google", () => {
    it("sets only temperature, topP, maxTokens, stopSequences", () => {
      const config = buildSamplerConfig(profile("google"));
      expect(config.temperature).toBe(0.9);
      expect(config.topP).toBe(0.95);
      expect(config.maxTokens).toBe(4096);
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
      expect(config.maxTokens).toBe(4096);
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
    it("sets only common native params — same as koboldcpp fallback", () => {
      const config = buildSamplerConfig(profile("some_new_provider"));
      expect(config.temperature).toBe(0.9);
      expect(config.topP).toBe(0.95);
      expect(config.maxTokens).toBe(4096);
      expect(config.frequencyPenalty).toBeUndefined();
      expect(config.presencePenalty).toBeUndefined();
      expect(config.seed).toBeUndefined();
      expect(config.topK).toBeUndefined();
      expect(config.providerOptions).toBeUndefined();
    });
  });
});
