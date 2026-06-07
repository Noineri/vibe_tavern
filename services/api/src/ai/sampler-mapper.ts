/**
 * Sampler mapper — routes sampler fields from StoredProviderProfileRecord
 * to either native AI SDK parameters or per-provider providerOptions namespaces.
 *
 * Both executors (nonstreaming, streaming) spread the returned SamplerConfig
 * into their generateText() / streamText() call.
 *
 * When `customSamplers` is false, only basic params (temperature, maxOutputTokens,
 * stopSequences, seed, reasoningEffort) are sent to the provider. All advanced
 * sampler fields (topP, topK, minP, topA, penalties) are skipped so the
 * provider uses its own defaults.
 */

import { PROVIDER_TYPE, normalizeProviderType, resolveLogitBiasSupport } from "@vibe-tavern/domain";
import type { StoredProviderProfileRecord } from "@vibe-tavern/domain";

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
  providerOptions?: Record<string, Record<string, number | string | boolean | number[] | null>>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Build the sampler config for a given provider profile.
 *
 * Returns an object that can be spread directly into generateText() / streamText().
 * Routes each sampler field to either native AI SDK params or providerOptions
 * based on the provider type.
 *
 * When `customSamplers` is false, advanced sampler params are omitted entirely,
 * letting the provider use its built-in defaults.
 */
export function buildSamplerConfig(
  profile: StoredProviderProfileRecord,
): SamplerConfig {
  // -- Always-sent params: temperature, maxOutputTokens, stopSequences --
  const config: SamplerConfig = {};

  if (profile.temperature != null) config.temperature = profile.temperature;
  if (profile.maxTokens != null && profile.maxTokens > 0) config.maxOutputTokens = profile.maxTokens;

  if (profile.stopSequences.length > 0) {
    config.stopSequences = profile.stopSequences;
  }

  // -- If custom samplers are disabled, skip all advanced params --
  if (!profile.customSamplers) {
    // Only pass seed (if set) even without custom samplers
    if (profile.seed != null) {
      const parsed = typeof profile.seed === "number"
        ? profile.seed
        : parseInt(String(profile.seed), 10);
      if (!isNaN(parsed)) config.seed = parsed;
    }
    return config;
  }

  // -- Custom samplers enabled: route advanced params per provider type --

  if (profile.topP != null) config.topP = profile.topP;

  const providerType = normalizeProviderType(profile.providerPreset);

  switch (providerType) {
    // -- OpenAI-compatible providers (openai_compat, ollama, llamacpp) --------
    case PROVIDER_TYPE.openaiCompat:
    case PROVIDER_TYPE.ollama:
    case PROVIDER_TYPE.llamaCpp: {
      // Native params
      if (profile.frequencyPenalty != null) config.frequencyPenalty = profile.frequencyPenalty;
      if (profile.presencePenalty != null) config.presencePenalty = profile.presencePenalty;
      if (profile.seed != null) {
        const parsed = typeof profile.seed === "number"
          ? profile.seed
          : parseInt(String(profile.seed), 10);
        if (!isNaN(parsed)) config.seed = parsed;
      }

      // providerOptions.<providerName> namespace — must match createOpenAICompatible({ name })
      const providerOptionsKey = providerType === PROVIDER_TYPE.openaiCompat ? "openai_compat"
        : providerType === PROVIDER_TYPE.ollama ? "ollama"
        : "llamacpp";
      const providerOpts: Record<string, number | string | boolean | number[] | null> = {};
      if (profile.topK != null) providerOpts.top_k = profile.topK;
      if (profile.minP != null) providerOpts.min_p = profile.minP;
      if (profile.repetitionPenalty != null) providerOpts.repetition_penalty = profile.repetitionPenalty;

      // Logit bias: map entries to Record<number, number>
      if (profile.logitBias?.length && resolveLogitBiasSupport(profile.providerPreset, profile.defaultModel, profile.endpoint).supported) {
        const currentModel = profile.defaultModel ?? "";
        const usableEntries = profile.logitBias.filter((entry) => currentModel.length > 0 && entry.model === currentModel);
        if (usableEntries.length > 0) {
          const biasMap: Record<string, number> = {};
          for (const entry of usableEntries) {
            biasMap[String(entry.tokenId)] = entry.bias;
          }
          (providerOpts as Record<string, unknown>).logit_bias = biasMap;
        }
      }

      // reasoningEffort only for openai_compat
      if (
        providerType === PROVIDER_TYPE.openaiCompat &&
        profile.reasoningEffort != null
      ) {
        providerOpts.reasoningEffort = profile.reasoningEffort;
      }

      if (Object.keys(providerOpts).length > 0) {
        config.providerOptions = { [providerOptionsKey]: providerOpts };
      }
      break;
    }

    // -- Anthropic ------------------------------------------------------------
    case PROVIDER_TYPE.anthropic: {
      // Native topK; no frequencyPenalty, presencePenalty, or seed
      if (profile.topK != null) config.topK = profile.topK;
      break;
    }

    // -- Google ---------------------------------------------------------------
    case PROVIDER_TYPE.google: {
      // Only temperature, topP, maxOutputTokens, stopSequences (already set above)
      break;
    }

    // -- KoboldCpp -----------------------------------------------------------
    case PROVIDER_TYPE.koboldCpp: {
      // KoboldCPP uses its own native API — sampler params go through providerOptions.koboldcpp
      // and are spread into the request body by the adapter.
      const providerOpts: Record<string, number | string | boolean | number[] | null> = {};
      if (profile.topK != null) providerOpts.top_k = profile.topK;
      if (profile.topP != null) providerOpts.top_p = profile.topP;
      if (profile.minP != null) providerOpts.min_p = profile.minP;
      if (profile.repetitionPenalty != null) providerOpts.rep_pen = profile.repetitionPenalty;
      if (profile.frequencyPenalty != null) providerOpts.rep_pen_range = Math.round(profile.frequencyPenalty * 100);

      if (Object.keys(providerOpts).length > 0) {
        config.providerOptions = { koboldcpp: providerOpts };
      }
      break;
    }

    // -- KoboldCpp (unsupported) and unknown ----------------------------------
    default: {
      // Native params only (temperature, topP, maxOutputTokens, stopSequences)
      break;
    }
  }

  return config;
}
