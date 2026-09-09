/**
 * Sampler mapper — routes sampler fields from StoredProviderProfileRecord
 * to either native AI SDK parameters or per-provider providerOptions namespaces.
 *
 * Both executors (nonstreaming, streaming) spread the returned SamplerConfig
 * into their generateText() / streamText() call.
 *
 * When `customSamplers` is false, only basic params (temperature, maxOutputTokens,
 * stopSequences, seed, reasoningEffort) are sent to the provider. All advanced
 * sampler fields (topP, topK, minP, topA, typical/tfs, mirostat, DRY/XTC,
 * penalties) are skipped so the provider uses its own defaults.
 *
 * All sampler output is gated by resolveSamplerCapabilities() — only fields
 * the provider actually supports are emitted, preventing API errors from
 * unsupported parameters.
 */

import type { JSONValue } from "@ai-sdk/provider";
import {
  PROVIDER_TYPE,
  normalizeProviderType,
  resolveLogitBiasSupport,
  resolveSamplerCapabilities,
} from "@vibe-tavern/domain";
import type { StoredProviderProfileRecord, SamplerFieldId } from "@vibe-tavern/domain";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Config object spreadable into generateText() / streamText(). */
export interface SamplerConfig {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  topK?: number;
  providerOptions?: Record<string, Record<string, JSONValue>>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * llama.cpp sampler chain emitted for llama-server-backed providers
 * (LOCAL_SAMPLERS_ADDITION_REPORT B1/B2, V1 probe on llama-server b10786): on
 * the /v1/chat endpoint exotic samplers are accepted but ONLY applied when
 * listed in the `samplers` JSON array — providing the chain replaces the
 * server's default chain, so it must carry the full default order or
 * previously-applied samplers (temperature, penalties, top_k/top_p/min_p, dry,
 * xtc) would be silently dropped. Names are llama.cpp's canonical sampler
 * names (common_sampler_types_from_names); the V1 probe confirmed `adaptive`
 * alone does NOT match — `adaptive_p` does. `top_n_sigma` and `dry` are part
 * of the same chain, so the B2 numeric tail (top_n_sigma, DRY window) rides
 * this emission without new entries; dynatemp_* and smoothing_factor are
 * parameters consumed by the listed temperature/top_p samplers.
 * `adaptive_p` is listed LAST and only when adaptive-p itself is enabled: it
 * is a token-selecting sampler (replaces `dist`) and llama.cpp always appends
 * it at the very end of the chain.
 * KoboldCPP's native path needs no chain (its request fields are standalone).
 */
const LLAMACPP_SAMPLER_CHAIN_BASE = [
  "penalties",
  "dry",
  "top_n_sigma",
  "top_k",
  "typ_p",
  "top_p",
  "min_p",
  "xtc",
  "temperature",
] as const;

const LLAMACPP_SAMPLER_CHAIN = [...LLAMACPP_SAMPLER_CHAIN_BASE, "adaptive_p"] as const;

/** Emit the adaptive-p request fields for one provider bag. Shared by the
 *  llama.cpp/unsloth (llama-server) and koboldcpp (native request fields)
 *  branches. `adaptiveTarget` values < 0 mean disabled (llama.cpp's default
 *  −1) — nothing is emitted. The `samplers` chain is emitted separately by
 *  the llama-server branch (see emitLlamaSamplerChain). */
function emitAdaptivePOptions(
  providerOpts: Record<string, JSONValue>,
  can: (field: SamplerFieldId) => boolean,
  profile: StoredProviderProfileRecord,
): void {
  if (!(can("adaptiveTarget") && profile.adaptiveTarget != null && profile.adaptiveTarget >= 0)) return;
  providerOpts.adaptive_target = profile.adaptiveTarget;
  if (can("adaptiveDecay") && profile.adaptiveDecay != null) {
    providerOpts.adaptive_decay = profile.adaptiveDecay;
  }
}

/** Whether any of the llama-server-only exotic samplers that REQUIRE a chain
 *  entry (adaptive-p, top_n_sigma, DRY) is active for this profile.
 *  dynatemp_* / smoothing_factor are temperature/top_p modifiers and do not
 *  force the chain on their own, but they are covered whenever the chain IS
 *  emitted (they ride the same request fields). */
function isLlamaChainActive(
  can: (field: SamplerFieldId) => boolean,
  profile: StoredProviderProfileRecord,
): boolean {
  const adaptiveOn = can("adaptiveTarget") && profile.adaptiveTarget != null && profile.adaptiveTarget >= 0;
  if (adaptiveOn) return true;
  if (can("topNSigma") && profile.topNSigma != null && profile.topNSigma > 0) return true;
  if (can("dryPenaltyLastN") && profile.dryPenaltyLastN != null && profile.dryPenaltyLastN > 0) return true;
  return false;
}

/** Emit the llama-server numeric tail (LOCAL_SAMPLERS_ADDITION_REPORT B2).
 *  Off semantics follow upstream defaults: dynatemp_range / top_n_sigma /
 *  smoothing_factor 0 = disabled (nothing emitted), dynatemp_exponent only
 *  rides an enabled range. `dry_penalty_last_n` (V1 probe): llama-server
 *  REJECTS −1 with HTTP 400 and 0 means a zero window (DRY inert), so the
 *  disabled sentinel (−1, the column default) and 0 are both omitted — only a
 *  real window (> 0, recommended 512) is ever emitted. */
function emitLlamaNumericTailOptions(
  providerOpts: Record<string, JSONValue>,
  can: (field: SamplerFieldId) => boolean,
  profile: StoredProviderProfileRecord,
): void {
  if (can("topNSigma") && profile.topNSigma != null && profile.topNSigma > 0) {
    providerOpts.top_n_sigma = profile.topNSigma;
  }
  if (can("dynatempRange") && profile.dynatempRange != null && profile.dynatempRange > 0) {
    providerOpts.dynatemp_range = profile.dynatempRange;
    if (can("dynatempExponent") && profile.dynatempExponent != null) {
      providerOpts.dynatemp_exponent = profile.dynatempExponent;
    }
  }
  if (can("smoothingFactor") && profile.smoothingFactor != null && profile.smoothingFactor > 0) {
    providerOpts.smoothing_factor = profile.smoothingFactor;
  }
  if (can("dryPenaltyLastN") && profile.dryPenaltyLastN != null && profile.dryPenaltyLastN > 0) {
    providerOpts.dry_penalty_last_n = profile.dryPenaltyLastN;
  }
}

/**
 * Build the sampler config for a given provider profile.
 *
 * Returns an object that can be spread directly into generateText() / streamText().
 * Routes each sampler field to either native AI SDK params or providerOptions
 * based on the provider type.
 *
 * When `customSamplers` is false, advanced sampler params are omitted entirely,
 * letting the provider use its built-in defaults.
 *
 * All fields are gated by resolveSamplerCapabilities() for the provider's
 * preset + type, so only supported params reach the API.
 */
export function buildSamplerConfig(
  profile: StoredProviderProfileRecord,
): SamplerConfig {
  const providerType = normalizeProviderType(profile.providerPreset);
  const caps = resolveSamplerCapabilities(profile.providerPreset, providerType);

  /** Check if a sampler field is supported by this provider. */
  const can = (field: SamplerFieldId): boolean => caps[field] === true;

  // -- Always-sent params: temperature, maxOutputTokens, stopSequences --
  const config: SamplerConfig = {};

  if (can("temperature") && profile.temperature != null) config.temperature = profile.temperature;
  if (profile.maxTokens != null && profile.maxTokens > 0) config.maxOutputTokens = profile.maxTokens;

  if (can("stopSequences") && profile.stopSequences.length > 0) {
    config.stopSequences = profile.stopSequences;
  }

  // -- If custom samplers are disabled, skip all advanced params --
  if (!profile.customSamplers) {
    // Only pass seed (if set and supported) even without custom samplers
    if (can("seed") && profile.seed != null) {
      const parsed = typeof profile.seed === "number"
        ? profile.seed
        : parseInt(String(profile.seed), 10);
      if (!isNaN(parsed)) config.seed = parsed;
    }
    return config;
  }

  // -- Custom samplers enabled: route advanced params per provider type --

  if (can("topP") && profile.topP != null) config.topP = profile.topP;

  switch (providerType) {
    // -- OpenAI-compatible providers + local native Ollama/llamacpp --------
    case PROVIDER_TYPE.openaiCompat:
    case PROVIDER_TYPE.ollama:
    case PROVIDER_TYPE.llamaCpp:
    case PROVIDER_TYPE.unsloth: {
      // Native params (gated by capabilities)
      if (can("frequencyPenalty") && profile.frequencyPenalty != null) config.frequencyPenalty = profile.frequencyPenalty;
      if (can("presencePenalty") && profile.presencePenalty != null) config.presencePenalty = profile.presencePenalty;
      if (can("seed") && profile.seed != null) {
        const parsed = typeof profile.seed === "number"
          ? profile.seed
          : parseInt(String(profile.seed), 10);
        if (!isNaN(parsed)) config.seed = parsed;
      }

      // providerOptions.<providerName> namespace — must match createOpenAICompatible({ name })
      const providerOptionsKey = providerType === PROVIDER_TYPE.openaiCompat ? "openai_compat"
        : providerType === PROVIDER_TYPE.ollama ? "ollama"
        : providerType === PROVIDER_TYPE.unsloth ? "unsloth"
        : "llamacpp";
      const providerOpts: Record<string, JSONValue> = {};
      if (can("topK") && profile.topK != null) providerOpts.top_k = profile.topK;
      if (can("topA") && profile.topA != null) providerOpts.top_a = profile.topA;
      if (can("minP") && profile.minP != null) providerOpts.min_p = profile.minP;
      if (can("typicalP") && profile.typicalP != null) providerOpts.typical_p = profile.typicalP;
      if (can("tfsZ") && profile.tfsZ != null) providerOpts.tfs_z = profile.tfsZ;
      // adaptive-p — only applied on /v1/chat when listed in the `samplers`
      // chain (V1 probe); the chain emission is what makes it take effect.
      emitAdaptivePOptions(providerOpts, can, profile);
      // llama-server numeric tail (B2). The chain is emitted when adaptive-p
      // OR any chain-gated exotic (top_n_sigma, DRY window) is active — the
      // tail params are inert without it.
      emitLlamaNumericTailOptions(providerOpts, can, profile);
      if (isLlamaChainActive(can, profile)) {
        const adaptiveOn = can("adaptiveTarget") && profile.adaptiveTarget != null && profile.adaptiveTarget >= 0;
        providerOpts.samplers = adaptiveOn ? [...LLAMACPP_SAMPLER_CHAIN] : [...LLAMACPP_SAMPLER_CHAIN_BASE];
      }
      if (can("repeatLastN") && profile.repeatLastN != null) providerOpts.repeat_last_n = profile.repeatLastN;
      if (can("mirostat") && profile.mirostat != null) providerOpts.mirostat = profile.mirostat;
      if (can("mirostatTau") && profile.mirostatTau != null) providerOpts.mirostat_tau = profile.mirostatTau;
      if (can("mirostatEta") && profile.mirostatEta != null) providerOpts.mirostat_eta = profile.mirostatEta;
      if (can("dryMultiplier") && profile.dryMultiplier != null) providerOpts.dry_multiplier = profile.dryMultiplier;
      if (can("dryBase") && profile.dryBase != null) providerOpts.dry_base = profile.dryBase;
      if (can("dryAllowedLength") && profile.dryAllowedLength != null) providerOpts.dry_allowed_length = profile.dryAllowedLength;
      if (can("drySequenceBreakers") && profile.drySequenceBreakers?.length) providerOpts.dry_sequence_breakers = profile.drySequenceBreakers;
      if (can("xtcThreshold") && profile.xtcThreshold != null) providerOpts.xtc_threshold = profile.xtcThreshold;
      if (can("xtcProbability") && profile.xtcProbability != null) providerOpts.xtc_probability = profile.xtcProbability;
      if (can("repetitionPenalty") && profile.repetitionPenalty != null) {
        // Ollama's native name is repeat_penalty; OpenAI-compatible llama.cpp
        // style providers commonly accept repetition_penalty.
        if (providerType === PROVIDER_TYPE.ollama) providerOpts.repeat_penalty = profile.repetitionPenalty;
        else providerOpts.repetition_penalty = profile.repetitionPenalty;
      }

      // Logit bias: map entries to Record<number, number>
      if (can("logitBias") && profile.logitBias?.length && resolveLogitBiasSupport(profile.providerPreset, profile.defaultModel, profile.endpoint).supported) {
        const currentModel = profile.defaultModel ?? "";
        const usableEntries = profile.logitBias.filter((entry) => currentModel.length > 0 && entry.model === currentModel);
        if (usableEntries.length > 0) {
          const biasMap: Record<string, number> = {};
          for (const entry of usableEntries) {
            biasMap[String(entry.tokenId)] = entry.bias;
          }
          providerOpts.logit_bias = biasMap;
        }
      }

      // reasoningEffort — gated by capabilities
      if (can("reasoningEffort") && profile.reasoningEffort != null) {
        providerOpts.reasoningEffort = profile.reasoningEffort;
      }

      // Unsloth Studio: map showReasoning -> enable_thinking (Unsloth-specific body field
      // consumed by the underlying llama-server). Forwarded via providerOptions.unsloth.
      if (providerType === PROVIDER_TYPE.unsloth) {
        providerOpts.enable_thinking = profile.showReasoning;
      }

      if (Object.keys(providerOpts).length > 0) {
        config.providerOptions = { [providerOptionsKey]: providerOpts };
      }
      break;
    }

    // -- Anthropic ------------------------------------------------------------
    case PROVIDER_TYPE.anthropic: {
      // Native topK (gated); no frequencyPenalty, presencePenalty, or seed
      if (can("topK") && profile.topK != null) config.topK = profile.topK;
      break;
    }

    // -- Google (classic + Interactions) -------------------------------------
    case PROVIDER_TYPE.google:
    case PROVIDER_TYPE.googleInteractions: {
      // Only temperature, topP, maxOutputTokens, stopSequences (already set above).
      // reasoningEffort -> thinking_level is mapped natively by the SDK.
      break;
    }

    // -- KoboldCpp -----------------------------------------------------------
    case PROVIDER_TYPE.koboldCpp: {
      // KoboldCPP uses its own native API — sampler params go through providerOptions.koboldcpp
      // and are spread into the request body by the adapter.
      const providerOpts: Record<string, JSONValue> = {};
      if (can("topK") && profile.topK != null) providerOpts.top_k = profile.topK;
      if (can("topP") && profile.topP != null) providerOpts.top_p = profile.topP;
      if (can("topA") && profile.topA != null) providerOpts.top_a = profile.topA;
      if (can("minP") && profile.minP != null) providerOpts.min_p = profile.minP;
      if (can("typicalP") && profile.typicalP != null) providerOpts.typical = profile.typicalP;
      if (can("tfsZ") && profile.tfsZ != null) providerOpts.tfs = profile.tfsZ;
      // adaptive-p (KoboldCPP native request fields; no chain needed).
      emitAdaptivePOptions(providerOpts, can, profile);
      if (can("repeatLastN") && profile.repeatLastN != null) providerOpts.rep_pen_range = profile.repeatLastN;
      if (can("repetitionPenalty") && profile.repetitionPenalty != null) providerOpts.rep_pen = profile.repetitionPenalty;
      if (can("dryMultiplier") && profile.dryMultiplier != null) providerOpts.dry_multiplier = profile.dryMultiplier;
      if (can("dryBase") && profile.dryBase != null) providerOpts.dry_base = profile.dryBase;
      if (can("dryAllowedLength") && profile.dryAllowedLength != null) providerOpts.dry_allowed_length = profile.dryAllowedLength;
      if (can("drySequenceBreakers") && profile.drySequenceBreakers?.length) providerOpts.dry_sequence_breakers = profile.drySequenceBreakers;
      if (can("xtcThreshold") && profile.xtcThreshold != null) providerOpts.xtc_threshold = profile.xtcThreshold;
      if (can("xtcProbability") && profile.xtcProbability != null) providerOpts.xtc_probability = profile.xtcProbability;
      if (can("mirostat") && profile.mirostat != null) providerOpts.mirostat = profile.mirostat;
      if (can("mirostatTau") && profile.mirostatTau != null) providerOpts.mirostat_tau = profile.mirostatTau;
      if (can("mirostatEta") && profile.mirostatEta != null) providerOpts.mirostat_eta = profile.mirostatEta;

      if (Object.keys(providerOpts).length > 0) {
        config.providerOptions = { koboldcpp: providerOpts };
      }
      break;
    }

    // -- Unknown / unsupported -----------------------------------------------
    default: {
      // Native params only (temperature, topP, maxOutputTokens, stopSequences)
      break;
    }
  }

  return config;
}
