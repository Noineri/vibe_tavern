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

  it("resolves aggregator set for OpenRouter (no mirostat/tfs)", () => {
    expect(resolveSamplerSet("openrouter", PROVIDER_TYPE.openaiCompat)).toBe("aggregator");

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

  it("resolves nanogpt set with mirostat/tfs/typicalP", () => {
    expect(resolveSamplerSet("nanogpt", PROVIDER_TYPE.openaiCompat)).toBe("nanogpt");

    const caps = resolveSamplerCapabilities("nanogpt", PROVIDER_TYPE.openaiCompat);
    expect(caps.topA).toBe(true);
    expect(caps.minP).toBe(true);
    expect(caps.typicalP).toBe(true);
    expect(caps.tfsZ).toBe(true);
    expect(caps.mirostat).toBe(true);
    expect(caps.mirostatTau).toBe(true);
    expect(caps.mirostatEta).toBe(true);
    expect(caps.repetitionPenalty).toBe(true);
    expect(caps.reasoningEffort).toBe(true);
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
    // openai_local stays WITHOUT the adaptive-p fields (LOCAL_SAMPLERS_ADDITION_REPORT:
    // separate llamacpp_native set, so Ollama/vLLM presets never receive them)
    expect(ollamaCaps.adaptiveTarget).toBe(false);
    expect(ollamaCaps.adaptiveDecay).toBe(false);
    // …and without the B2 llama-server numeric tail
    expect(ollamaCaps.dynatempRange).toBe(false);
    expect(ollamaCaps.dynatempExponent).toBe(false);
    expect(ollamaCaps.topNSigma).toBe(false);
    expect(ollamaCaps.smoothingFactor).toBe(false);
    expect(ollamaCaps.dryPenaltyLastN).toBe(false);
    expect(ollamaCaps.bannedStrings).toBe(false);

    const koboldCaps = resolveSamplerCapabilities("koboldcpp", PROVIDER_TYPE.koboldCpp);
    expect(koboldCaps.topA).toBe(true);
    expect(koboldCaps.typicalP).toBe(true);
    expect(koboldCaps.dryMultiplier).toBe(true);
    expect(koboldCaps.xtcProbability).toBe(true);
    expect(koboldCaps.frequencyPenalty).toBe(false);
    // KoboldCPP native supports adaptive-p (V1-verified request fields)
    expect(koboldCaps.adaptiveTarget).toBe(true);
    expect(koboldCaps.adaptiveDecay).toBe(true);
    // …and antislop phrase banning (B3, V1-verified `banned_strings`)
    expect(koboldCaps.bannedStrings).toBe(true);
    // The B2 llama-server numeric tail is llama-server-only — NOT in koboldcpp_native
    expect(koboldCaps.dynatempRange).toBe(false);
    expect(koboldCaps.topNSigma).toBe(false);
    expect(koboldCaps.smoothingFactor).toBe(false);
    expect(koboldCaps.dryPenaltyLastN).toBe(false);
  });

  it("resolves llamacpp_native for llama.cpp and Unsloth (openai_local + adaptive-p)", () => {
    expect(resolveSamplerSet(null, PROVIDER_TYPE.llamaCpp)).toBe("llamacpp_native");
    expect(resolveSamplerSet(null, PROVIDER_TYPE.unsloth)).toBe("llamacpp_native");

    const llamaCaps = resolveSamplerCapabilities(null, PROVIDER_TYPE.llamaCpp);
    // Same full local surface as openai_local…
    expect(llamaCaps.minP).toBe(true);
    expect(llamaCaps.typicalP).toBe(true);
    expect(llamaCaps.dryMultiplier).toBe(true);
    expect(llamaCaps.xtcProbability).toBe(true);
    expect(llamaCaps.mirostat).toBe(true);
    expect(llamaCaps.logitBias).toBe(true);
    // …plus adaptive-p
    expect(llamaCaps.adaptiveTarget).toBe(true);
    expect(llamaCaps.adaptiveDecay).toBe(true);
    // …plus the llama-server numeric tail (B2)
    expect(llamaCaps.dynatempRange).toBe(true);
    expect(llamaCaps.dynatempExponent).toBe(true);
    expect(llamaCaps.topNSigma).toBe(true);
    expect(llamaCaps.smoothingFactor).toBe(true);
    expect(llamaCaps.dryPenaltyLastN).toBe(true);

    const unslothCaps = resolveSamplerCapabilities(null, PROVIDER_TYPE.unsloth);
    expect(unslothCaps.adaptiveTarget).toBe(true);
    expect(unslothCaps.adaptiveDecay).toBe(true);
    expect(unslothCaps.dryMultiplier).toBe(true);
    expect(unslothCaps.dynatempRange).toBe(true);
    expect(unslothCaps.dryPenaltyLastN).toBe(true);

    // The shared openai_local set (Ollama / vLLM-family presets) is untouched
    const vllmCaps = resolveSamplerCapabilities("vllm", PROVIDER_TYPE.openaiCompat);
    expect(resolveSamplerSet("vllm", PROVIDER_TYPE.openaiCompat)).toBe("openai_local");
    expect(vllmCaps.adaptiveTarget).toBe(false);
    expect(vllmCaps.adaptiveDecay).toBe(false);
    expect(vllmCaps.dynatempRange).toBe(false);
    expect(vllmCaps.topNSigma).toBe(false);
    expect(vllmCaps.smoothingFactor).toBe(false);
    expect(vllmCaps.dryPenaltyLastN).toBe(false);
  });

  it("resolves openai_local for the LM Studio preset (B4, local pass-through)", () => {
    expect(resolveSamplerSet("lmstudio", PROVIDER_TYPE.openaiCompat)).toBe("openai_local");
    const caps = resolveSamplerCapabilities("lmstudio", PROVIDER_TYPE.openaiCompat);
    // The full local surface applies unchanged — no new set, no adapter work
    expect(caps.topK).toBe(true);
    expect(caps.minP).toBe(true);
    expect(caps.dryMultiplier).toBe(true);
    expect(caps.xtcProbability).toBe(true);
    expect(caps.logitBias).toBe(true);
    // B1/B2 llama-server-specific fields stay out until a live probe confirms
    // acceptance (same policy as Ollama)
    expect(caps.adaptiveTarget).toBe(false);
    expect(caps.topNSigma).toBe(false);
    expect(caps.dryPenaltyLastN).toBe(false);
  });

  it("keeps bannedStrings (antislop) exclusive to koboldcpp_native (B3)", () => {
    expect(resolveSamplerCapabilities("koboldcpp", PROVIDER_TYPE.koboldCpp).bannedStrings).toBe(true);
    // llama-server surface and the shared openai_local set have no upstream equivalent
    expect(resolveSamplerCapabilities(null, PROVIDER_TYPE.llamaCpp).bannedStrings).toBe(false);
    expect(resolveSamplerCapabilities(null, PROVIDER_TYPE.unsloth).bannedStrings).toBe(false);
    expect(resolveSamplerCapabilities("ollama", PROVIDER_TYPE.ollama).bannedStrings).toBe(false);
    expect(resolveSamplerCapabilities("vllm", PROVIDER_TYPE.openaiCompat).bannedStrings).toBe(false);
  });
});
