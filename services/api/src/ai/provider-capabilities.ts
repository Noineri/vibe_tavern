/**
 * Conservative capability metadata for current provider kinds.
 *
 * These flags describe what the replacement execution boundary (FW-AI2)
 * can rely on for each provider type. Flags start as conservative/false
 * and are flipped to true only when verified or explicitly implemented.
 */

import { SAMPLER_SETS } from "@vibe-tavern/domain";
import type { ProviderType, SamplerCapabilityFlags } from "@vibe-tavern/domain";

export interface ProviderCapabilityFlags {
  /** Provider can produce a complete non-streamed reply. */
  nonStreamGeneration: boolean;
  /** Provider execution respects an AbortSignal for cancellation. */
  abortSignal: boolean;
  /** Provider supports SSE/streaming responses. */
  streaming: boolean;
  /** Provider supports prefill (prefixing assistant content). */
  prefill: boolean;
  /** Provider supports logit bias (token-level output control). */
  logitBias: boolean;
  /** Granular sampler controls supported by this provider type. */
  samplers: SamplerCapabilityFlags;
}

/** Capability map keyed by provider type. */
export type ProviderCapabilityMap = Record<ProviderType, ProviderCapabilityFlags>;

/**
 * Capability declarations for all current provider kinds.
 *
 * `openai_compat` is intentionally broad: in this app it covers aggregators and
 * non-OpenAI model-family providers, not only the real OpenAI Chat API. The
 * stricter OpenAI-only sampler surface is selected by preset-level
 * resolveSamplerCapabilities("openai", ...).
 */
export const PROVIDER_CAPABILITIES: ProviderCapabilityMap = {
  openai_compat: {
    nonStreamGeneration: true,
    abortSignal: true,
    streaming: true,
    prefill: true,
    logitBias: true,
    samplers: SAMPLER_SETS.openai_compat_minimal,
  },
  anthropic: {
    nonStreamGeneration: true,
    abortSignal: true,
    streaming: true,
    prefill: false,
    logitBias: false,
    samplers: SAMPLER_SETS.anthropic,
  },
  google: {
    nonStreamGeneration: true,
    abortSignal: true,
    streaming: true,
    prefill: false,
    logitBias: false,
    samplers: SAMPLER_SETS.minimal_reasoning,
  },
  ollama: {
    nonStreamGeneration: true,
    abortSignal: true,
    streaming: true,
    prefill: true,
    logitBias: true,
    samplers: SAMPLER_SETS.openai_local,
  },
  llamacpp: {
    nonStreamGeneration: true,
    abortSignal: true,
    streaming: true,
    prefill: true,
    logitBias: true,
    samplers: SAMPLER_SETS.openai_local,
  },
  koboldcpp: {
    nonStreamGeneration: true,
    abortSignal: true,
    streaming: true,
    prefill: false,
    logitBias: false,
    samplers: SAMPLER_SETS.koboldcpp_native,
  },
};

/** Look up capabilities for a given provider type. */
export function getProviderCapabilities(
  type: ProviderType,
): ProviderCapabilityFlags {
  return PROVIDER_CAPABILITIES[type];
}
