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
import type { ProviderType } from "@rp-platform/domain";
import { PROVIDER_TYPE } from "@rp-platform/domain";
import { providerError } from "../errors.js";
import {
  getProviderCapabilities,
  type ProviderCapabilityFlags,
} from "./provider-capabilities.js";

// ---------------------------------------------------------------------------
// SDK support classification
// ---------------------------------------------------------------------------

export type SdkSupportKind = "native" | "openai_fallback" | "unsupported";

export interface ProviderMappingResult {
  /** The resolved AI SDK language model. */
  model: LanguageModelV1;
  /** How this provider kind is supported by the SDK. */
  sdkSupport: SdkSupportKind;
  /** Capability flags for this provider kind. */
  capabilities: ProviderCapabilityFlags;
  /** Human-readable description of any limitations. */
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Preset ID → ProviderType normalisation
// ---------------------------------------------------------------------------

/**
 * Map preset IDs (e.g. "openai", "openrouter") to canonical ProviderType values.
 *
 * The DB stores whatever the frontend sends as `type`.  Older profiles may
 * store the preset *ID* ("openai") instead of the canonical type
 * ("openai_compat").  This table normalises both to a single ProviderType.
 */
const PRESET_TO_PROVIDER_TYPE: Record<string, ProviderType> = {
  // Canonical types — self-mapping (anthropic="anthropic", google="google", etc.)
  [PROVIDER_TYPE.openaiCompat]: PROVIDER_TYPE.openaiCompat,
  [PROVIDER_TYPE.anthropic]:    PROVIDER_TYPE.anthropic,
  [PROVIDER_TYPE.google]:       PROVIDER_TYPE.google,
  [PROVIDER_TYPE.ollama]:       PROVIDER_TYPE.ollama,
  [PROVIDER_TYPE.llamaCpp]:     PROVIDER_TYPE.llamaCpp,
  [PROVIDER_TYPE.koboldCpp]:    PROVIDER_TYPE.koboldCpp,
  // Preset IDs that differ from the canonical type
  openai:       PROVIDER_TYPE.openaiCompat,
  openrouter:   PROVIDER_TYPE.openaiCompat,
  deepseek:     PROVIDER_TYPE.openaiCompat,
  groq:         PROVIDER_TYPE.openaiCompat,
  xai:          PROVIDER_TYPE.openaiCompat,
  mistral:      PROVIDER_TYPE.openaiCompat,
  fireworks:    PROVIDER_TYPE.openaiCompat,
  perplexity:   PROVIDER_TYPE.openaiCompat,
  moonshot:     PROVIDER_TYPE.openaiCompat,
  ai21:         PROVIDER_TYPE.openaiCompat,
  nanogpt:      PROVIDER_TYPE.openaiCompat,
  chutes:       PROVIDER_TYPE.openaiCompat,
  electronhub:  PROVIDER_TYPE.openaiCompat,
  zai:          PROVIDER_TYPE.openaiCompat,
  siliconflow:  PROVIDER_TYPE.openaiCompat,
  togetherai:   PROVIDER_TYPE.openaiCompat,
  pollinations: PROVIDER_TYPE.openaiCompat,
  vllm:         PROVIDER_TYPE.openaiCompat,
  ooba:         PROVIDER_TYPE.openaiCompat,
  tabby:        PROVIDER_TYPE.openaiCompat,
  aphrodite:    PROVIDER_TYPE.openaiCompat,
};

/**
 * Normalise a raw profile type / preset ID into a canonical ProviderType.
 * Falls back to openai_compat for unknown values.
 */
export function normalizeProviderType(raw: string): ProviderType {
  return PRESET_TO_PROVIDER_TYPE[raw] ?? PROVIDER_TYPE.openaiCompat;
}

// ---------------------------------------------------------------------------
// Mapper implementation
// ---------------------------------------------------------------------------

/**
 * Resolve a stored provider profile + model name into an AI SDK LanguageModelV1.
 *
 * This is the single canonical mapping point. Every provider kind has an explicit
 * outcome — see SdkSupportKind documentation above.
 */
export function mapProfileToSdkModel(
  profile: { type: string; endpoint: string; apiKey: string | null },
  model: string,
): ProviderMappingResult {
  const providerType = normalizeProviderType(profile.type);
  const capabilities = getProviderCapabilities(providerType);

  switch (providerType) {
    // -- Native SDK support --------------------------------------------------
    case PROVIDER_TYPE.openaiCompat: {
      const endpoint = (profile.endpoint || "").replace(/\/+$/, "");
      const apiKey = profile.apiKey ?? "";
      const provider = createOpenAI({ apiKey: apiKey || "not-needed", baseURL: endpoint || undefined });
      return {
        model: provider(model),
        sdkSupport: "native",
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
        sdkSupport: "native",
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
        sdkSupport: "native",
        capabilities,
        limitations: [],
      };
    }

    // -- OpenAI-compatible fallback ------------------------------------------
    case PROVIDER_TYPE.ollama: {
      const endpoint = (profile.endpoint || "").replace(/\/+$/, "");
      const apiKey = profile.apiKey ?? "";
      const provider = createOpenAI({ apiKey: apiKey || "not-needed", baseURL: endpoint || undefined });
      return {
        model: provider(model),
        sdkSupport: "openai_fallback",
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
      const provider = createOpenAI({ apiKey: apiKey || "not-needed", baseURL: endpoint || undefined });
      return {
        model: provider(model),
        sdkSupport: "openai_fallback",
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
        { providerType: profile.type },
      );
    }

    default: {
      throw providerError(
        `Unknown provider type '${profile.type}'. ` +
        `Supported types: ${Object.values(PROVIDER_TYPE).join(", ")}.`,
        { providerType: profile.type },
      );
    }
  }
}

/**
 * Check whether a provider type has full native SDK support (not fallback).
 */
export function isNativeSdkProvider(type: ProviderType): boolean {
  const caps = getProviderCapabilities(type);
  return caps.sdkSupport === "native";
}

/**
 * Check whether a provider type is explicitly unsupported.
 */
export function isUnsupportedProvider(type: ProviderType): boolean {
  const caps = getProviderCapabilities(type);
  return caps.sdkSupport === "unsupported";
}
