import { describe, expect, test } from "bun:test";
import {
  COAUTHOR_TOOL_PATH,
  COAUTHOR_TRANSPORT_CAPABILITIES,
  COAUTHOR_TRANSPORT_CAVEAT,
  PROVIDER_PRESET_ID,
  RESPONSES_SUPPORT,
  canUseCoauthorResponsesTransport,
  getCoauthorTransportCapability,
} from "../src/index.js";

describe("Co-Author transport capability map", () => {
  test("classifies every closed preset id exactly once", () => {
    expect(Object.keys(COAUTHOR_TRANSPORT_CAPABILITIES).sort()).toEqual(Object.values(PROVIDER_PRESET_ID).sort());
  });

  test("records supported cloud and local Responses presets", () => {
    for (const id of ["openai", "openrouter", "groq", "xai", "fireworks", "perplexity", "togetherai", "mimo", "nanogpt", "kimi", "ollama", "llamacpp", "koboldcpp", "unsloth"] as const) {
      expect(COAUTHOR_TRANSPORT_CAPABILITIES[id]).toEqual({ responsesSupport: RESPONSES_SUPPORT.supported, toolPath: COAUTHOR_TOOL_PATH.responses });
    }
  });

  test("keeps version, upstream, and unsupported caveats explicit", () => {
    expect(COAUTHOR_TRANSPORT_CAPABILITIES.vllm).toEqual({
      responsesSupport: RESPONSES_SUPPORT.versionDependent,
      toolPath: COAUTHOR_TOOL_PATH.responses,
      caveat: COAUTHOR_TRANSPORT_CAVEAT.vllmVersionDependent,
    });
    expect(COAUTHOR_TRANSPORT_CAPABILITIES.pollinations).toEqual({
      responsesSupport: RESPONSES_SUPPORT.unsupported,
      toolPath: COAUTHOR_TOOL_PATH.conditional,
      caveat: COAUTHOR_TRANSPORT_CAVEAT.pollinationsUpstreamDependent,
    });
    expect(COAUTHOR_TRANSPORT_CAPABILITIES.tabby).toEqual({
      responsesSupport: RESPONSES_SUPPORT.unsupported,
      toolPath: COAUTHOR_TOOL_PATH.unsupported,
      caveat: COAUTHOR_TRANSPORT_CAVEAT.tabbyToolsUnsupported,
    });
  });

  test("keeps the support map informational while allowing explicit OpenAI-compatible attempts", () => {
    expect(getCoauthorTransportCapability("custom-openai-compatible")).toBeNull();
    expect(canUseCoauthorResponsesTransport("deepseek")).toBe(true);
    expect(canUseCoauthorResponsesTransport("tabby")).toBe(true);
    expect(canUseCoauthorResponsesTransport("google")).toBe(false);
  });
});
