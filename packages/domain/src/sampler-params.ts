import { PROVIDER_TYPE, type ProviderType } from "./platform-constants.js";

// ---------------------------------------------------------------------------
// Sampler field identifiers — one per UI control / API param
// ---------------------------------------------------------------------------

export type SamplerFieldId =
  | "temperature"
  | "topP"
  | "topK"
  | "topA"
  | "minP"
  | "typicalP"
  | "tfsZ"
  | "repeatLastN"
  | "mirostat"
  | "mirostatTau"
  | "mirostatEta"
  | "dryMultiplier"
  | "dryBase"
  | "dryAllowedLength"
  | "drySequenceBreakers"
  | "xtcThreshold"
  | "xtcProbability"
  | "frequencyPenalty"
  | "presencePenalty"
  | "repetitionPenalty"
  | "stopSequences"
  | "seed"
  | "logitBias"
  | "reasoningEffort";

export type SamplerCapabilityFlags = Record<SamplerFieldId, boolean>;

// ---------------------------------------------------------------------------
// Sampler set IDs — one per capability profile from research
// See docs/architecture/provider-sampler-research.md
//
// Group A — aggregator     : OpenRouter, NanoGPT
// Group B — local/vLLM     : Chutes, vLLM, Ollama, llama.cpp
// Group C — minimal+reason : Google, ZAI, AI21
// Group D — openai_std     : OpenAI, xAI, Mistral
// Group E — no_seed        : DeepSeek, MiMO
// Group F — extended_cloud : Fireworks, Together, SiliconFlow, Moonshot
// Group G — topk_limited   : Perplexity, ElectronHub
// Outliers                 : Anthropic, KoboldCPP, Pollinations, Groq
// Fallback                 : unknown/custom providers
// ---------------------------------------------------------------------------

export type SamplerSetId =
  // Group A — Cloud aggregators (near-full sampler surface)
  | "aggregator"
  // Group B — Local / vLLM-based (full sampler surface)
  | "openai_local"
  // Group C — Minimal samplers + reasoning control
  | "minimal_reasoning"
  // Group D — OpenAI-standard cloud (full set)
  | "openai_chat"
  // Group E — OpenAI-standard cloud, NO seed
  | "openai_no_seed"
  // Group F — Extended cloud (topK + repPen + logitBias)
  | "extended_cloud"
  // Group G — topK but no seed/stop/repPen/logitBias
  | "topk_limited"
  // Outliers — each unique
  | "anthropic"
  | "koboldcpp_native"
  | "pollinations"
  | "groq"
  // Fallback for unknown/custom providers
  | "openai_compat_minimal";

// ---------------------------------------------------------------------------
// Capability flags builder
// ---------------------------------------------------------------------------

const NONE: SamplerCapabilityFlags = {
  temperature: false,
  topP: false,
  topK: false,
  topA: false,
  minP: false,
  typicalP: false,
  tfsZ: false,
  repeatLastN: false,
  mirostat: false,
  mirostatTau: false,
  mirostatEta: false,
  dryMultiplier: false,
  dryBase: false,
  dryAllowedLength: false,
  drySequenceBreakers: false,
  xtcThreshold: false,
  xtcProbability: false,
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

// ---------------------------------------------------------------------------
// Sampler set definitions
// ---------------------------------------------------------------------------

export const SAMPLER_SETS: Record<SamplerSetId, SamplerCapabilityFlags> = {
  // ── Group A: Cloud Aggregators ──────────────────────────────────────────
  // OpenRouter, NanoGPT — near-full surface including topA, minP, repPen
  aggregator: set(
    "temperature",
    "topP",
    "topK",
    "topA",
    "minP",
    "frequencyPenalty",
    "presencePenalty",
    "repetitionPenalty",
    "stopSequences",
    "seed",
    "logitBias",
    "reasoningEffort",
  ),

  // ── Group B: Local / vLLM-based ─────────────────────────────────────────
  // Chutes, vLLM, Ollama, llama.cpp, Aphrodite, ooba, tabby
  openai_local: set(
    "temperature",
    "topP",
    "topK",
    "minP",
    "typicalP",
    "tfsZ",
    "repeatLastN",
    "mirostat",
    "mirostatTau",
    "mirostatEta",
    "dryMultiplier",
    "dryBase",
    "dryAllowedLength",
    "drySequenceBreakers",
    "xtcThreshold",
    "xtcProbability",
    "frequencyPenalty",
    "presencePenalty",
    "repetitionPenalty",
    "stopSequences",
    "seed",
    "logitBias",
  ),

  // ── Group C: Minimal samplers + reasoning control ───────────────────────
  // Google AI Studio, ZAI (Zhipu), AI21 — temp, topP, stop, reasoning
  minimal_reasoning: set(
    "temperature",
    "topP",
    "stopSequences",
    "reasoningEffort",
  ),

  // ── Group D: OpenAI-standard cloud ──────────────────────────────────────
  // OpenAI, xAI, Mistral — full set with seed + logitBias + reasoning
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

  // ── Group E: OpenAI-standard cloud, NO seed ─────────────────────────────
  // DeepSeek, MiMO (Xiaomi) — same as openai_chat minus seed
  openai_no_seed: set(
    "temperature",
    "topP",
    "frequencyPenalty",
    "presencePenalty",
    "stopSequences",
    "reasoningEffort",
  ),

  // ── Group F: Extended cloud ─────────────────────────────────────────────
  // Fireworks, Together AI, SiliconFlow, Moonshot — topK + repPen + logitBias
  extended_cloud: set(
    "temperature",
    "topP",
    "topK",
    "frequencyPenalty",
    "presencePenalty",
    "repetitionPenalty",
    "stopSequences",
    "seed",
    "logitBias",
    "reasoningEffort",
  ),

  // ── Group G: topK but no seed/stop/repPen/logitBias ─────────────────────
  // Perplexity, ElectronHub
  topk_limited: set(
    "temperature",
    "topP",
    "topK",
    "frequencyPenalty",
    "presencePenalty",
    "reasoningEffort",
  ),

  // ── Outlier: Anthropic ──────────────────────────────────────────────────
  // topK but no penalties/logitBias. Native param names differ (mapped elsewhere).
  anthropic: set(
    "temperature",
    "topP",
    "topK",
    "stopSequences",
    "reasoningEffort",
  ),

  // ── Outlier: KoboldCPP ──────────────────────────────────────────────────
  // topA + minP + repPen but NO freqPen/presPen. Full local surface.
  koboldcpp_native: set(
    "temperature",
    "topP",
    "topK",
    "topA",
    "minP",
    "typicalP",
    "tfsZ",
    "repeatLastN",
    "mirostat",
    "mirostatTau",
    "mirostatEta",
    "dryMultiplier",
    "dryBase",
    "dryAllowedLength",
    "drySequenceBreakers",
    "xtcThreshold",
    "xtcProbability",
    "repetitionPenalty",
    "stopSequences",
    "seed",
  ),

  // ── Outlier: Pollinations ───────────────────────────────────────────────
  // OpenAI-standard + logitBias + repPen + reasoningEffort, but no topK
  pollinations: set(
    "temperature",
    "topP",
    "frequencyPenalty",
    "presencePenalty",
    "repetitionPenalty",
    "stopSequences",
    "seed",
    "logitBias",
    "reasoningEffort",
  ),

  // ── Outlier: Groq ───────────────────────────────────────────────────────
  // Only temp + topP + seed + stop + reasoningEffort. No penalties at all.
  groq: set(
    "temperature",
    "topP",
    "stopSequences",
    "seed",
    "reasoningEffort",
  ),

  // ── Fallback: unknown/custom OpenAI-compatible providers ─────────────────
  openai_compat_minimal: set(
    "temperature",
    "topP",
    "frequencyPenalty",
    "presencePenalty",
    "stopSequences",
    "seed",
    "logitBias",
  ),
};

// ---------------------------------------------------------------------------
// Provider preset → sampler set resolution
// ---------------------------------------------------------------------------

const LOCAL_OPENAI_COMPAT_PRESETS = new Set([
  "vllm",
  "ooba",
  "tabby",
  "aphrodite",
]);

/**
 * Maps provider preset IDs to their sampler set.
 * See docs/architecture/provider-sampler-research.md for the full matrix.
 */
const PRESET_SAMPLER_SET_MAP: Record<string, SamplerSetId> = {
  // Group A — aggregators
  openrouter: "aggregator",
  nanogpt: "aggregator",
  // Group B — cloud vLLM
  chutes: "openai_local",
  // Group C — minimal + reasoning
  google: "minimal_reasoning",
  zai: "minimal_reasoning",
  "zai-coding": "minimal_reasoning",
  ai21: "minimal_reasoning",
  // Group D — OpenAI-standard
  openai: "openai_chat",
  xai: "openai_chat",
  mistral: "openai_chat",
  // Group E — no seed
  deepseek: "openai_no_seed",
  mimo: "openai_no_seed",
  // Group F — extended cloud
  fireworks: "extended_cloud",
  togetherai: "extended_cloud",
  siliconflow: "extended_cloud",
  moonshot: "extended_cloud",
  // Group G — topK limited
  perplexity: "topk_limited",
  electronhub: "topk_limited",
  // Outliers
  groq: "groq",
  pollinations: "pollinations",
};

export function resolveSamplerSet(
  providerPreset: string | null | undefined,
  providerType: ProviderType | string | null | undefined,
): SamplerSetId {
  switch (providerType) {
    case PROVIDER_TYPE.anthropic:
      return "anthropic";
    case PROVIDER_TYPE.google:
      return "minimal_reasoning";
    case PROVIDER_TYPE.ollama:
      return "openai_local";
    case PROVIDER_TYPE.llamaCpp:
      return "openai_local";
    case PROVIDER_TYPE.koboldCpp:
      return "koboldcpp_native";
    case PROVIDER_TYPE.openaiCompat:
    default: {
      if (!providerPreset) return "openai_compat_minimal";
      if (LOCAL_OPENAI_COMPAT_PRESETS.has(providerPreset)) return "openai_local";
      if (providerPreset in PRESET_SAMPLER_SET_MAP) return PRESET_SAMPLER_SET_MAP[providerPreset];
      return "openai_compat_minimal";
    }
  }
}

export function resolveSamplerCapabilities(
  providerPreset: string | null | undefined,
  providerType: ProviderType | string | null | undefined,
): SamplerCapabilityFlags {
  return SAMPLER_SETS[resolveSamplerSet(providerPreset, providerType)];
}
