/**
 * Provider profile mapper - maps stored provider profiles to AI SDK configuration.
 *
 * Each provider kind has exactly one outcome:
 * - **supported native**: has a dedicated AI SDK provider package (openai_compat, anthropic, google).
 * - **supported fallback**: uses OpenAI-compatible adapter (ollama, llamacpp).
 * - **unsupported**: throws a deterministic ProviderExecutionError (koboldcpp - lacks OpenAI-compat /v1/chat/completions).
 *
 * Limitations of fallback providers:
 * - Ollama: sampling parameters (top_k, typical_p, min_p, rep_pen, freq_pen, pres_pen)
 *   are not forwarded through the OpenAI-compatible adapter. They are silently dropped.
 * - LlamaCpp: same parameter limitations as Ollama. Also, model selection is limited
 *   to the single loaded model (no multi-model switching).
 * - KoboldCpp: unsupported - the /api/v1/generate endpoint is not OpenAI-compatible.
 *   Users must switch to a supported provider kind.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
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
  model: LanguageModel;
  /** Capability flags for this provider kind. */
  capabilities: ProviderCapabilityFlags;
  /** Human-readable description of any limitations. */
  limitations: string[];
}

export { normalizeProviderType };

function normalizeLocalOpenAiCompatibleBaseUrl(endpoint: string): string {
  const normalized = (endpoint || "").trim().replace(/\/+$/, "");
  if (!normalized) return "http://localhost:11434/v1";
  if (normalized.endsWith("/v1")) return normalized;
  if (normalized.endsWith("/api")) return `${normalized.slice(0, -"/api".length)}/v1`;
  return `${normalized}/v1`;
}

// ---------------------------------------------------------------------------
// Mapper implementation
// ---------------------------------------------------------------------------

/**
 * Resolve a stored provider profile + model name into an AI SDK LanguageModel.
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
      const provider = createOpenAICompatible({ name: "openai_compat", apiKey: apiKey || "not-needed", baseURL: endpoint || "https://api.openai.com/v1", fetch: createReasoningAwareFetch() });
      return {
        model: provider.chatModel(model),
        
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
      const endpoint = normalizeLocalOpenAiCompatibleBaseUrl(profile.endpoint);
      const apiKey = profile.apiKey ?? "";
      const provider = createOpenAICompatible({ name: "ollama", apiKey: apiKey || "not-needed", baseURL: endpoint, fetch: createReasoningAwareFetch() });
      return {
        model: provider.chatModel(model),

        capabilities,
        limitations: [
          "Uses Ollama's OpenAI-compatible /v1 endpoint for generation.",
          "Sampling parameters top_k, typical_p, min_p, rep_pen, freq_pen, pres_pen are not forwarded via OpenAI-compatible adapter.",
          "Model list uses Ollama's native /api/tags endpoint.",
        ],
      };
    }

    case PROVIDER_TYPE.llamaCpp: {
      const endpoint = normalizeLocalOpenAiCompatibleBaseUrl(profile.endpoint);
      const apiKey = profile.apiKey ?? "";
      const provider = createOpenAICompatible({ name: "llamacpp", apiKey: apiKey || "not-needed", baseURL: endpoint, fetch: createReasoningAwareFetch() });
      return {
        model: provider.chatModel(model),
        
        capabilities,
        limitations: [
          "Uses llama.cpp server's OpenAI-compatible /v1 endpoint for generation.",
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
