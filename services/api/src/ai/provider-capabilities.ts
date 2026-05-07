/**
 * Conservative capability metadata for current provider kinds.
 *
 * These flags describe what the replacement execution boundary (FW-AI2)
 * can rely on for each provider type. Flags start as conservative/false
 * and are flipped to true only when verified or explicitly implemented.
 */

import type { ProviderType } from "@rp-platform/domain";
import type { SdkSupportKind } from "./provider-profile-mapper.js";

export type { SdkSupportKind };

export interface ProviderCapabilityFlags {
  /** Provider can produce a complete non-streamed reply. */
  nonStreamGeneration: boolean;
  /** Provider execution respects an AbortSignal for cancellation. */
  abortSignal: boolean;
  /** Provider supports SSE/streaming responses. */
  streaming: boolean;
  /** Provider supports prefill (prefixing assistant content). */
  prefill: boolean;
  /** How this provider kind maps to the AI SDK. */
  sdkSupport: SdkSupportKind;
}

/** Capability map keyed by provider type. */
export type ProviderCapabilityMap = Record<ProviderType, ProviderCapabilityFlags>;

/**
 * Conservative capability declarations for all current provider kinds.
 *
 * - nonStreamGeneration: all current providers already support this.
 * - abortSignal: all providers use fetch-based HTTP which supports AbortSignal.
 * - streaming: true — streaming executor (FW-AI2) uses streamText(); route collects in this brief, SSE forwarding in FW-AI5.
 * - prefill: deterministic per type — true for openai_compat/ollama/llamacpp, false for anthropic/google/koboldcpp.
 */
export const PROVIDER_CAPABILITIES: ProviderCapabilityMap = {
  openai_compat: {
    nonStreamGeneration: true,
    abortSignal: true,
    streaming: true,
    prefill: true,
    sdkSupport: "native",
  },
  anthropic: {
    nonStreamGeneration: true,
    abortSignal: true,
    streaming: true,
    prefill: false,
    sdkSupport: "native",
  },
  google: {
    nonStreamGeneration: true,
    abortSignal: true,
    streaming: true,
    prefill: false,
    sdkSupport: "native",
  },
  ollama: {
    nonStreamGeneration: true,
    abortSignal: true,
    streaming: true,
    prefill: true,
    sdkSupport: "openai_fallback",
  },
  llamacpp: {
    nonStreamGeneration: true,
    abortSignal: true,
    streaming: true,
    prefill: true,
    sdkSupport: "openai_fallback",
  },
  koboldcpp: {
    nonStreamGeneration: false,
    abortSignal: false,
    streaming: false,
    prefill: false,
    sdkSupport: "unsupported",
  },
};

/** Look up capabilities for a given provider type. */
export function getProviderCapabilities(
  type: ProviderType,
): ProviderCapabilityFlags {
  return PROVIDER_CAPABILITIES[type];
}
