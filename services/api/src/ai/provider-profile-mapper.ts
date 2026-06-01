/**
 * Provider profile mapper — maps stored provider profiles to AI SDK configuration.
 *
 * Each provider kind has exactly one outcome:
 * - **supported native**: has a dedicated AI SDK provider package (openai_compat, anthropic, google).
 * - **supported fallback**: uses OpenAI-compatible adapter via createOpenAI (ollama, llamacpp).
 * - **unsupported**: throws a deterministic ProviderExecutionError (koboldcpp — lacks OpenAI-compat /v1/chat/completions).
 *
 * Limitations of fallback providers:
 * - Ollama: sampling parameters (top_k, typical_p, min_p, rep_pen, freq_pen, pres_pen)
 *   are not forwarded through the OpenAI-compatible adapter. They are silently dropped.
 * - LlamaCpp: same parameter limitations as Ollama. Also, model selection is limited
 *   to the single loaded model (no multi-model switching).
 * - KoboldCpp: unsupported — the /api/v1/generate endpoint is not OpenAI-compatible.
 *   Users must switch to a supported provider kind.
 */

import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModelV1 } from "ai";
import { PROVIDER_TYPE, normalizeProviderType } from "@vibe-tavern/domain";
import type { ProviderType } from "@vibe-tavern/domain";
import { providerError } from "../errors.js";
import {
  getProviderCapabilities,
  type ProviderCapabilityFlags,
} from "./provider-capabilities.js";
import { createReasoningAwareFetch } from "./openai-reasoning-fetch.js";

// ---------------------------------------------------------------------------
// SDK support classification
// ---------------------------------------------------------------------------

export interface ProviderMappingResult {
  /** The resolved AI SDK language model. */
  model: LanguageModelV1;
  /** Capability flags for this provider kind. */
  capabilities: ProviderCapabilityFlags;
  /** Human-readable description of any limitations. */
  limitations: string[];
}

export { normalizeProviderType };

// ---------------------------------------------------------------------------
// Mapper implementation
// ---------------------------------------------------------------------------

/**
 * Resolve a stored provider profile + model name into an AI SDK LanguageModelV1.
 *
 * This is the single canonical mapping point. Every provider kind has an explicit
 * outcome.
 */
export function mapProfileToSdkModel(
  profile: { providerPreset: string; endpoint: string; apiKey: string | null },
  model: string,
): ProviderMappingResult {
  const providerType = normalizeProviderType(profile.providerPreset);
  const capabilities = getProviderCapabilities(providerType);

  switch (providerType) {
    // -- Native SDK support --------------------------------------------------
    case PROVIDER_TYPE.openaiCompat: {
      const endpoint = (profile.endpoint || "").replace(/\/+$/, "");
      const apiKey = profile.apiKey ?? "";
      const provider = createOpenAI({ apiKey: apiKey || "not-needed", baseURL: endpoint || undefined, fetch: createReasoningAwareFetch() });
      return {
        model: provider(model),
        
        capabilities,
        limitations: [],
      };
    }

    case PROVIDER_TYPE.anthropic: {
      const endpoint = (profile.endpoint || "").replace(/\/+$/, "");
      const apiKey = profile.apiKey ?? "";
      const provider = createAnthropic({ apiKey: apiKey || "not-needed", baseURL: endpoint || undefined });
      return {
        model: provider(model),
        
        capabilities,
        limitations: [],
      };
    }

    case PROVIDER_TYPE.google: {
      const endpoint = (profile.endpoint || "").replace(/\/+$/, "");
      const apiKey = profile.apiKey ?? "";
      // Google SDK defaults to https://generativelanguage.googleapis.com/v1beta.
      // Only override baseURL if the user explicitly changed it (e.g. Vertex AI proxy).
      const defaultGoogleBase = "https://generativelanguage.googleapis.com";
      const googleBaseUrl = (!endpoint || endpoint === defaultGoogleBase) ? undefined : endpoint;
      const provider = createGoogleGenerativeAI({ apiKey: apiKey || "not-needed", baseURL: googleBaseUrl });
      return {
        model: provider(model),
        
        capabilities,
        limitations: [],
      };
    }

    // -- OpenAI-compatible fallback ------------------------------------------
    case PROVIDER_TYPE.ollama: {
      const endpoint = (profile.endpoint || "").replace(/\/+$/, "");
      const apiKey = profile.apiKey ?? "";
      const provider = createOpenAI({ apiKey: apiKey || "not-needed", baseURL: endpoint || undefined, fetch: createReasoningAwareFetch() });
      return {
        model: provider(model),
        
        capabilities,
        limitations: [
          "Sampling parameters top_k, typical_p, min_p, rep_pen, freq_pen, pres_pen are not forwarded via OpenAI-compatible adapter.",
          "Model list/probe uses Ollama's /api/tags endpoint, not the OpenAI /v1/models endpoint.",
        ],
      };
    }

    case PROVIDER_TYPE.llamaCpp: {
      const endpoint = (profile.endpoint || "").replace(/\/+$/, "");
      const apiKey = profile.apiKey ?? "";
      const provider = createOpenAI({ apiKey: apiKey || "not-needed", baseURL: endpoint || undefined, fetch: createReasoningAwareFetch() });
      return {
        model: provider(model),
        
        capabilities,
        limitations: [
          "Sampling parameters top_k, typical_p, min_p, rep_pen, freq_pen, pres_pen are not forwarded via OpenAI-compatible adapter.",
          "Model selection is limited to the single loaded model on the llama.cpp server.",
        ],
      };
    }

    // -- Explicitly unsupported ----------------------------------------------
    case PROVIDER_TYPE.koboldCpp: {
      throw providerError(
        `Provider type '${PROVIDER_TYPE.koboldCpp}' is not supported by the Vercel AI SDK. ` +
        `KoboldCPP's /api/v1/generate endpoint is not OpenAI-compatible. ` +
        `Please switch to a supported provider (OpenAI-compatible, Anthropic, Google, Ollama, or llama.cpp).`,
        { providerType: profile.providerPreset },
      );
    }

    default: {
      throw providerError(
        `Unknown provider type '${profile.providerPreset}'. ` +
        `Supported types: ${Object.values(PROVIDER_TYPE).join(", ")}.`,
        { providerType: profile.providerPreset },
      );
    }
  }
}

/**
 * Check whether a provider type is explicitly unsupported.
 */
export function isUnsupportedProvider(type: ProviderType): boolean {
  const caps = getProviderCapabilities(type);
  return !caps.nonStreamGeneration && !caps.streaming;
}
