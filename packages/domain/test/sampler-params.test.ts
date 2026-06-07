import { describe, expect, it } from "bun:test";
import { resolveSamplerCapabilities, resolveSamplerSet } from "../src/sampler-params.js";
import { PROVIDER_TYPE } from "../src/platform-constants.js";

describe("sampler params", () => {
  it("uses local OpenAI-compatible sampler set for local openai-compatible presets", () => {
    expect(resolveSamplerSet("vllm", PROVIDER_TYPE.openaiCompat)).toBe("openai_local");
    expect(resolveSamplerCapabilities("tabby", PROVIDER_TYPE.openaiCompat).minP).toBe(true);
    expect(resolveSamplerCapabilities("tabby", PROVIDER_TYPE.openaiCompat).repetitionPenalty).toBe(true);
  });

  it("uses openai_chat sampler set for the real OpenAI preset", () => {
    expect(resolveSamplerSet("openai", PROVIDER_TYPE.openaiCompat)).toBe("openai_chat");

    const caps = resolveSamplerCapabilities("openai", PROVIDER_TYPE.openaiCompat);
    expect(caps.topP).toBe(true);
    expect(caps.frequencyPenalty).toBe(true);
    expect(caps.topK).toBe(false);
    expect(caps.minP).toBe(false);
    expect(caps.repetitionPenalty).toBe(false);
    expect(caps.reasoningEffort).toBe(true);
  });

  it("resolves aggregator set for cloud aggregators (OpenRouter, NanoGPT)", () => {
    expect(resolveSamplerSet("openrouter", PROVIDER_TYPE.openaiCompat)).toBe("aggregator");
    expect(resolveSamplerSet("nanogpt", PROVIDER_TYPE.openaiCompat)).toBe("aggregator");

    const caps = resolveSamplerCapabilities("openrouter", PROVIDER_TYPE.openaiCompat);
    expect(caps.topP).toBe(true);
    expect(caps.topK).toBe(true);
    expect(caps.topA).toBe(true);
    expect(caps.minP).toBe(true);
    expect(caps.repetitionPenalty).toBe(true);
    expect(caps.reasoningEffort).toBe(true);
    // Aggregators don't expose mirostat/tfs/typicalP (OpenRouter passthrough only)
    expect(caps.typicalP).toBe(false);
    expect(caps.tfsZ).toBe(false);
    expect(caps.mirostat).toBe(false);
    expect(caps.dryMultiplier).toBe(false);
    expect(caps.xtcProbability).toBe(false);
  });

  it("resolves minimal_reasoning for Google/ZAI/AI21", () => {
    expect(resolveSamplerSet("zai", PROVIDER_TYPE.openaiCompat)).toBe("minimal_reasoning");
    expect(resolveSamplerSet("ai21", PROVIDER_TYPE.openaiCompat)).toBe("minimal_reasoning");
    expect(resolveSamplerSet(null, PROVIDER_TYPE.google)).toBe("minimal_reasoning");

    const caps = resolveSamplerCapabilities("zai", PROVIDER_TYPE.openaiCompat);
    expect(caps.temperature).toBe(true);
    expect(caps.topP).toBe(true);
    expect(caps.stopSequences).toBe(true);
    expect(caps.reasoningEffort).toBe(true);
    expect(caps.frequencyPenalty).toBe(false);
    expect(caps.seed).toBe(false);
  });

  it("resolves openai_no_seed for DeepSeek/MiMO", () => {
    expect(resolveSamplerSet("deepseek", PROVIDER_TYPE.openaiCompat)).toBe("openai_no_seed");
    expect(resolveSamplerSet("mimo", PROVIDER_TYPE.openaiCompat)).toBe("openai_no_seed");

    const caps = resolveSamplerCapabilities("deepseek", PROVIDER_TYPE.openaiCompat);
    expect(caps.frequencyPenalty).toBe(true);
    expect(caps.reasoningEffort).toBe(true);
    expect(caps.seed).toBe(false);
  });

  it("resolves extended_cloud for Fireworks/Together/SiliconFlow/Moonshot", () => {
    expect(resolveSamplerSet("fireworks", PROVIDER_TYPE.openaiCompat)).toBe("extended_cloud");
    expect(resolveSamplerSet("togetherai", PROVIDER_TYPE.openaiCompat)).toBe("extended_cloud");

    const caps = resolveSamplerCapabilities("fireworks", PROVIDER_TYPE.openaiCompat);
    expect(caps.topK).toBe(true);
    expect(caps.repetitionPenalty).toBe(true);
    expect(caps.logitBias).toBe(true);
    expect(caps.reasoningEffort).toBe(true);
    expect(caps.seed).toBe(true);
  });

  it("resolves topk_limited for Perplexity/ElectronHub", () => {
    expect(resolveSamplerSet("perplexity", PROVIDER_TYPE.openaiCompat)).toBe("topk_limited");
    expect(resolveSamplerSet("electronhub", PROVIDER_TYPE.openaiCompat)).toBe("topk_limited");

    const caps = resolveSamplerCapabilities("perplexity", PROVIDER_TYPE.openaiCompat);
    expect(caps.topK).toBe(true);
    expect(caps.frequencyPenalty).toBe(true);
    expect(caps.reasoningEffort).toBe(true);
    expect(caps.seed).toBe(false);
    expect(caps.stopSequences).toBe(false);
    expect(caps.logitBias).toBe(false);
  });

  it("resolves outlier sets correctly", () => {
    // Anthropic
    expect(resolveSamplerSet(null, PROVIDER_TYPE.anthropic)).toBe("anthropic");
    const anthropicCaps = resolveSamplerCapabilities(null, PROVIDER_TYPE.anthropic);
    expect(anthropicCaps.topK).toBe(true);
    expect(anthropicCaps.reasoningEffort).toBe(true);
    expect(anthropicCaps.frequencyPenalty).toBe(false);

    // Groq
    expect(resolveSamplerSet("groq", PROVIDER_TYPE.openaiCompat)).toBe("groq");
    const groqCaps = resolveSamplerCapabilities("groq", PROVIDER_TYPE.openaiCompat);
    expect(groqCaps.seed).toBe(true);
    expect(groqCaps.reasoningEffort).toBe(true);
    expect(groqCaps.frequencyPenalty).toBe(false);
    expect(groqCaps.topK).toBe(false);

    // Pollinations
    expect(resolveSamplerSet("pollinations", PROVIDER_TYPE.openaiCompat)).toBe("pollinations");
    const pollCaps = resolveSamplerCapabilities("pollinations", PROVIDER_TYPE.openaiCompat);
    expect(pollCaps.logitBias).toBe(true);
    expect(pollCaps.repetitionPenalty).toBe(true);
    expect(pollCaps.reasoningEffort).toBe(true);
    expect(pollCaps.topK).toBe(false);
  });

  it("falls back to openai_compat_minimal for unknown providers", () => {
    expect(resolveSamplerSet("some-unknown-provider", PROVIDER_TYPE.openaiCompat)).toBe("openai_compat_minimal");
    expect(resolveSamplerSet(null, null)).toBe("openai_compat_minimal");

    const caps = resolveSamplerCapabilities("unknown", PROVIDER_TYPE.openaiCompat);
    expect(caps.temperature).toBe(true);
    expect(caps.topP).toBe(true);
    expect(caps.frequencyPenalty).toBe(true);
    expect(caps.seed).toBe(true);
    expect(caps.topK).toBe(false);
    expect(caps.reasoningEffort).toBe(false);
  });

  it("marks native local backends with backend-specific fields", () => {
    // Ollama now uses openai_local (has DRY/XTC fields)
    const ollamaCaps = resolveSamplerCapabilities("ollama", PROVIDER_TYPE.ollama);
    expect(ollamaCaps.topA).toBe(false);
    expect(ollamaCaps.minP).toBe(true);
    expect(ollamaCaps.typicalP).toBe(true);
    expect(ollamaCaps.mirostat).toBe(true);
    expect(ollamaCaps.dryMultiplier).toBe(true);
    expect(ollamaCaps.xtcProbability).toBe(true);

    const koboldCaps = resolveSamplerCapabilities("koboldcpp", PROVIDER_TYPE.koboldCpp);
    expect(koboldCaps.topA).toBe(true);
    expect(koboldCaps.typicalP).toBe(true);
    expect(koboldCaps.dryMultiplier).toBe(true);
    expect(koboldCaps.xtcProbability).toBe(true);
    expect(koboldCaps.frequencyPenalty).toBe(false);
  });
});
