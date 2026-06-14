import { describe, it, expect } from "bun:test";
import { buildSamplerConfig } from "../src/infrastructure/ai/sampler-mapper.js";
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
    topA: 0.4,
    typicalP: 0.97,
    tfsZ: 0.9,
    repeatLastN: 256,
    mirostat: 2,
    mirostatTau: 6,
    mirostatEta: 0.2,
    dryMultiplier: 0.8,
    dryBase: 1.75,
    dryAllowedLength: 3,
    drySequenceBreakers: ["\n", ":", "\""],
    xtcThreshold: 0.12,
    xtcProbability: 0.4,
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
    const config = buildSamplerConfig(profile("openai"));
    expect(config.temperature).toBe(0.9);
    expect(config.topP).toBe(0.95);
    expect(config.maxOutputTokens).toBe(4096);
  });

  it("omits temperature/topP/maxTokens when undefined on profile", () => {
    const config = buildSamplerConfig(
      profile("openai", { temperature: undefined, topP: undefined, maxTokens: undefined }),
    );
    expect(config.temperature).toBeUndefined();
    expect(config.topP).toBeUndefined();
    expect(config.maxOutputTokens).toBeUndefined();
  });

  it("passes stopSequences array directly", () => {
    const config = buildSamplerConfig(profile("openai"));
    expect(config.stopSequences).toEqual(["\\n\\n", "STOP"]);
  });

  it("omits stopSequences when empty", () => {
    const config = buildSamplerConfig(
      profile("openai", { stopSequences: [] }),
    );
    expect(config.stopSequences).toBeUndefined();
  });

  // ─── OpenAI (openai_chat set — no topK/minP/repPen in native) ──────────

  describe("openai (openai_chat)", () => {
    it("sets native frequencyPenalty, presencePenalty, seed", () => {
      const config = buildSamplerConfig(profile("openai"));
      expect(config.frequencyPenalty).toBe(0.5);
      expect(config.presencePenalty).toBe(0.3);
      expect(config.seed).toBe(42);
    });

    it("sets providerOptions.openai_compat with reasoningEffort only (openai_chat has no topK/minP)", () => {
      const config = buildSamplerConfig(profile("openai"));
      expect(config.providerOptions).toBeDefined();
      // openai_chat set: no topK, topA, minP, repetitionPenalty, dry*, xtc*, mirostat*
      // logitBias is in the set but no matching model entries exist → omitted
      expect(config.providerOptions!.openai_compat).toEqual({
        reasoningEffort: "high",
      });
    });

    it("includes logit bias for a matching model", () => {
      const config = buildSamplerConfig(
        profile("openai", {
          defaultModel: "gpt-4o-mini",
          endpoint: "https://api.openai.com/v1",
          logitBias: [{ tokenId: 123, bias: -100, text: " bad", model: "gpt-4o-mini" }],
        }),
      );
      expect((config.providerOptions!.openai_compat as Record<string, unknown>).logit_bias).toEqual({ "123": -100 });
    });

    it("filters logit_bias to entries matching current model", () => {
      const config = buildSamplerConfig(
        profile("openai", {
          defaultModel: "gpt-4o-mini",
          endpoint: "https://api.openai.com/v1",
          logitBias: [
            { tokenId: 100, bias: -100, model: "gpt-4o-mini" },
            { tokenId: 200, bias: 50, model: "gpt-4o" },
            { tokenId: 300, bias: -50, model: "gpt-4o-mini" },
          ],
        }),
      );
      const bias = (config.providerOptions!.openai_compat as Record<string, unknown>).logit_bias as Record<string, number>;
      expect(Object.keys(bias)).toHaveLength(2);
      expect(bias["100"]).toBe(-100);
      expect(bias["300"]).toBe(-50);
      expect(bias["200"]).toBeUndefined();
    });
  });

  // ─── OpenRouter (aggregator set — full surface) ────────────────────────

  describe("openrouter (aggregator)", () => {
    it("sends topK, topA, minP, repetitionPenalty via providerOptions but NOT mirostat/tfs", () => {
      const config = buildSamplerConfig(profile("openrouter"));
      expect(config.providerOptions!.openai_compat).toBeDefined();
      const opts = config.providerOptions!.openai_compat as Record<string, unknown>;
      expect(opts.top_k).toBe(80);
      expect(opts.top_a).toBe(0.4);
      expect(opts.min_p).toBe(0.05);
      expect(opts.repetition_penalty).toBe(1.15);
      expect(opts.reasoningEffort).toBe("high");
      // aggregator set does not include mirostat/tfs/typicalP
      expect(opts.mirostat).toBeUndefined();
      expect(opts.tfs_z).toBeUndefined();
      expect(opts.typical_p).toBeUndefined();
    });

    it("omits dry*/xtc*/mirostat (aggregator set does not have them)", () => {
      const config = buildSamplerConfig(profile("openrouter"));
      const opts = config.providerOptions!.openai_compat as Record<string, unknown>;
      expect(opts.dry_multiplier).toBeUndefined();
      expect(opts.xtc_threshold).toBeUndefined();
      expect(opts.mirostat).toBeUndefined();
    });

    it("omits logit_bias for router/aggregator providers", () => {
      const config = buildSamplerConfig(
        profile("openrouter", {
          defaultModel: "gpt-4o-mini",
          endpoint: "https://openrouter.ai/api/v1",
          logitBias: [{ tokenId: 123, bias: -100, text: " bad", model: "gpt-4o-mini" }],
        }),
      );
      const opts = config.providerOptions!.openai_compat as Record<string, unknown>;
      expect(opts.logit_bias).toBeUndefined();
    });
  });

  // ─── NanoGPT (nanogpt — near-full surface with mirostat/tfs) ────────────

  describe("nanogpt (near-full surface)", () => {
    it("sends topK, topA, minP, mirostat, tfs, typicalP, repetitionPenalty via providerOptions", () => {
      const config = buildSamplerConfig(profile("nanogpt"));
      expect(config.providerOptions!.openai_compat).toBeDefined();
      const opts = config.providerOptions!.openai_compat as Record<string, unknown>;
      expect(opts.top_k).toBe(80);
      expect(opts.top_a).toBe(0.4);
      expect(opts.min_p).toBe(0.05);
      expect(opts.typical_p).toBe(0.97);
      expect(opts.tfs_z).toBe(0.9);
      expect(opts.mirostat).toBe(2);
      expect(opts.mirostat_tau).toBe(6);
      expect(opts.mirostat_eta).toBe(0.2);
      expect(opts.repetition_penalty).toBe(1.15);
      expect(opts.reasoningEffort).toBe("high");
    });

    it("omits dry*/xtc (nanogpt set does not have them)", () => {
      const config = buildSamplerConfig(profile("nanogpt"));
      const opts = config.providerOptions!.openai_compat as Record<string, unknown>;
      expect(opts.dry_multiplier).toBeUndefined();
      expect(opts.xtc_threshold).toBeUndefined();
    });

    it("omits logit_bias for aggregator providers", () => {
      const config = buildSamplerConfig(
        profile("nanogpt", {
          defaultModel: "gpt-4o-mini",
          endpoint: "https://nano-gpt.com/api/v1",
          logitBias: [{ tokenId: 123, bias: -100, text: " bad", model: "gpt-4o-mini" }],
        }),
      );
      const opts = config.providerOptions!.openai_compat as Record<string, unknown>;
      expect(opts.logit_bias).toBeUndefined();
    });
  });

  // ─── DeepSeek (openai_no_seed — no seed, no topK) ─────────────────────

  describe("deepseek (openai_no_seed)", () => {
    it("sends freqPen, presPen, reasoningEffort but NOT seed", () => {
      const config = buildSamplerConfig(profile("deepseek"));
      expect(config.frequencyPenalty).toBe(0.5);
      expect(config.presencePenalty).toBe(0.3);
      expect(config.seed).toBeUndefined();
      expect(config.providerOptions!.openai_compat).toEqual({
        reasoningEffort: "high",
      });
    });
  });

  // ─── Groq (groq set — no penalties) ────────────────────────────────────

  describe("groq", () => {
    it("sends only seed and reasoningEffort, no penalties", () => {
      const config = buildSamplerConfig(profile("groq"));
      expect(config.frequencyPenalty).toBeUndefined();
      expect(config.presencePenalty).toBeUndefined();
      expect(config.seed).toBe(42);
      // groq set has reasoningEffort — goes through providerOptions
      expect(config.providerOptions!.openai_compat).toEqual({
        reasoningEffort: "high",
      });
    });
  });

  // ─── Perplexity (topk_limited — no seed/stop/repPen/logitBias) ─────────

  describe("perplexity (topk_limited)", () => {
    it("sends topK, freqPen, presPen via providerOptions, no seed/stop/logitBias", () => {
      const config = buildSamplerConfig(profile("perplexity"));
      expect(config.stopSequences).toBeUndefined(); // not supported
      expect(config.frequencyPenalty).toBe(0.5);
      expect(config.presencePenalty).toBe(0.3);
      expect(config.seed).toBeUndefined();
      const opts = config.providerOptions!.openai_compat as Record<string, unknown>;
      expect(opts.top_k).toBe(80);
      expect(opts.repetition_penalty).toBeUndefined();
      expect(opts.logit_bias).toBeUndefined();
      expect(opts.reasoningEffort).toBe("high");
    });
  });

  // ─── Google (minimal_reasoning) ────────────────────────────────────────

  describe("google (minimal_reasoning)", () => {
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

  // ─── Ollama (openai_local — full local surface) ────────────────────────

  describe("ollama (openai_local)", () => {
    it("sets native frequencyPenalty, presencePenalty, seed", () => {
      const config = buildSamplerConfig(profile("ollama"));
      expect(config.frequencyPenalty).toBe(0.5);
      expect(config.presencePenalty).toBe(0.3);
      expect(config.seed).toBe(42);
    });

    it("sets providerOptions.ollama with topK, minP, repeat_penalty, dry/xtc/mirostat", () => {
      const config = buildSamplerConfig(profile("ollama"));
      expect(config.providerOptions!.ollama).toEqual({
        top_k: 80,
        min_p: 0.05,
        typical_p: 0.97,
        tfs_z: 0.9,
        repeat_last_n: 256,
        mirostat: 2,
        mirostat_tau: 6,
        mirostat_eta: 0.2,
        dry_multiplier: 0.8,
        dry_base: 1.75,
        dry_allowed_length: 3,
        dry_sequence_breakers: ["\n", ":", "\""],
        xtc_threshold: 0.12,
        xtc_probability: 0.4,
        repeat_penalty: 1.15,
      });
    });

    it("does not include reasoningEffort for ollama", () => {
      const config = buildSamplerConfig(profile("ollama"));
      expect((config.providerOptions!.ollama as Record<string, unknown>).reasoningEffort).toBeUndefined();
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

  // ─── KoboldCpp ─────────────────────────────────────────────────────────

  describe("koboldcpp", () => {
    it("sets only common native params", () => {
      const config = buildSamplerConfig(profile("koboldcpp"));
      expect(config.temperature).toBe(0.9);
      expect(config.maxOutputTokens).toBe(4096);
      expect(config.stopSequences).toEqual(["\\n\\n", "STOP"]);
    });

    it("sets providerOptions.koboldcpp with top_k, top_p, min_p, rep_pen, dry/xtc/mirostat", () => {
      const config = buildSamplerConfig(profile("koboldcpp"));
      expect(config.providerOptions!.koboldcpp).toEqual({
        top_k: 80,
        top_p: 0.95,
        top_a: 0.4,
        min_p: 0.05,
        typical: 0.97,
        tfs: 0.9,
        rep_pen_range: 256,
        rep_pen: 1.15,
        dry_multiplier: 0.8,
        dry_base: 1.75,
        dry_allowed_length: 3,
        dry_sequence_breakers: ["\n", ":", "\""],
        xtc_threshold: 0.12,
        xtc_probability: 0.4,
        mirostat: 2,
        mirostat_tau: 6,
        mirostat_eta: 0.2,
      });
    });

    it("does NOT set native frequencyPenalty, presencePenalty, seed", () => {
      const config = buildSamplerConfig(profile("koboldcpp"));
      expect(config.frequencyPenalty).toBeUndefined();
      expect(config.presencePenalty).toBeUndefined();
      expect(config.seed).toBeUndefined();
    });
  });

  // ─── Unknown / fallback ───────────────────────────────────────────────

  describe("unknown provider type", () => {
    it("treats unknown providers as openai_compat_minimal (no topK/minP/repPen)", () => {
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
      // openai_compat_minimal: has logitBias but resolveLogitBiasSupport gates it
      expect(config.providerOptions).toBeUndefined();
    });
  });

  // ─── customSamplers disabled ──────────────────────────────────────────

  describe("customSamplers disabled", () => {
    it("omits topP when customSamplers is false", () => {
      const config = buildSamplerConfig(profile("openai", { customSamplers: false }));
      expect(config.topP).toBeUndefined();
    });

    it("omits frequencyPenalty, presencePenalty when customSamplers is false", () => {
      const config = buildSamplerConfig(profile("openai", { customSamplers: false }));
      expect(config.frequencyPenalty).toBeUndefined();
      expect(config.presencePenalty).toBeUndefined();
    });

    it("omits providerOptions when customSamplers is false", () => {
      const config = buildSamplerConfig(profile("openai", { customSamplers: false }));
      expect(config.providerOptions).toBeUndefined();
    });

    it("omits topK for anthropic when customSamplers is false", () => {
      const config = buildSamplerConfig(profile("anthropic", { customSamplers: false }));
      expect(config.topK).toBeUndefined();
    });

    it("still sends temperature, maxOutputTokens, stopSequences when customSamplers is false", () => {
      const config = buildSamplerConfig(profile("openai", { customSamplers: false }));
      expect(config.temperature).toBe(0.9);
      expect(config.maxOutputTokens).toBe(4096);
      expect(config.stopSequences).toEqual(["\\n\\n", "STOP"]);
    });

    it("still passes seed when customSamplers is false", () => {
      const config = buildSamplerConfig(profile("openai", { customSamplers: false, seed: "99" }));
      expect(config.seed).toBe(99);
    });
  });
});
