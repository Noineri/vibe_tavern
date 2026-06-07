import { PROVIDER_TYPE, type ProviderType } from "./platform-constants.js";

export type SamplerFieldId =
  | "temperature"
  | "topP"
  | "topK"
  | "topA"
  | "minP"
  | "frequencyPenalty"
  | "presencePenalty"
  | "repetitionPenalty"
  | "stopSequences"
  | "seed"
  | "logitBias"
  | "reasoningEffort";

export type SamplerCapabilityFlags = Record<SamplerFieldId, boolean>;

export type SamplerSetId =
  | "openai_chat"
  | "openai_local"
  | "anthropic"
  | "google"
  | "ollama_native"
  | "llamacpp_openai"
  | "koboldcpp_native";

const NONE: SamplerCapabilityFlags = {
  temperature: false,
  topP: false,
  topK: false,
  topA: false,
  minP: false,
  frequencyPenalty: false,
  presencePenalty: false,
  repetitionPenalty: false,
  stopSequences: false,
  seed: false,
  logitBias: false,
  reasoningEffort: false,
};

function set(...fields: SamplerFieldId[]): SamplerCapabilityFlags {
  return fields.reduce<SamplerCapabilityFlags>((acc, field) => {
    acc[field] = true;
    return acc;
  }, { ...NONE });
}

export const SAMPLER_SETS: Record<SamplerSetId, SamplerCapabilityFlags> = {
  openai_chat: set(
    "temperature",
    "topP",
    "frequencyPenalty",
    "presencePenalty",
    "stopSequences",
    "seed",
    "logitBias",
    "reasoningEffort",
  ),
  openai_local: set(
    "temperature",
    "topP",
    "topK",
    "minP",
    "frequencyPenalty",
    "presencePenalty",
    "repetitionPenalty",
    "stopSequences",
    "seed",
    "logitBias",
  ),
  anthropic: set("temperature", "topP", "topK", "stopSequences"),
  google: set("temperature", "topP", "stopSequences"),
  ollama_native: set(
    "temperature",
    "topP",
    "topK",
    "minP",
    "frequencyPenalty",
    "presencePenalty",
    "repetitionPenalty",
    "stopSequences",
    "seed",
    "logitBias",
  ),
  llamacpp_openai: set(
    "temperature",
    "topP",
    "topK",
    "minP",
    "frequencyPenalty",
    "presencePenalty",
    "repetitionPenalty",
    "stopSequences",
    "seed",
    "logitBias",
  ),
  koboldcpp_native: set(
    "temperature",
    "topP",
    "topK",
    "topA",
    "minP",
    "repetitionPenalty",
    "stopSequences",
    "seed",
  ),
};

const LOCAL_OPENAI_COMPAT_PRESETS = new Set([
  "vllm",
  "ooba",
  "tabby",
  "aphrodite",
]);

export function resolveSamplerSet(
  providerPreset: string | null | undefined,
  providerType: ProviderType | string | null | undefined,
): SamplerSetId {
  switch (providerType) {
    case PROVIDER_TYPE.anthropic:
      return "anthropic";
    case PROVIDER_TYPE.google:
      return "google";
    case PROVIDER_TYPE.ollama:
      return "ollama_native";
    case PROVIDER_TYPE.llamaCpp:
      return "llamacpp_openai";
    case PROVIDER_TYPE.koboldCpp:
      return "koboldcpp_native";
    case PROVIDER_TYPE.openaiCompat:
    default:
      return providerPreset && LOCAL_OPENAI_COMPAT_PRESETS.has(providerPreset)
        ? "openai_local"
        : "openai_chat";
  }
}

export function resolveSamplerCapabilities(
  providerPreset: string | null | undefined,
  providerType: ProviderType | string | null | undefined,
): SamplerCapabilityFlags {
  return SAMPLER_SETS[resolveSamplerSet(providerPreset, providerType)];
}
