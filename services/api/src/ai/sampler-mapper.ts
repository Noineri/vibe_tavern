/**
 * Sampler mapper — routes sampler fields from StoredProviderProfileRecord
 * to either native AI SDK parameters or per-provider providerOptions namespaces.
 *
 * Both executors (nonstreaming, streaming) spread the returned SamplerConfig
 * into their generateText() / streamText() call.
 */

import { PROVIDER_TYPE } from "@rp-platform/domain";
import type { StoredProviderProfileRecord } from "@rp-platform/domain";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Config object spreadable into generateText() / streamText(). */
export interface SamplerConfig {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  topK?: number;
  providerOptions?: Record<string, Record<string, number | string | boolean | null>>;
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
 */
export function buildSamplerConfig(
  profile: StoredProviderProfileRecord,
): SamplerConfig {
  // -- Native params common to all providers --
  const config: SamplerConfig = {};

  if (profile.temperature != null) config.temperature = profile.temperature;
  if (profile.topP != null) config.topP = profile.topP;
  if (profile.maxTokens != null) config.maxTokens = profile.maxTokens;

  // stopSequences is already string[] — use directly
  if (profile.stopSequences.length > 0) {
    config.stopSequences = profile.stopSequences;
  }

  const providerType = profile.providerPreset;

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

      // providerOptions.openai namespace
      const openaiOptions: Record<string, number | string | boolean | null> = {};
      if (profile.topK != null) openaiOptions.top_k = profile.topK;
      if (profile.minP != null) openaiOptions.min_p = profile.minP;
      if (profile.repetitionPenalty != null) openaiOptions.repetition_penalty = profile.repetitionPenalty;

      // reasoningEffort only for openai_compat
      if (
        providerType === PROVIDER_TYPE.openaiCompat &&
        profile.reasoningEffort != null
      ) {
        openaiOptions.reasoning_effort = profile.reasoningEffort;
      }

      if (Object.keys(openaiOptions).length > 0) {
        config.providerOptions = { openai: openaiOptions };
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
      // Only temperature, topP, maxTokens, stopSequences (already set above)
      break;
    }

    // -- KoboldCpp (unsupported) and unknown ----------------------------------
    case PROVIDER_TYPE.koboldCpp:
    default: {
      // Native params only (temperature, topP, maxTokens, stopSequences)
      break;
    }
  }

  return config;
}
