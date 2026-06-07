import { describe, expect, it } from "bun:test";
import { resolveSamplerCapabilities, resolveSamplerSet } from "../src/sampler-params.js";
import { PROVIDER_TYPE } from "../src/platform-constants.js";

describe("sampler params", () => {
  it("uses local OpenAI-compatible sampler set for local openai-compatible presets", () => {
    expect(resolveSamplerSet("vllm", PROVIDER_TYPE.openaiCompat)).toBe("openai_local");
    expect(resolveSamplerCapabilities("tabby", PROVIDER_TYPE.openaiCompat).minP).toBe(true);
    expect(resolveSamplerCapabilities("tabby", PROVIDER_TYPE.openaiCompat).repetitionPenalty).toBe(true);
  });

  it("uses conservative OpenAI chat sampler set for cloud openai-compatible presets", () => {
    const caps = resolveSamplerCapabilities("openai", PROVIDER_TYPE.openaiCompat);
    expect(caps.topP).toBe(true);
    expect(caps.frequencyPenalty).toBe(true);
    expect(caps.topK).toBe(false);
    expect(caps.minP).toBe(false);
    expect(caps.repetitionPenalty).toBe(false);
  });

  it("marks native local backends with backend-specific fields", () => {
    expect(resolveSamplerCapabilities("ollama", PROVIDER_TYPE.ollama).topA).toBe(false);
    expect(resolveSamplerCapabilities("ollama", PROVIDER_TYPE.ollama).minP).toBe(true);
    expect(resolveSamplerCapabilities("koboldcpp", PROVIDER_TYPE.koboldCpp).topA).toBe(true);
    expect(resolveSamplerCapabilities("koboldcpp", PROVIDER_TYPE.koboldCpp).frequencyPenalty).toBe(false);
  });
});
