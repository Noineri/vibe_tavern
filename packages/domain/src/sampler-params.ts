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
  | "adaptiveTarget"
  | "adaptiveDecay"
  | "dynatempRange"
  | "dynatempExponent"
  | "topNSigma"
  | "smoothingFactor"
  | "repeatLastN"
  | "mirostat"
  | "mirostatTau"
  | "mirostatEta"
  | "dryMultiplier"
  | "dryBase"
  | "dryAllowedLength"
  | "drySequenceBreakers"
  | "dryPenaltyLastN"
  | "bannedStrings"
  | "xtcThreshold"
  | "xtcProbability"
  | "frequencyPenalty"
  | "presencePenalty"
  | "repetitionPenalty"
  | "stopSequences"
  | "seed"
  | "logitBias"
  | "reasoningEffort"
  | "unifiedLinear"
  | "unifiedQuad"
  | "unifiedConf"
  | "repetitionPenaltySlope"
  | "phraseRepPen"
  | "thinkingMode";

export type SamplerCapabilityFlags = Record<SamplerFieldId, boolean>;

// ---------------------------------------------------------------------------
// NovelAI sampler vocabularies (NOVELAI_PROVIDER_PLAN Wave 1) — the single
// source for the api-contracts zod enums and the web option lists.
// ---------------------------------------------------------------------------

/** NovelAI native `phrase_rep_pen` choices (spec `text.PhraseRepPenChoice`). */
export const PHRASE_REP_PEN = {
  off: "off",
  veryLight: "very_light",
  light: "light",
  medium: "medium",
  aggressive: "aggressive",
  veryAggressive: "very_aggressive",
} as const;

export type PhraseRepPen = typeof PHRASE_REP_PEN[keyof typeof PHRASE_REP_PEN];

/** NovelAI `/oa/v1` thinking toggle (`enable_thinking`); `auto` = not sent. */
export const THINKING_MODE = {
  auto: "auto",
  on: "on",
  off: "off",
} as const;

export type ThinkingMode = typeof THINKING_MODE[keyof typeof THINKING_MODE];

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
  // Group A — Cloud aggregator (OpenRouter — broad, no mirostat/tfs)
  | "aggregator"
  // NanoGPT — near-full surface including mirostat, tfs, typicalP
  | "nanogpt"
  // Group B — Local / vLLM-based (full sampler surface).
  // llama.cpp / Unsloth ride llama-server → llamacpp_native (own set:
  // openai_local + adaptive-p, see LOCAL_SAMPLERS_ADDITION_REPORT B1).
  | "openai_local"
  // llama.cpp / Unsloth Studio — llama-server surface: openai_local +
  // adaptive-p (`adaptiveTarget`/`adaptiveDecay`) + the llama-server numeric
  // tail (`dynatempRange`, `dynatempExponent`, `topNSigma`, `smoothingFactor`,
  // `dryPenaltyLastN`). Separate set so the shared openai_local set (Ollama,
  // vLLM-family presets) stays untouched. See LOCAL_SAMPLERS_ADDITION_REPORT
  // B1/B2.
  | "llamacpp_native"
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
  // NovelAI `/oa/v1` (Xialong / GLM-4.6) — NovelAI's own reduced sampler
  // list (evidence on SAMPLER_SETS.novelai_oa)
  | "novelai_oa"
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
  adaptiveTarget: false,
  adaptiveDecay: false,
  dynatempRange: false,
  dynatempExponent: false,
  topNSigma: false,
  smoothingFactor: false,
  repeatLastN: false,
  mirostat: false,
  mirostatTau: false,
  mirostatEta: false,
  dryMultiplier: false,
  dryBase: false,
  dryAllowedLength: false,
  drySequenceBreakers: false,
  dryPenaltyLastN: false,
  bannedStrings: false,
  xtcThreshold: false,
  xtcProbability: false,
  frequencyPenalty: false,
  presencePenalty: false,
  repetitionPenalty: false,
  stopSequences: false,
  seed: false,
  logitBias: false,
  reasoningEffort: false,
  unifiedLinear: false,
  unifiedQuad: false,
  unifiedConf: false,
  repetitionPenaltySlope: false,
  phraseRepPen: false,
  thinkingMode: false,
};

/** Runtime-ordered list of every sampler field id, derived from the `NONE`
 *  capability record (a full `Record<SamplerFieldId, boolean>`) — the single
 *  source for "what sampler fields exist". Consumed by the API-contracts schema
 *  (builds the sampler sub-schema), the FormState coverage assertion, and the
 *  DB column-coverage test. Adding a field to `SamplerFieldId` + `NONE`
 *  propagates here automatically — no parallel hand-typed list to drift. */
export const SAMPLER_FIELDS = Object.keys(NONE) as SamplerFieldId[];

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
  // OpenRouter — broad surface but does NOT natively document mirostat/tfs/typicalP
  // (may passthrough to backend, but not guaranteed)
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

  // NanoGPT — near-full surface including mirostat, tfs, typicalP
  nanogpt: set(
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

  // ── llama.cpp / Unsloth Studio ───────────────────────────────────────────
  // llama-server (OpenAI-compat /v1): full local surface + adaptive-p + the
  // llama-server numeric tail (LOCAL_SAMPLERS_ADDITION_REPORT B2).
  // `adaptiveTarget` −1 = disabled (llama.cpp default); 0.0–1.0 active.
  // Numeric-tail off defaults per upstream: dynatemp_range 0 (off),
  // dynatemp_exponent 1 (applies only when range > 0), top_n_sigma 0 (off),
  // smoothing_factor 0 (off); `dryPenaltyLastN` −1 = disabled (the field is
  // omitted from the request — llama-server rejects −1 with HTTP 400 and 0
  // means a zero window, DRY inert).
  llamacpp_native: set(
    "temperature",
    "topP",
    "topK",
    "minP",
    "typicalP",
    "tfsZ",
    "adaptiveTarget",
    "adaptiveDecay",
    "dynatempRange",
    "dynatempExponent",
    "topNSigma",
    "smoothingFactor",
    "repeatLastN",
    "mirostat",
    "mirostatTau",
    "mirostatEta",
    "dryMultiplier",
    "dryBase",
    "dryAllowedLength",
    "drySequenceBreakers",
    "dryPenaltyLastN",
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
  // topA + minP + repPen but NO freqPen/presPen. Full local surface + adaptive-p
  // (native `adaptive_target`/`adaptive_decay` request fields, V1-verified) +
  // antislop phrase banning (`bannedStrings` → native `banned_strings` request
  // field, V1-verified exact-match semantics; LOCAL_SAMPLERS_ADDITION_REPORT B3).
  koboldcpp_native: set(
    "temperature",
    "topP",
    "topK",
    "topA",
    "minP",
    "typicalP",
    "tfsZ",
    "adaptiveTarget",
    "adaptiveDecay",
    "repeatLastN",
    "mirostat",
    "mirostatTau",
    "mirostatEta",
    "dryMultiplier",
    "dryBase",
    "dryAllowedLength",
    "drySequenceBreakers",
    "bannedStrings",
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

  // ── Outlier: NovelAI /oa/v1 (Xialong / GLM-4.6) ─────────────────────
  // Evidence (NOVELAI_PROVIDER_PLAN, owner ruling 2026-10-05): NovelAI's own
  // GLM-4.6 editor shows exactly Temperature, Top-K, Nucleus (Top-P), Min-P —
  // nothing else, not reorderable; a Xialong story file from NovelAI's
  // Discord confirms the same order (`order: temperature, top_k, top_p,
  // min_p`). Plus stop strings and the `enable_thinking` switch — no
  // unified_*, penalties, seed or logit bias on this route.
  novelai_oa: set(
    "temperature",
    "topP",
    "topK",
    "minP",
    "stopSequences",
    "thinkingMode",
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
  // LM Studio (LOCAL_SAMPLERS_ADDITION_REPORT B4): its /v1 API is a pass-through
  // to the GGUF engine — OpenAI-standard samplers plus the llama.cpp extras are
  // forwarded, unknown fields ignored (V1 probe on 0.4.23: DRY applied live).
  "lmstudio",
]);

/**
 * Maps provider preset IDs to their sampler set.
 * See docs/architecture/provider-sampler-research.md for the full matrix.
 */
const PRESET_SAMPLER_SET_MAP: Record<string, SamplerSetId> = {
  // Group A — aggregators
  openrouter: "aggregator",
  nanogpt: "nanogpt",
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
  kimi: "extended_cloud",
  // Group G — topK limited
  perplexity: "topk_limited",
  electronhub: "topk_limited",
  // Outliers
  groq: "groq",
  pollinations: "pollinations",
  novelai_oa: "novelai_oa",
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
    case PROVIDER_TYPE.googleInteractions:
      return "minimal_reasoning";
    case PROVIDER_TYPE.ollama:
      return "openai_local";
    case PROVIDER_TYPE.llamaCpp:
      // llama-server: full local surface + adaptive-p.
      return "llamacpp_native";
    case PROVIDER_TYPE.unsloth:
      // Unsloth Studio wraps llama-server; same surface as llama.cpp.
      return "llamacpp_native";
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
